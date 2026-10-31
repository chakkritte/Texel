"""Administrator endpoints: user management and custom project templates."""

from __future__ import annotations

import base64
import io
import json
import mimetypes
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import (
    APIRouter,
    Depends,
    File as UploadFileField,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_admin
from app.models import Project, RefreshToken, User, utcnow
from app.models_history import Template
from app.routers.projects import TEXT_EXT
from app.routers.templates import (
    BINARY_TEMPLATE_EXTENSIONS,
    BUILTIN_IDS,
    BUILTIN_TEMPLATES,
    MAX_TEMPLATE_BINARY_BYTES,
    MAX_TEMPLATE_FILE_BYTES,
    _row_to_template,
    is_safe_file_name,
    render_template_files,
)
from app.security import hash_password

router = APIRouter(prefix="/admin", tags=["admin"])


class AdminUserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    is_admin: bool
    is_active: bool
    created_at: datetime
    project_count: int = 0


class AdminUserIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=120)
    is_admin: bool = False


class AdminUserPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    password: str | None = Field(default=None, min_length=8, max_length=128)
    is_admin: bool | None = None
    is_active: bool | None = None


class AdminTemplateFile(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    content: str = ""


class AdminTemplateFileOut(BaseModel):
    name: str
    kind: Literal["doc", "binary"] = "doc"


class AdminTemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    engine: Literal["pdflatex", "xelatex", "lualatex"] = "pdflatex"
    main_file: str = Field(default="main.tex", max_length=300)
    files: list[AdminTemplateFile] = Field(min_length=1)


class AdminTemplatePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    engine: Literal["pdflatex", "xelatex", "lualatex"] | None = None
    main_file: str | None = Field(default=None, max_length=300)


class AdminTemplateOut(BaseModel):
    id: str
    name: str
    description: str
    engine: str
    main_file: str
    files: list[AdminTemplateFileOut]
    builtin: bool


MAX_TEMPLATE_ZIP_BYTES = 20 * 1024 * 1024
_ENGINES = {"pdflatex", "xelatex", "lualatex"}

# LaTeX build output and OS metadata that often end up inside a template zip.
# These are skipped silently instead of failing the upload.
_IGNORED_TEMPLATE_NAMES = {".DS_Store", "Thumbs.db"}
_IGNORED_TEMPLATE_SUFFIXES = (
    ".synctex.gz",
    ".synctex",
    ".run.xml",
    ".fdb_latexmk",
    ".fls",
    ".aux",
    ".log",
    ".out",
    ".toc",
    ".lof",
    ".lot",
    ".bbl",
    ".blg",
    ".bcf",
    ".nav",
    ".snm",
    ".vrb",
    ".idx",
    ".ind",
    ".ilg",
    ".glo",
    ".gls",
    ".glg",
    ".acn",
    ".acr",
    ".alg",
    ".loa",
    ".lol",
    ".spl",
    ".xdv",
    ".dvi",
    ".bak",
    ".tmp",
    ".swp",
    ".swx",
    "~",
    "(busy)",
)
_IGNORED_TEMPLATE_DIRS = {"__MACOSX", ".git", ".svn", ".hg"}


def _is_ignored_template_entry(name: str) -> bool:
    lowered = name.lower()
    if name.startswith("._") or name.startswith("."):
        return True
    if name in _IGNORED_TEMPLATE_NAMES:
        return True
    return lowered.endswith(_IGNORED_TEMPLATE_SUFFIXES)


def _extract_template_zip(
    raw: bytes, requested_main: str | None
) -> tuple[list[dict], str]:
    if len(raw) > MAX_TEMPLATE_ZIP_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "Template zip is too large (max 20 MB)",
        )
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid zip file")

    entries: list[tuple[list[str], bytes]] = []
    for info in archive.infolist():
        if info.is_dir():
            continue
        parts = [
            part
            for part in info.filename.replace("\\", "/").split("/")
            if part not in ("", ".")
        ]
        if not parts or any(part == ".." for part in parts):
            continue
        if any(part in _IGNORED_TEMPLATE_DIRS for part in parts):
            continue
        if _is_ignored_template_entry(parts[-1]):
            continue
        entries.append((parts, archive.read(info)))
    if not entries:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zip contains no files")

    # Strip the usual single wrapper folder produced by "Compress folder".
    roots = {parts[0] for parts, _ in entries}
    if len(roots) == 1 and all(len(parts) > 1 for parts, _ in entries):
        entries = [(parts[1:], data) for parts, data in entries]

    if any(len(parts) != 1 for parts, _ in entries):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Template zip must contain files at the top level (subfolders are not supported)",
        )

    specs: list[dict] = []
    names: set[str] = set()
    for parts, data in entries:
        name = parts[0]
        if not is_safe_file_name(name):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Invalid template file name: {name}"
            )
        if name in names:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Duplicate file in zip: {name}"
            )
        names.add(name)
        extension = Path(name).suffix.lower()
        if extension in TEXT_EXT:
            if len(data) > MAX_TEMPLATE_FILE_BYTES:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"Template file too large: {name}"
                )
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"{name} is not valid UTF-8 text"
                )
            specs.append(
                {
                    "name": name,
                    "content": text.replace("\x00", ""),
                    "kind": "doc",
                    "mime": mimetypes.guess_type(name)[0] or "text/plain",
                    "encoding": "utf-8",
                }
            )
        elif extension in BINARY_TEMPLATE_EXTENSIONS:
            if len(data) > MAX_TEMPLATE_BINARY_BYTES:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"Template file too large: {name}"
                )
            specs.append(
                {
                    "name": name,
                    "content": base64.b64encode(data).decode("ascii"),
                    "kind": "binary",
                    "mime": mimetypes.guess_type(name)[0] or "application/octet-stream",
                    "encoding": "base64",
                }
            )
        else:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                (
                    f"Unsupported file type: {name}. Templates accept text files "
                    "and common images/PDFs (png, jpg, gif, svg, webp, pdf, eps)."
                ),
            )

    tex_names = [
        spec["name"]
        for spec in specs
        if Path(spec["name"]).suffix.lower() in {".tex", ".ltx"}
    ]
    if not tex_names:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Template zip must contain a .tex file"
        )

    chosen = (requested_main or "").strip()
    if chosen:
        if chosen not in names:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Main file {chosen!r} is not inside the zip",
            )
    else:
        for candidate in ("main.tex", "manuscript.tex"):
            if candidate in names:
                chosen = candidate
                break
        if not chosen:
            chosen = sorted(tex_names, key=lambda value: (value.count("/"), value))[0]

    try:
        specs = render_template_files({"main_file": chosen, "files": specs})
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return specs, chosen


async def _active_admin_count(db: AsyncSession, exclude: uuid.UUID | None = None) -> int:
    query = select(func.count(User.id)).where(
        User.is_admin.is_(True), User.is_active.is_(True)
    )
    if exclude is not None:
        query = query.where(User.id != exclude)
    return int((await db.execute(query)).scalar_one())


async def _project_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    return int(
        (
            await db.execute(
                select(func.count(Project.id)).where(Project.owner_id == user_id)
            )
        ).scalar_one()
    )


def _admin_user_out(user: User, project_count: int) -> AdminUserOut:
    return AdminUserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_admin=user.is_admin,
        is_active=user.is_active,
        created_at=user.created_at,
        project_count=project_count,
    )


async def _revoke_refresh_tokens(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )


@router.get("/users", response_model=list[AdminUserOut])
async def list_users(
    _admin: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
):
    users = (
        await db.execute(select(User).order_by(User.created_at.desc()))
    ).scalars().all()
    counts = {
        owner_id: count
        for owner_id, count in (
            await db.execute(
                select(Project.owner_id, func.count(Project.id)).group_by(Project.owner_id)
            )
        ).all()
    }
    return [_admin_user_out(user, counts.get(user.id, 0)) for user in users]


@router.post("/users", response_model=AdminUserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: AdminUserIn,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    email = body.email.lower().strip()
    exists = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = User(
        email=email,
        password_hash=hash_password(body.password),
        display_name=body.display_name.strip() or email.split("@")[0],
        is_admin=body.is_admin,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _admin_user_out(user, 0)


@router.patch("/users/{user_id}", response_model=AdminUserOut)
async def update_user(
    user_id: uuid.UUID,
    body: AdminUserPatch,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    if body.is_admin is False and user.is_admin and user.is_active:
        if await _active_admin_count(db, exclude=user.id) == 0:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Cannot remove the last administrator"
            )

    if body.is_active is False:
        if user.id == admin.id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "You cannot remove your own access"
            )
        if user.is_admin and user.is_active:
            if await _active_admin_count(db, exclude=user.id) == 0:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "Cannot remove the last administrator"
                )
        await _revoke_refresh_tokens(db, user.id)

    if body.display_name is not None:
        user.display_name = body.display_name.strip()
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.is_active is not None:
        user.is_active = body.is_active

    await db.commit()
    await db.refresh(user)
    return _admin_user_out(user, await _project_count(db, user.id))


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_user(
    user_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Remove a user's access. Project data stays intact and can be restored."""
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if user.id == admin.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "You cannot remove your own access"
        )
    if user.is_admin and user.is_active:
        if await _active_admin_count(db, exclude=user.id) == 0:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Cannot remove the last administrator"
            )
    user.is_active = False
    await _revoke_refresh_tokens(db, user.id)
    await db.commit()


def _template_out(template: dict, builtin: bool) -> AdminTemplateOut:
    return AdminTemplateOut(
        id=str(template["id"]),
        name=template["name"],
        description=template.get("description", ""),
        engine=template.get("engine", "pdflatex"),
        main_file=template.get("main_file", "main.tex"),
        files=[
            AdminTemplateFileOut(name=spec["name"], kind=spec.get("kind", "doc"))
            for spec in template.get("files", [])
        ],
        builtin=builtin,
    )


def _validated_files(body: AdminTemplateIn) -> list[dict]:
    try:
        return render_template_files(
            {
                "main_file": body.main_file,
                "files": [spec.model_dump() for spec in body.files],
            }
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.get("/templates", response_model=list[AdminTemplateOut])
async def list_templates(
    _admin: User = Depends(get_current_admin), db: AsyncSession = Depends(get_db)
):
    out = [_template_out(template, True) for template in BUILTIN_TEMPLATES]
    rows = (
        await db.execute(select(Template).order_by(Template.name))
    ).scalars().all()
    for row in rows:
        if row.id in BUILTIN_IDS:
            continue
        out.append(_template_out(_row_to_template(row), False))
    return out


@router.post(
    "/templates", response_model=AdminTemplateOut, status_code=status.HTTP_201_CREATED
)
async def create_template(
    body: AdminTemplateIn,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Template name is required")
    files = _validated_files(body)
    row = Template(
        id=uuid.uuid4().hex,
        name=name,
        description=body.description,
        engine=body.engine,
        main_file=body.main_file,
        source=json.dumps({"files": files}),
        created_by=admin.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _template_out(_row_to_template(row), False)


@router.post(
    "/templates/import-zip",
    response_model=AdminTemplateOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_template_from_zip(
    upload: UploadFile = UploadFileField(...),
    name: str = Form(...),
    description: str = Form(""),
    engine: str = Form("pdflatex"),
    main_file: str | None = Form(None),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Template name is required")
    if engine not in _ENGINES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid engine")
    specs, chosen = _extract_template_zip(await upload.read(), main_file)
    row = Template(
        id=uuid.uuid4().hex,
        name=clean_name,
        description=description,
        engine=engine,
        main_file=chosen,
        source=json.dumps({"files": specs}),
        created_by=admin.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _template_out(_row_to_template(row), False)


@router.put("/templates/{template_id}/import-zip", response_model=AdminTemplateOut)
async def update_template_from_zip(
    template_id: str,
    upload: UploadFile = UploadFileField(...),
    name: str = Form(...),
    description: str = Form(""),
    engine: str = Form("pdflatex"),
    main_file: str | None = Form(None),
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Template, template_id)
    if row is None:
        if template_id in BUILTIN_IDS:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Built-in templates cannot be edited"
            )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Template name is required")
    if engine not in _ENGINES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid engine")
    specs, chosen = _extract_template_zip(await upload.read(), main_file)
    row.name = clean_name
    row.description = description
    row.engine = engine
    row.main_file = chosen
    row.source = json.dumps({"files": specs})
    await db.commit()
    await db.refresh(row)
    return _template_out(_row_to_template(row), False)


@router.patch("/templates/{template_id}", response_model=AdminTemplateOut)
async def patch_template(
    template_id: str,
    body: AdminTemplatePatch,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Template, template_id)
    if row is None:
        if template_id in BUILTIN_IDS:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Built-in templates cannot be edited"
            )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    template = _row_to_template(row)
    if body.name is not None:
        clean_name = body.name.strip()
        if not clean_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Template name is required")
        row.name = clean_name
    if body.description is not None:
        row.description = body.description
    if body.engine is not None:
        row.engine = body.engine
    if body.main_file is not None:
        file_names = {spec["name"] for spec in template.get("files", [])}
        if body.main_file not in file_names:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Main file is not one of the template files",
            )
        row.main_file = body.main_file
    await db.commit()
    await db.refresh(row)
    return _template_out(_row_to_template(row), False)


@router.put("/templates/{template_id}", response_model=AdminTemplateOut)
async def update_template(
    template_id: str,
    body: AdminTemplateIn,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Template, template_id)
    if row is None:
        if template_id in BUILTIN_IDS:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Built-in templates cannot be edited"
            )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Template name is required")
    files = _validated_files(body)
    row.name = name
    row.description = body.description
    row.engine = body.engine
    row.main_file = body.main_file
    row.source = json.dumps({"files": files})
    await db.commit()
    await db.refresh(row)
    return _template_out(_row_to_template(row), False)


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: str,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Template, template_id)
    if row is None:
        if template_id in BUILTIN_IDS:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Built-in templates cannot be deleted"
            )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    await db.delete(row)
    await db.commit()
