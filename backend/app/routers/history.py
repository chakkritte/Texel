"""Project version snapshots (Phase 4).

Snapshots are plain ``.tar.gz`` archives built with the Python standard
library (no extra dependencies):

    manifest.json          project + file metadata
    docs/{file_id}.tex     text documents (documents.content)
    files/{file_id}        binary files

Maximum 20 versions are kept per project; the oldest snapshots are pruned
after a new one is created.
"""

import io
import json
import tarfile
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db import get_db
from app.deps import get_current_user, project_access
from app.models import Document, File, Folder, User, utcnow
from app.models_history import Version, VersionFile

router = APIRouter(tags=["history"])

MAX_VERSIONS_PER_PROJECT = 20


class VersionIn(BaseModel):
    label: str | None = Field(default=None, max_length=200)


class VersionOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    label: str | None
    kind: str
    created_by: uuid.UUID
    created_at: datetime
    file_count: int


class VersionFileOut(BaseModel):
    file_id: uuid.UUID
    name: str
    folder_id: uuid.UUID | None
    kind: str
    mime: str
    size: int
    archive_path: str


class VersionDetailOut(VersionOut):
    files: list[VersionFileOut]


# ---------------------------------------------------------------------------
# Pure snapshot helpers (unit tested without a database)
# ---------------------------------------------------------------------------


def write_snapshot(
    archive_path: Path,
    project_meta: dict[str, Any],
    files: list[dict[str, Any]],
    created_at: str | None = None,
) -> dict[str, Any]:
    """Write a snapshot archive and return its manifest.

    ``files`` entries are ``{file_id, name, folder_id, kind, mime, size}`` plus
    ``text`` for documents or ``data`` (bytes) for binary files.
    """
    archive_path = Path(archive_path)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    mtime = int(time.time())
    manifest_files: list[dict[str, Any]] = []

    with tarfile.open(archive_path, "w:gz") as tar:
        for file in files:
            file_id = str(file["file_id"])
            kind = file.get("kind", "doc")
            if kind == "doc":
                archive_path_name = f"docs/{file_id}.tex"
                payload = (file.get("text") or "").encode("utf-8")
            else:
                archive_path_name = f"files/{file_id}"
                payload = file.get("data") or b""

            info = tarfile.TarInfo(archive_path_name)
            info.size = len(payload)
            info.mtime = mtime
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(payload))

            folder_id = file.get("folder_id")
            manifest_files.append(
                {
                    "file_id": file_id,
                    "name": file.get("name", ""),
                    "folder_id": str(folder_id) if folder_id else None,
                    "kind": kind,
                    "mime": file.get("mime", "application/octet-stream"),
                    "size": len(payload),
                    "archive_path": archive_path_name,
                }
            )

        manifest = {
            "format": 1,
            "created_at": created_at or datetime.now().astimezone().isoformat(),
            "project": project_meta,
            "files": manifest_files,
        }
        raw = json.dumps(manifest, ensure_ascii=False, sort_keys=True).encode("utf-8")
        info = tarfile.TarInfo("manifest.json")
        info.size = len(raw)
        info.mtime = mtime
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(raw))

    return manifest


def read_snapshot(archive_path: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Read a snapshot archive, returning ``(manifest, {archive_path: bytes})``."""
    archive_path = Path(archive_path)
    with tarfile.open(archive_path, "r:gz") as tar:
        member = tar.extractfile("manifest.json")
        if member is None:
            raise ValueError("Snapshot is missing manifest.json")
        manifest = json.loads(member.read().decode("utf-8"))

        contents: dict[str, bytes] = {}
        for entry in manifest.get("files", []):
            archive_name = entry.get("archive_path")
            if not archive_name:
                continue
            handle = tar.extractfile(archive_name)
            contents[archive_name] = handle.read() if handle is not None else b""
    return manifest, contents


def prune_keep(versions: list[Version], keep: int = MAX_VERSIONS_PER_PROJECT) -> list[Version]:
    """Return the versions that fall outside the retention window.

    ``versions`` must be ordered newest first.
    """
    return versions[keep:]


# ---------------------------------------------------------------------------
# Helpers that touch the database
# ---------------------------------------------------------------------------


def _version_out(version: Version, file_count: int = 0) -> VersionOut:
    return VersionOut(
        id=version.id,
        project_id=version.project_id,
        label=version.label,
        kind=version.kind,
        created_by=version.created_by,
        created_at=version.created_at,
        file_count=file_count,
    )


async def _version_or_404(db: AsyncSession, version_id: uuid.UUID) -> Version:
    version = await db.get(Version, version_id)
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    return version


async def _prune_versions(db: AsyncSession, project_id: uuid.UUID) -> None:
    rows = list(
        (
            await db.execute(
                select(Version)
                .where(Version.project_id == project_id)
                .order_by(Version.created_at.desc())
            )
        ).scalars()
    )
    stale = prune_keep(rows)
    if not stale:
        return
    for version in stale:
        Path(version.snapshot_path).unlink(missing_ok=True)
        await db.delete(version)
    await db.commit()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/projects/{project_id}/versions",
    response_model=VersionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_version(
    project_id: uuid.UUID,
    body: VersionIn | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "editor")
    version_id = uuid.uuid4()

    rows = (
        await db.execute(
            select(File, Document)
            .outerjoin(Document, Document.file_id == File.id)
            .where(File.project_id == project_id)
            .order_by(File.name)
        )
    ).all()

    payload: list[dict[str, Any]] = []
    for file, doc in rows:
        item: dict[str, Any] = {
            "file_id": file.id,
            "name": file.name,
            "folder_id": file.folder_id,
            "kind": file.kind,
            "mime": file.mime,
            "size": file.size,
        }
        if file.kind == "doc":
            item["text"] = doc.content if doc is not None else ""
        else:
            data = b""
            if file.disk_path and Path(file.disk_path).exists():
                try:
                    data = Path(file.disk_path).read_bytes()
                except OSError:
                    data = b""
            item["data"] = data
        payload.append(item)

    archive = (
        Path(settings.data_dir) / "versions" / str(project_id) / f"{version_id}.tar.gz"
    )
    manifest = write_snapshot(
        archive,
        {
            "id": str(project.id),
            "name": project.name,
            "main_file": project.main_file,
            "engine": project.engine,
        },
        payload,
    )

    version = Version(
        id=version_id,
        project_id=project_id,
        label=(body.label.strip() if body and body.label else None),
        kind="manual",
        snapshot_path=str(archive),
        created_by=user.id,
    )
    db.add(version)
    for entry in manifest["files"]:
        db.add(
            VersionFile(
                version_id=version_id,
                file_id=uuid.UUID(entry["file_id"]),
                name=entry["name"],
                folder_id=uuid.UUID(entry["folder_id"]) if entry["folder_id"] else None,
                kind=entry["kind"],
                mime=entry["mime"],
                size=entry["size"],
                archive_path=entry["archive_path"],
            )
        )
    await db.commit()
    await db.refresh(version)
    await _prune_versions(db, project_id)
    return _version_out(version, len(manifest["files"]))


@router.get("/projects/{project_id}/versions", response_model=list[VersionOut])
async def list_versions(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user)
    file_count = (
        select(func.count(VersionFile.id))
        .where(VersionFile.version_id == Version.id)
        .correlate(Version)
        .scalar_subquery()
    )
    rows = (
        await db.execute(
            select(Version, file_count.label("file_count"))
            .where(Version.project_id == project_id)
            .order_by(Version.created_at.desc())
        )
    ).all()
    return [_version_out(version, count) for version, count in rows]


@router.get("/versions/{version_id}", response_model=VersionDetailOut)
async def get_version(
    version_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    version = await _version_or_404(db, version_id)
    await project_access(db, version.project_id, user)
    files = list(
        (
            await db.execute(
                select(VersionFile)
                .where(VersionFile.version_id == version.id)
                .order_by(VersionFile.name)
            )
        ).scalars()
    )
    return VersionDetailOut(
        **_version_out(version, len(files)).model_dump(),
        files=[
            VersionFileOut(
                file_id=f.file_id,
                name=f.name,
                folder_id=f.folder_id,
                kind=f.kind,
                mime=f.mime,
                size=f.size,
                archive_path=f.archive_path,
            )
            for f in files
        ],
    )


@router.post("/versions/{version_id}/restore")
async def restore_version(
    version_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    version = await _version_or_404(db, version_id)
    project = await project_access(db, version.project_id, user, "editor")

    archive = Path(version.snapshot_path)
    if not archive.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Snapshot file not found")
    try:
        manifest, contents = read_snapshot(archive)
    except (OSError, tarfile.TarError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Snapshot is corrupted: {exc}"
        )

    project_meta = manifest.get("project", {})
    if project_meta.get("id") and project_meta["id"] != str(project.id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Snapshot does not belong to project")

    valid_folders = set(
        (await db.execute(select(Folder.id).where(Folder.project_id == project.id))).scalars()
    )

    restored = 0
    for entry in manifest.get("files", []):
        try:
            file_id = uuid.UUID(entry["file_id"])
        except (KeyError, ValueError):
            continue

        file = await db.get(File, file_id)
        if file is not None and file.project_id != project.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Snapshot file id conflict")
        if file is None:
            file = File(id=file_id, project_id=project.id, name=entry.get("name", "file"))
            db.add(file)
            await db.flush()

        folder_id: uuid.UUID | None = None
        if entry.get("folder_id"):
            candidate = uuid.UUID(entry["folder_id"])
            if candidate in valid_folders:
                folder_id = candidate

        payload = contents.get(entry.get("archive_path", ""), b"")
        file.name = entry.get("name") or file.name
        file.folder_id = folder_id
        file.kind = entry.get("kind", "doc")
        file.mime = entry.get("mime", file.mime)
        file.size = len(payload)

        if file.kind == "doc":
            text = payload.decode("utf-8", errors="replace")
            doc = (
                await db.execute(select(Document).where(Document.file_id == file.id))
            ).scalar_one_or_none()
            if doc is None:
                db.add(Document(file_id=file.id, content=text, seq=1))
            else:
                doc.content = text
                doc.ydoc_state = None
                doc.seq += 1
        else:
            dest = (
                Path(settings.data_dir)
                / "projects"
                / str(project.id)
                / "files"
                / str(file.id)
            )
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(payload)
            file.disk_path = str(dest)

        restored += 1

    project.updated_at = utcnow()
    await db.commit()
    return {
        "restored": True,
        "version_id": str(version.id),
        "project_id": str(project.id),
        "restored_files": restored,
    }
