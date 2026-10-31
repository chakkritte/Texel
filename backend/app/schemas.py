import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    is_admin: bool

    model_config = {"from_attributes": True}


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=120)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class RefreshIn(BaseModel):
    refresh_token: str | None = None


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    engine: str = Field(default="pdflatex", pattern="^(pdflatex|xelatex|lualatex)$")
    # Import flows create the project empty so the zip provides every file;
    # normal creation keeps the starter main.tex.
    create_main: bool = True


class ProjectCopyIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    engine: str | None = Field(default=None, pattern="^(pdflatex|xelatex|lualatex)$")
    main_file: str | None = Field(default=None, max_length=300)
    ai_enabled: bool | None = None


class ProjectTagIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    color: str = Field(default="#64748b", pattern=r"^#[0-9a-fA-F]{6}$")


class ProjectTagPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=50)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class ProjectTagOut(BaseModel):
    id: uuid.UUID
    name: str
    color: str

    model_config = {"from_attributes": True}


class ProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    main_file: str
    engine: str
    ai_enabled: bool
    role: str
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    archived_at: datetime | None = None
    tags: list[ProjectTagOut] = Field(default_factory=list)


class FolderOut(BaseModel):
    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None

    model_config = {"from_attributes": True}


class FileOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    mime: str
    size: int
    folder_id: uuid.UUID | None

    model_config = {"from_attributes": True}


class TreeOut(BaseModel):
    folders: list[FolderOut]
    files: list[FileOut]


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: uuid.UUID | None = None


class FileIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    folder_id: uuid.UUID | None = None
    content: str = ""
    kind: str = Field(default="doc", pattern="^(doc|binary)$")


class FilePatch(BaseModel):
    name: str | None = Field(default=None, max_length=300)
    folder_id: uuid.UUID | None = None


class FolderPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    parent_id: uuid.UUID | None = None


class DocContentOut(BaseModel):
    content: str
    seq: int


class DocContentIn(BaseModel):
    content: str


class CompileOut(BaseModel):
    id: uuid.UUID
    status: str
    exit_code: int | None
    error: str | None
    pdf_url: str | None = None
    log_url: str | None = None
    created_at: datetime
    finished_at: datetime | None
