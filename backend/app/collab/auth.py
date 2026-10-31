"""Authentication / authorisation for the standalone collab app.

This deliberately queries the database directly (reusing ``SessionLocal`` and
the Phase 1 models) instead of importing FastAPI dependencies from ``deps.py``.
That keeps ``app.collab`` decoupled from the main API app, which is allowed to
evolve independently.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.collab.manager import DocSnapshot
from app.db import SessionLocal
from app.models import Document, File, Project, ProjectMember
from app.security import decode_access_token

ROLE_LEVEL = {"viewer": 1, "commenter": 2, "editor": 3, "owner": 4}


def extract_token(authorization: str | None, token_query: str | None = None) -> str:
    if token_query:
        return token_query
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            return value.strip()
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")


def decode_user_id(token: str) -> uuid.UUID:
    try:
        payload = decode_access_token(token)
        if payload.get("type") not in (None, "access"):
            raise ValueError("wrong token type")
        return uuid.UUID(payload["sub"])
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")


async def resolve_doc_access(
    doc_id: uuid.UUID,
    *,
    authorization: str | None = None,
    token_query: str | None = None,
    min_role: str = "viewer",
) -> DocSnapshot:
    """Resolve a path ``doc_id`` to a document and verify project access.

    ``doc_id`` may be either ``documents.id`` or ``files.id`` (the Phase 1
    editor naturally has the file id).  ``documents.id`` wins if both exist.
    """

    token = extract_token(authorization, token_query)
    user_id = decode_user_id(token)

    async with SessionLocal() as db:
        doc = await db.get(Document, doc_id)
        if doc is not None:
            file = await db.get(File, doc.file_id)
        else:
            file = await db.get(File, doc_id)
            if file is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
            doc = (
                await db.execute(select(Document).where(Document.file_id == file.id))
            ).scalar_one_or_none()
            if doc is None:
                if file.kind != "doc":
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a text document")
                doc = Document(file_id=file.id, content="", seq=0)
                db.add(doc)
                try:
                    await db.commit()
                    await db.refresh(doc)
                except IntegrityError:
                    # Another request created it concurrently.
                    await db.rollback()
                    doc = (
                        await db.execute(
                            select(Document).where(Document.file_id == file.id)
                        )
                    ).scalar_one()

        if file is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
        if file.kind != "doc":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a text document")

        project = await db.get(Project, file.project_id)
        if project is None or project.deleted_at is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")

        if project.owner_id == user_id:
            role = "owner"
        else:
            member = (
                await db.execute(
                    select(ProjectMember).where(
                        ProjectMember.project_id == project.id,
                        ProjectMember.user_id == user_id,
                    )
                )
            ).scalar_one_or_none()
            if member is None:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a project member")
            role = member.role

        if ROLE_LEVEL.get(role, 0) < ROLE_LEVEL.get(min_role, 1):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient project role")

        return DocSnapshot(
            document_id=doc.id,
            file_id=file.id,
            project_id=project.id,
            role=role,
            content=doc.content or "",
            ydoc_state=doc.ydoc_state,
            seq=int(doc.seq or 0),
            user_id=user_id,
        )
