import io
import mimetypes
import shutil
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File as UploadFileField, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, PlainTextResponse, Response
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db import get_db
from app.deps import get_current_user, project_access
from app.models import (
    Document,
    File,
    Folder,
    Project,
    ProjectMember,
    ProjectTag,
    User,
    utcnow,
)
from app.schemas import (
    DocContentIn,
    DocContentOut,
    FileIn,
    FileOut,
    FilePatch,
    FolderIn,
    FolderOut,
    FolderPatch,
    ProjectCopyIn,
    ProjectIn,
    ProjectOut,
    ProjectPatch,
    ProjectTagIn,
    ProjectTagOut,
    ProjectTagPatch,
    TreeOut,
)

router = APIRouter(tags=["projects"])

STARTER_TEX = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled Project}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here.

\end{document}
"""


def safe_name(name: str) -> str:
    name = name.strip()
    if not name or name in {".", ".."} or "/" in name or "\\" in name or "\x00" in name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid file name")
    return name


async def _role_for(db: AsyncSession, project: Project, user: User) -> str:
    if project.owner_id == user.id:
        return "owner"
    member = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id, ProjectMember.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    return member.role if member else "viewer"


def _out(
    project: Project, role: str, tags: list[ProjectTag] | None = None
) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        main_file=project.main_file,
        engine=project.engine,
        ai_enabled=project.ai_enabled,
        role=role,
        created_at=project.created_at,
        updated_at=project.updated_at,
        deleted_at=project.deleted_at,
        archived_at=project.archived_at,
        tags=[ProjectTagOut.model_validate(tag) for tag in tags or ()],
    )


async def _tags_by_project(
    db: AsyncSession, project_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[ProjectTag]]:
    if not project_ids:
        return {}
    rows = (
        await db.execute(
            select(ProjectTag)
            .where(ProjectTag.project_id.in_(project_ids))
            .order_by(ProjectTag.created_at, ProjectTag.name)
        )
    ).scalars().all()
    tags: dict[uuid.UUID, list[ProjectTag]] = {}
    for tag in rows:
        tags.setdefault(tag.project_id, []).append(tag)
    return tags


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    member_ids = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    rows = (
        await db.execute(
            select(Project)
            .where(
                Project.deleted_at.is_(None),
                Project.archived_at.is_(None),
                or_(Project.owner_id == user.id, Project.id.in_(member_ids)),
            )
            .order_by(Project.updated_at.desc())
        )
    ).scalars().all()
    tag_map = await _tags_by_project(db, [project.id for project in rows])
    out = []
    for project in rows:
        out.append(
            _out(
                project,
                await _role_for(db, project, user),
                tag_map.get(project.id),
            )
        )
    return out


@router.get("/projects/trash", response_model=list[ProjectOut])
async def list_trashed_projects(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    rows = (
        await db.execute(
            select(Project)
            .where(
                Project.owner_id == user.id,
                Project.deleted_at.is_not(None),
            )
            .order_by(Project.deleted_at.desc())
        )
    ).scalars().all()
    tag_map = await _tags_by_project(db, [project.id for project in rows])
    return [_out(project, "owner", tag_map.get(project.id)) for project in rows]


@router.get("/projects/archived", response_model=list[ProjectOut])
async def list_archived_projects(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    member_ids = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    rows = (
        await db.execute(
            select(Project)
            .where(
                Project.deleted_at.is_(None),
                Project.archived_at.is_not(None),
                or_(Project.owner_id == user.id, Project.id.in_(member_ids)),
            )
            .order_by(Project.archived_at.desc())
        )
    ).scalars().all()
    tag_map = await _tags_by_project(db, [project.id for project in rows])
    out = []
    for project in rows:
        out.append(
            _out(project, await _role_for(db, project, user), tag_map.get(project.id))
        )
    return out


@router.post("/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = Project(owner_id=user.id, name=body.name, engine=body.engine)
    db.add(project)
    await db.flush()

    if body.create_main:
        main = File(
            project_id=project.id,
            name="main.tex",
            kind="doc",
            mime="text/x-tex",
            size=len(STARTER_TEX.encode("utf-8")),
        )
        db.add(main)
        await db.flush()
        db.add(Document(file_id=main.id, content=STARTER_TEX, seq=1))
    await db.commit()
    await db.refresh(project)
    return _out(project, "owner")


@router.get("/projects/{project_id}", response_model=ProjectOut)
async def get_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user)
    tag_map = await _tags_by_project(db, [project.id])
    return _out(project, await _role_for(db, project, user), tag_map.get(project.id))


@router.patch("/projects/{project_id}", response_model=ProjectOut)
async def patch_project(
    project_id: uuid.UUID,
    body: ProjectPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "editor")
    for field in ("name", "engine", "main_file", "ai_enabled"):
        value = getattr(body, field)
        if value is not None:
            setattr(project, field, value)
    await db.commit()
    await db.refresh(project)
    tag_map = await _tags_by_project(db, [project.id])
    return _out(project, await _role_for(db, project, user), tag_map.get(project.id))


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Move a project to Trash. Files stay on disk until permanently deleted."""
    project = await project_access(db, project_id, user, "owner")
    project.deleted_at = utcnow()
    project.archived_at = None
    await db.commit()


@router.post("/projects/{project_id}/restore", response_model=ProjectOut)
async def restore_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await db.get(Project, project_id)
    if project is None or project.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.deleted_at is not None:
        project.deleted_at = None
        await db.commit()
        await db.refresh(project)
    tag_map = await _tags_by_project(db, [project.id])
    return _out(project, "owner", tag_map.get(project.id))


@router.delete("/projects/{project_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
async def permanently_delete_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await db.get(Project, project_id)
    if project is None or project.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.deleted_at is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Move the project to Trash before deleting it permanently"
        )
    await db.delete(project)
    await db.commit()
    shutil.rmtree(Path(settings.data_dir) / "projects" / str(project_id), ignore_errors=True)
    shutil.rmtree(Path(settings.data_dir) / "compiles" / str(project_id), ignore_errors=True)
    shutil.rmtree(Path(settings.data_dir) / "versions" / str(project_id), ignore_errors=True)


@router.post("/projects/{project_id}/archive", response_model=ProjectOut)
async def archive_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "owner")
    if project.archived_at is None:
        project.archived_at = utcnow()
        await db.commit()
        await db.refresh(project)
    tag_map = await _tags_by_project(db, [project.id])
    return _out(project, "owner", tag_map.get(project.id))


@router.post("/projects/{project_id}/unarchive", response_model=ProjectOut)
async def unarchive_project(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "owner")
    if project.archived_at is not None:
        project.archived_at = None
        await db.commit()
        await db.refresh(project)
    tag_map = await _tags_by_project(db, [project.id])
    return _out(project, "owner", tag_map.get(project.id))


@router.post(
    "/projects/{project_id}/copy",
    response_model=ProjectOut,
    status_code=status.HTTP_201_CREATED,
)
async def copy_project(
    project_id: uuid.UUID,
    body: ProjectCopyIn | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await project_access(db, project_id, user)
    requested = body.name.strip() if body and body.name else ""
    name = (requested or f"{source.name} (copy)")[:200]

    project = Project(
        owner_id=user.id,
        name=name,
        engine=source.engine,
        main_file=source.main_file,
        ai_enabled=source.ai_enabled,
    )
    db.add(project)
    await db.flush()

    folders = (
        await db.execute(select(Folder).where(Folder.project_id == project_id))
    ).scalars().all()
    folder_map: dict[uuid.UUID, Folder] = {}
    for folder in folders:
        copy = Folder(project_id=project.id, parent_id=None, name=folder.name)
        db.add(copy)
        folder_map[folder.id] = copy
    await db.flush()
    for folder in folders:
        if folder.parent_id in folder_map:
            folder_map[folder.id].parent_id = folder_map[folder.parent_id].id

    files = (
        await db.execute(select(File).where(File.project_id == project_id))
    ).scalars().all()
    documents = {}
    if files:
        documents = {
            doc.file_id: doc
            for doc in (
                await db.execute(
                    select(Document).where(
                        Document.file_id.in_([file.id for file in files])
                    )
                )
            ).scalars().all()
        }
    dest_root = Path(settings.data_dir) / "projects" / str(project.id) / "files"
    for file in files:
        copy = File(
            project_id=project.id,
            folder_id=folder_map[file.folder_id].id if file.folder_id in folder_map else None,
            name=file.name,
            kind=file.kind,
            mime=file.mime,
            size=file.size,
        )
        db.add(copy)
        await db.flush()
        if file.kind == "doc":
            original = documents.get(file.id)
            db.add(
                Document(
                    file_id=copy.id,
                    content=original.content if original is not None else "",
                    seq=1,
                )
            )
        elif file.disk_path and Path(file.disk_path).exists():
            dest_root.mkdir(parents=True, exist_ok=True)
            dest = dest_root / str(copy.id)
            shutil.copyfile(file.disk_path, dest)
            copy.disk_path = str(dest)

    tags = (
        await db.execute(select(ProjectTag).where(ProjectTag.project_id == project_id))
    ).scalars().all()
    for tag in tags:
        db.add(ProjectTag(project_id=project.id, name=tag.name, color=tag.color))

    await db.commit()
    await db.refresh(project)
    tag_map = await _tags_by_project(db, [project.id])
    return _out(project, "owner", tag_map.get(project.id))


@router.post(
    "/projects/{project_id}/tags",
    response_model=ProjectTagOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_project_tag(
    project_id: uuid.UUID,
    body: ProjectTagIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user, "owner")
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tag name is required")
    existing = (
        await db.execute(
            select(ProjectTag).where(
                ProjectTag.project_id == project_id, ProjectTag.name == name
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Tag already exists")
    tag = ProjectTag(project_id=project_id, name=name, color=body.color.lower())
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag


@router.patch("/tags/{tag_id}", response_model=ProjectTagOut)
async def update_project_tag(
    tag_id: uuid.UUID,
    body: ProjectTagPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tag = await db.get(ProjectTag, tag_id)
    if tag is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tag not found")
    await project_access(db, tag.project_id, user, "owner")
    fields = body.model_fields_set
    if "name" in fields and body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tag name is required")
        if name != tag.name:
            duplicate = (
                await db.execute(
                    select(ProjectTag).where(
                        ProjectTag.project_id == tag.project_id,
                        ProjectTag.name == name,
                    )
                )
            ).scalar_one_or_none()
            if duplicate is not None:
                raise HTTPException(status.HTTP_409_CONFLICT, "Tag already exists")
            tag.name = name
    if "color" in fields and body.color is not None:
        tag.color = body.color.lower()
    await db.commit()
    await db.refresh(tag)
    return tag


@router.delete("/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_tag(
    tag_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tag = await db.get(ProjectTag, tag_id)
    if tag is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tag not found")
    await project_access(db, tag.project_id, user, "owner")
    await db.delete(tag)
    await db.commit()


@router.get("/projects/{project_id}/tree", response_model=TreeOut)
async def get_tree(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user)
    folders = (
        await db.execute(select(Folder).where(Folder.project_id == project_id).order_by(Folder.name))
    ).scalars()
    files = (
        await db.execute(select(File).where(File.project_id == project_id).order_by(File.name))
    ).scalars()
    return TreeOut(
        folders=[FolderOut.model_validate(f) for f in folders],
        files=[FileOut.model_validate(f) for f in files],
    )


@router.post("/projects/{project_id}/folders", response_model=FolderOut, status_code=201)
async def create_folder(
    project_id: uuid.UUID,
    body: FolderIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user, "editor")
    if body.parent_id is not None:
        parent = await db.get(Folder, body.parent_id)
        if parent is None or parent.project_id != project_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid parent folder")
    folder = Folder(project_id=project_id, parent_id=body.parent_id, name=safe_name(body.name))
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return FolderOut.model_validate(folder)


@router.post("/projects/{project_id}/files", response_model=FileOut, status_code=201)
async def create_file(
    project_id: uuid.UUID,
    body: FileIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user, "editor")
    if body.folder_id is not None:
        folder = await db.get(Folder, body.folder_id)
        if folder is None or folder.project_id != project_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid folder")

    name = safe_name(body.name)
    file = File(
        project_id=project_id,
        folder_id=body.folder_id,
        name=name,
        kind=body.kind,
        mime="text/x-tex" if name.endswith(".tex") else "text/plain",
        size=len(body.content.encode("utf-8")),
    )
    db.add(file)
    await db.flush()
    if body.kind == "doc":
        db.add(Document(file_id=file.id, content=body.content, seq=1))
    await db.commit()
    await db.refresh(file)
    return FileOut.model_validate(file)


@router.post("/projects/{project_id}/upload", response_model=FileOut, status_code=201)
async def upload_file(
    project_id: uuid.UUID,
    upload: UploadFile = UploadFileField(...),
    folder_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user, "editor")
    if folder_id is not None:
        folder = await db.get(Folder, folder_id)
        if folder is None or folder.project_id != project_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid folder")

    name = safe_name(upload.filename or "upload.bin")
    ext = Path(name).suffix.lower()
    content_type = upload.content_type or "application/octet-stream"
    is_text = ext in TEXT_EXT or content_type.startswith("text/")

    if is_text:
        raw = await upload.read()
        if len(raw) > 5 * 1024 * 1024:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Text file too large (max 5 MB)"
            )
        text = raw.decode("utf-8", errors="replace").replace("\x00", "")
        file = File(
            project_id=project_id,
            folder_id=folder_id,
            name=name,
            kind="doc",
            mime="text/plain" if content_type == "application/octet-stream" else content_type,
            size=len(raw),
        )
        db.add(file)
        await db.flush()
        db.add(Document(file_id=file.id, content=text, seq=1))
        await db.commit()
        await db.refresh(file)
        return FileOut.model_validate(file)

    file = File(
        project_id=project_id,
        folder_id=folder_id,
        name=name,
        kind="binary",
        mime=content_type,
    )
    db.add(file)
    await db.flush()

    dest_dir = Path(settings.data_dir) / "projects" / str(project_id) / "files"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / str(file.id)
    size = 0
    with dest.open("wb") as out:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            out.write(chunk)
    file.disk_path = str(dest)
    file.size = size
    await db.commit()
    await db.refresh(file)
    return FileOut.model_validate(file)


@router.get("/files/{file_id}/content", response_model=DocContentOut)
async def get_content(
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    await project_access(db, file.project_id, user)
    doc = (
        await db.execute(select(Document).where(Document.file_id == file_id))
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a text document")
    return DocContentOut(content=doc.content, seq=doc.seq)


@router.put("/files/{file_id}/content", response_model=DocContentOut)
async def put_content(
    file_id: uuid.UUID,
    body: DocContentIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    await project_access(db, file.project_id, user, "editor")
    doc = (
        await db.execute(select(Document).where(Document.file_id == file_id))
    ).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not a text document")
    content = body.content.replace("\x00", "")
    doc.content = content
    doc.seq += 1
    file.size = len(content.encode("utf-8"))
    project = await db.get(Project, file.project_id)
    if project is not None:
        project.updated_at = project.updated_at
    await db.commit()
    return DocContentOut(content=doc.content, seq=doc.seq)


@router.get("/files/{file_id}/download")
async def download_file(
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    await project_access(db, file.project_id, user)
    if file.kind == "doc":
        doc = (
            await db.execute(select(Document).where(Document.file_id == file.id))
        ).scalar_one_or_none()
        return PlainTextResponse(
            doc.content if doc else "",
            media_type=file.mime or "text/plain",
            headers={"Content-Disposition": f'inline; filename="{file.name}"'},
        )
    if not file.disk_path or not Path(file.disk_path).exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File data not found")
    return FileResponse(file.disk_path, media_type=file.mime, filename=file.name)


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    await project_access(db, file.project_id, user, "editor")
    if file.disk_path:
        Path(file.disk_path).unlink(missing_ok=True)
    await db.delete(file)
    await db.commit()


async def _folder_descendants(
    db: AsyncSession, project_id: uuid.UUID, root_id: uuid.UUID
) -> set[uuid.UUID]:
    rows = (
        await db.execute(select(Folder).where(Folder.project_id == project_id))
    ).scalars().all()
    children: dict[uuid.UUID | None, list[uuid.UUID]] = {}
    for folder in rows:
        children.setdefault(folder.parent_id, []).append(folder.id)
    found: set[uuid.UUID] = set()
    stack = [root_id]
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            if child not in found:
                found.add(child)
                stack.append(child)
    return found


@router.patch("/files/{file_id}", response_model=FileOut)
async def patch_file(
    file_id: uuid.UUID,
    body: FilePatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    await project_access(db, file.project_id, user, "editor")
    fields = body.model_fields_set
    old_name = file.name
    old_folder_id = file.folder_id
    project = await db.get(Project, file.project_id)
    folders = (
        await db.execute(select(Folder).where(Folder.project_id == file.project_id))
    ).scalars().all()
    folder_map = _folder_map(list(folders))

    def rel_path(folder_id: uuid.UUID | None, name: str) -> str:
        folder_path = folder_map.get(folder_id, "") if folder_id else ""
        return f"{folder_path}/{name}" if folder_path else name

    if "folder_id" in fields:
        if body.folder_id is not None:
            folder = await db.get(Folder, body.folder_id)
            if folder is None or folder.project_id != file.project_id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid folder")
        file.folder_id = body.folder_id
    if "name" in fields and body.name:
        new_name = safe_name(body.name)
        duplicate = (
            await db.execute(
                select(File).where(
                    File.project_id == file.project_id,
                    File.folder_id == file.folder_id,
                    File.name == new_name,
                    File.id != file.id,
                )
            )
        ).scalar_one_or_none()
        if duplicate is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "A file with that name already exists in this folder",
            )
        file.name = new_name
    if project is not None:
        old_path = rel_path(old_folder_id, old_name)
        new_path = rel_path(file.folder_id, file.name)
        if project.main_file in {old_path, old_name}:
            project.main_file = new_path
    await db.commit()
    await db.refresh(file)
    return FileOut.model_validate(file)


@router.patch("/folders/{folder_id}", response_model=FolderOut)
async def patch_folder(
    folder_id: uuid.UUID,
    body: FolderPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    folder = await db.get(Folder, folder_id)
    if folder is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Folder not found")
    await project_access(db, folder.project_id, user, "editor")
    fields = body.model_fields_set
    if "name" in fields and body.name:
        folder.name = safe_name(body.name)[:200]
    if "parent_id" in fields:
        if body.parent_id is not None:
            if body.parent_id == folder.id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot move a folder into itself")
            parent = await db.get(Folder, body.parent_id)
            if parent is None or parent.project_id != folder.project_id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid parent folder")
            descendants = await _folder_descendants(db, folder.project_id, folder.id)
            if body.parent_id in descendants:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "Cannot move a folder into its own descendant"
                )
        folder.parent_id = body.parent_id
    await db.commit()
    await db.refresh(folder)
    return FolderOut.model_validate(folder)


TEXT_EXT = {
    ".tex", ".ltx", ".bib", ".sty", ".cls", ".txt", ".md", ".csv", ".json",
    ".yaml", ".yml", ".bst", ".cfg", ".def", ".clo", ".fd", ".dtx", ".ins",
}


def _folder_map(folders: list[Folder]) -> dict[uuid.UUID, str]:
    by_id = {f.id: f for f in folders}
    cache: dict[uuid.UUID, str] = {}

    def resolve(fid: uuid.UUID | None) -> str:
        if not fid:
            return ""
        if fid in cache:
            return cache[fid]
        folder = by_id.get(fid)
        if folder is None:
            return ""
        parent = resolve(folder.parent_id)
        path = f"{parent}/{folder.name}" if parent else folder.name
        cache[fid] = path
        return path

    for fid in by_id:
        resolve(fid)
    return cache


@router.post("/projects/{project_id}/import-zip", response_model=TreeOut)
async def import_zip(
    project_id: uuid.UUID,
    upload: UploadFile = UploadFileField(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "editor")
    raw = await upload.read()
    if len(raw) > 100 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Zip too large (max 100 MB)")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid zip file")

    entries: list[tuple[list[str], bytes]] = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        parts = [p for p in info.filename.replace("\\", "/").split("/") if p not in ("", ".")]
        if not parts or any(p == ".." for p in parts):
            continue
        entries.append((parts, zf.read(info)))
    if not entries:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zip contains no files")

    # Strip a single common top-level folder (common when zipping a project dir).
    first = {parts[0] for parts, _ in entries}
    if len(first) == 1 and all(len(parts) > 1 for parts, _ in entries):
        entries = [(parts[1:], data) for parts, data in entries]

    tex_names = [parts for parts, _ in entries if parts[-1].lower().endswith((".tex", ".ltx"))]
    if not tex_names:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zip does not contain a .tex file")

    dest_root = Path(settings.data_dir) / "projects" / str(project_id) / "files"

    # Importing a zip replaces the whole project: drop every existing file and
    # folder, including the starter main.tex created with the project, so no
    # old content (or blank main.tex) lingers after the import. Documents,
    # comments and other rows referencing the files are removed by the DB
    # cascade.
    existing = (
        await db.execute(select(File).where(File.project_id == project_id))
    ).scalars().all()
    for f in existing:
        if f.disk_path:
            Path(f.disk_path).unlink(missing_ok=True)
    await db.execute(delete(File).where(File.project_id == project_id))
    await db.execute(delete(Folder).where(Folder.project_id == project_id))
    await db.flush()

    shutil.rmtree(dest_root, ignore_errors=True)
    dest_root.mkdir(parents=True, exist_ok=True)

    path_to_id: dict[str, uuid.UUID] = {}
    file_index: dict[str, File] = {}

    for parts, data in entries:
        folder_id = None
        acc = ""
        for part in parts[:-1]:
            acc = f"{acc}/{part}" if acc else part
            fid = path_to_id.get(acc)
            if fid is None:
                folder = Folder(project_id=project_id, parent_id=folder_id, name=part[:200])
                db.add(folder)
                await db.flush()
                fid = folder.id
                path_to_id[acc] = fid
            folder_id = fid

        fname = parts[-1][:300]
        rel = "/".join(parts)
        ext = Path(fname).suffix.lower()
        previous = file_index.get(rel)

        if ext in TEXT_EXT:
            text = data.decode("utf-8", errors="replace").replace("\x00", "")
            if previous is not None and previous.kind == "doc":
                file = previous
                file.size = len(text.encode("utf-8"))
                file.mime = mimetypes.guess_type(fname)[0] or "text/plain"
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
                file = File(
                    project_id=project_id,
                    folder_id=folder_id,
                    name=fname,
                    kind="doc",
                    mime=mimetypes.guess_type(fname)[0] or "text/plain",
                    size=len(text.encode("utf-8")),
                )
                db.add(file)
                await db.flush()
                db.add(Document(file_id=file.id, content=text, seq=1))
                file_index[rel] = file
        else:
            if previous is not None and previous.kind == "binary":
                file = previous
            else:
                file = File(
                    project_id=project_id,
                    folder_id=folder_id,
                    name=fname,
                    kind="binary",
                    mime=mimetypes.guess_type(fname)[0] or "application/octet-stream",
                )
                db.add(file)
                await db.flush()
                file_index[rel] = file
            dest = dest_root / str(file.id)
            dest.write_bytes(data)
            file.disk_path = str(dest)
            file.size = len(data)

    imported_tex = [
        "/".join(parts)
        for parts, _ in entries
        if parts[-1].lower().endswith((".tex", ".ltx"))
    ]

    def _pick_main() -> str:
        for candidate in ("main.tex", "manuscript.tex"):
            if candidate in imported_tex:
                return candidate
        for candidate in imported_tex:
            if candidate.rsplit("/", 1)[-1].lower() == "main.tex":
                return candidate
        for candidate in imported_tex:
            if candidate.rsplit("/", 1)[-1].lower().startswith("manuscript"):
                return candidate
        return sorted(imported_tex, key=lambda p: (p.count("/"), p))[0]

    project.main_file = _pick_main()

    await db.commit()
    return await get_tree(project_id, user, db)


@router.get("/projects/{project_id}/export-zip")
async def export_zip(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user)
    folders = (
        await db.execute(select(Folder).where(Folder.project_id == project_id))
    ).scalars().all()
    files = (
        await db.execute(select(File).where(File.project_id == project_id))
    ).scalars().all()
    fmap = _folder_map(list(folders))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in files:
            rel = fmap.get(file.folder_id, "")
            arc = f"{rel}/{file.name}" if rel else file.name
            if file.kind == "doc":
                doc = (
                    await db.execute(select(Document).where(Document.file_id == file.id))
                ).scalar_one_or_none()
                zf.writestr(arc, doc.content if doc else "")
            elif file.disk_path and Path(file.disk_path).exists():
                zf.write(file.disk_path, arc)

    safe = "".join(c for c in project.name if c.isalnum() or c in " -_").strip() or "project"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
    )
