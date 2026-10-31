"""Share links (Phase 4).

A share token is a 32-byte URL-safe secret. Only its SHA-256 hex digest is
persisted, so the raw token is shown exactly once (at creation time). The
``/share/{token}/...`` endpoints are intentionally unauthenticated and
read-only; they validate the token directly instead of going through
``app.deps``.
"""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db import get_db
from app.deps import get_current_user, project_access
from app.models import CompileJob, Document, File, Folder, Project, User, utcnow
from app.models_history import ShareLink

router = APIRouter(tags=["share"])

SHARE_TOKEN_BYTES = 32


class ShareLinkIn(BaseModel):
    role: Literal["viewer", "editor"] = "viewer"
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class ShareLinkOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    role: str
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class ShareLinkCreatedOut(ShareLinkOut):
    token: str
    url: str


class SharedProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    main_file: str
    engine: str
    role: str
    created_at: datetime
    updated_at: datetime


class SharedFolderOut(BaseModel):
    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None


class SharedFileOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    mime: str
    size: int
    folder_id: uuid.UUID | None


class SharedTreeOut(BaseModel):
    folders: list[SharedFolderOut]
    files: list[SharedFileOut]


class SharedDocOut(BaseModel):
    content: str
    seq: int


# ---------------------------------------------------------------------------
# Pure token helpers (unit tested without a database)
# ---------------------------------------------------------------------------


def new_share_token() -> str:
    """Return a fresh 32-byte URL-safe token (43 characters)."""
    return secrets.token_urlsafe(SHARE_TOKEN_BYTES)


def hash_share_token(token: str) -> str:
    """SHA-256 hex digest stored in ``share_links.token_hash``."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def is_share_link_active(
    revoked_at: datetime | None,
    expires_at: datetime | None,
    now: datetime | None = None,
) -> bool:
    now = now or datetime.now(timezone.utc)
    if revoked_at is not None:
        return False
    if expires_at is not None and expires_at <= now:
        return False
    return True


# ---------------------------------------------------------------------------
# Authenticated management endpoints
# ---------------------------------------------------------------------------


def _out(link: ShareLink) -> ShareLinkOut:
    return ShareLinkOut(
        id=link.id,
        project_id=link.project_id,
        role=link.role,
        expires_at=link.expires_at,
        revoked_at=link.revoked_at,
        created_at=link.created_at,
    )


@router.post(
    "/projects/{project_id}/share-links",
    response_model=ShareLinkCreatedOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_share_link(
    project_id: uuid.UUID,
    body: ShareLinkIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user, "editor")

    token = new_share_token()
    expires_at = (
        utcnow() + timedelta(days=body.expires_in_days) if body.expires_in_days else None
    )
    link = ShareLink(
        project_id=project_id,
        created_by=user.id,
        token_hash=hash_share_token(token),
        role=body.role,
        expires_at=expires_at,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)
    return ShareLinkCreatedOut(
        **_out(link).model_dump(),
        token=token,
        url=f"{settings.root_path}/share/{token}",
    )


@router.get("/projects/{project_id}/share-links", response_model=list[ShareLinkOut])
async def list_share_links(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user, "editor")
    links = (
        await db.execute(
            select(ShareLink)
            .where(ShareLink.project_id == project_id)
            .order_by(ShareLink.created_at.desc())
        )
    ).scalars()
    return [_out(link) for link in links]


@router.delete("/share-links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_share_link(
    link_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    link = await db.get(ShareLink, link_id)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Share link not found")
    await project_access(db, link.project_id, user, "editor")
    await db.delete(link)
    await db.commit()


# ---------------------------------------------------------------------------
# Public, read-only endpoints (token is the credential)
# ---------------------------------------------------------------------------


async def _active_link(db: AsyncSession, token: str) -> ShareLink:
    link = (
        await db.execute(select(ShareLink).where(ShareLink.token_hash == hash_share_token(token)))
    ).scalar_one_or_none()
    if link is None or not is_share_link_active(link.revoked_at, link.expires_at):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Share link is invalid or expired")
    if link.role not in {"viewer", "editor"}:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Share link has no read access")
    return link


async def _shared_project(db: AsyncSession, token: str) -> tuple[ShareLink, Project]:
    link = await _active_link(db, token)
    project = await db.get(Project, link.project_id)
    if project is None or project.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return link, project


@router.get("/share/{token}", response_model=SharedProjectOut)
async def shared_project(token: str, db: AsyncSession = Depends(get_db)):
    link, project = await _shared_project(db, token)
    return SharedProjectOut(
        id=project.id,
        name=project.name,
        main_file=project.main_file,
        engine=project.engine,
        role=link.role,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.get("/share/{token}/tree", response_model=SharedTreeOut)
async def shared_tree(token: str, db: AsyncSession = Depends(get_db)):
    _, project = await _shared_project(db, token)
    folders = (
        await db.execute(select(Folder).where(Folder.project_id == project.id).order_by(Folder.name))
    ).scalars()
    files = (
        await db.execute(select(File).where(File.project_id == project.id).order_by(File.name))
    ).scalars()
    return SharedTreeOut(
        folders=[
            SharedFolderOut(id=f.id, name=f.name, parent_id=f.parent_id) for f in folders
        ],
        files=[
            SharedFileOut(
                id=f.id,
                name=f.name,
                kind=f.kind,
                mime=f.mime,
                size=f.size,
                folder_id=f.folder_id,
            )
            for f in files
        ],
    )


@router.get("/share/{token}/files/{file_id}/content", response_model=SharedDocOut)
async def shared_file_content(
    token: str, file_id: uuid.UUID, db: AsyncSession = Depends(get_db)
):
    _, project = await _shared_project(db, token)
    file = await db.get(File, file_id)
    if file is None or file.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    doc = (
        await db.execute(select(Document).where(Document.file_id == file.id))
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a text document")
    return SharedDocOut(content=doc.content, seq=doc.seq)


@router.get("/share/{token}/compile/{job_id}/pdf")
async def shared_compile_pdf(
    token: str, job_id: uuid.UUID, db: AsyncSession = Depends(get_db)
):
    _, project = await _shared_project(db, token)
    job = await db.get(CompileJob, job_id)
    if job is None or job.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Compile job not found")
    if job.status != "success" or not job.pdf_path or not Path(job.pdf_path).exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF not available")
    return FileResponse(job.pdf_path, media_type="application/pdf", filename="output.pdf")
