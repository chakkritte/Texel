"""Project templates (Phase 4).

The three built-in templates are plain Python constants so they need no seed
migration. ``templates`` table rows (if any) are merged in for future custom
templates. Cloning is a pure payload transformation plus ordinary project
creation; no compile/worker involvement.
"""

import base64
import json
import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db import get_db
from app.deps import get_current_user
from app.models import Document, File, Project, User
from app.models_history import Template
from app.schemas import ProjectOut

router = APIRouter(tags=["templates"])

MAX_TEMPLATE_FILE_BYTES = 2 * 1024 * 1024
MAX_TEMPLATE_BINARY_BYTES = 5 * 1024 * 1024
BINARY_TEMPLATE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".ico",
    ".bmp",
    ".avif",
    ".pdf",
    ".eps",
}


BLANK_ARTICLE = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled Article}
\author{}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Write your abstract here.
\end{abstract}

\section{Introduction}
Start writing here.

\end{document}
"""

ARTICLE_WITH_SECTIONS_MAIN = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Article with Sections}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
A short summary of the article.
\end{abstract}

\input{intro}
\input{conclusion}

\bibliographystyle{plain}
\bibliography{references}

\end{document}
"""

ARTICLE_INTRO = r"""\section{Introduction}
Introduce the problem, the motivation and the contributions of this work~\cite{example2026}.

\subsection{Background}
Related work and context.
"""

ARTICLE_CONCLUSION = r"""\section{Conclusion}
Summarise the results and outline future work.
"""

REFERENCES_BIB = r"""@article{example2026,
  author  = {Doe, Jane and Roe, Richard},
  title   = {An Example Reference},
  journal = {Journal of Examples},
  year    = {2026},
  volume  = {1},
  pages   = {1--10}
}
"""

IEEE_MAIN = r"""\documentclass[conference]{IEEEtran}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{cite}
\usepackage{hyperref}

\title{A Two-Column Conference Paper}
\author{
  \IEEEauthorblockN{Author Name}
  \IEEEauthorblockA{Department, Institution\\City, Country\\author@example.com}
}

\begin{document}
\maketitle

\begin{abstract}
This template uses the IEEEtran conference class with a two-column layout.
\end{abstract}

\begin{IEEEkeywords}
LaTeX, template, conference
\end{IEEEkeywords}

\section{Introduction}
Introduce the problem and state the contributions~\cite{example2026}.

\section{Method}
Describe the proposed approach.

\section{Results}
Present and discuss the results.

\section{Conclusion}
Conclude the paper.

\bibliographystyle{IEEEtran}
\bibliography{references}

\end{document}
"""

IEEE_REFERENCES = r"""@inproceedings{example2026,
  author    = {Doe, Jane},
  title     = {An Example Conference Paper},
  booktitle = {Proceedings of the Example Conference},
  year      = {2026},
  pages     = {1--8}
}
"""


BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "blank-article",
        "name": "Blank article",
        "description": "Minimal single-file article with title, abstract and one section.",
        "engine": "pdflatex",
        "main_file": "main.tex",
        "files": [
            {"name": "main.tex", "content": BLANK_ARTICLE, "kind": "doc", "mime": "text/x-tex"}
        ],
    },
    {
        "id": "article-sections",
        "name": "Article with sections",
        "description": "Article split across main.tex, intro.tex and conclusion.tex with a BibTeX file.",
        "engine": "pdflatex",
        "main_file": "main.tex",
        "files": [
            {
                "name": "main.tex",
                "content": ARTICLE_WITH_SECTIONS_MAIN,
                "kind": "doc",
                "mime": "text/x-tex",
            },
            {"name": "intro.tex", "content": ARTICLE_INTRO, "kind": "doc", "mime": "text/x-tex"},
            {
                "name": "conclusion.tex",
                "content": ARTICLE_CONCLUSION,
                "kind": "doc",
                "mime": "text/x-tex",
            },
            {"name": "references.bib", "content": REFERENCES_BIB, "kind": "doc", "mime": "text/plain"},
        ],
    },
    {
        "id": "ieee-two-column",
        "name": "IEEE two-column paper",
        "description": "IEEEtran conference class, two columns, with a sample bibliography.",
        "engine": "pdflatex",
        "main_file": "main.tex",
        "files": [
            {"name": "main.tex", "content": IEEE_MAIN, "kind": "doc", "mime": "text/x-tex"},
            {
                "name": "references.bib",
                "content": IEEE_REFERENCES,
                "kind": "doc",
                "mime": "text/plain",
            },
        ],
    },
]

BUILTIN_IDS = {template["id"] for template in BUILTIN_TEMPLATES}


class CloneIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# Pure helpers (unit tested without a database)
# ---------------------------------------------------------------------------


def get_builtin_template(template_id: str) -> dict[str, Any] | None:
    for template in BUILTIN_TEMPLATES:
        if template["id"] == template_id:
            return template
    return None


def is_safe_file_name(name: str) -> bool:
    return bool(
        name
        and name not in {".", ".."}
        and "/" not in name
        and "\\" not in name
        and "\x00" not in name
    )


def render_template_files(template: dict[str, Any]) -> list[dict[str, Any]]:
    """Return a validated copy of a template's file specifications.

    Text files store their content directly. Binary files (figures, PDFs) store
    base64 in ``content`` with ``encoding="base64"`` so the template row stays
    a single JSON document.
    """
    files = template.get("files") or []
    if not files:
        raise ValueError("Template has no files")
    rendered: list[dict[str, Any]] = []
    for spec in files:
        name = str(spec.get("name", "")).strip()
        if not is_safe_file_name(name):
            raise ValueError(f"Invalid template file name: {name!r}")
        kind = str(spec.get("kind", "doc"))
        if kind not in {"doc", "binary"}:
            raise ValueError(f"Invalid template file kind: {kind!r}")
        encoding = str(
            spec.get("encoding", "base64" if kind == "binary" else "utf-8")
        )
        content = str(spec.get("content", ""))
        if kind == "binary":
            if encoding != "base64":
                raise ValueError(f"Binary template file must use base64: {name}")
            try:
                raw = base64.b64decode(content, validate=True)
            except Exception as exc:
                raise ValueError(f"Invalid base64 content: {name}") from exc
            if len(raw) > MAX_TEMPLATE_BINARY_BYTES:
                raise ValueError(f"Template file too large: {name}")
        else:
            if encoding not in {"utf-8", "text"}:
                raise ValueError(f"Text template file has invalid encoding: {name}")
            if len(content.encode("utf-8")) > MAX_TEMPLATE_FILE_BYTES:
                raise ValueError(f"Template file too large: {name}")
        mime = spec.get("mime") or (
            mimetypes.guess_type(name)[0]
            or ("text/plain" if kind == "doc" else "application/octet-stream")
        )
        rendered.append(
            {
                "name": name,
                "content": content,
                "kind": kind,
                "mime": mime,
                "encoding": encoding,
            }
        )
    main_specs = [spec for spec in rendered if spec["name"] == template.get("main_file")]
    if not main_specs or main_specs[0]["kind"] != "doc":
        raise ValueError("Template main file is missing from its file list")
    return rendered


def build_clone_payload(template: dict[str, Any], name: str) -> dict[str, Any]:
    """Pure project payload used by the clone endpoint and tests."""
    project_name = name.strip() or str(template.get("name") or "Untitled")
    return {
        "name": project_name,
        "engine": template.get("engine", "pdflatex"),
        "main_file": template.get("main_file", "main.tex"),
        "files": render_template_files(template),
    }


def _template_summary(template: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": template["id"],
        "name": template["name"],
        "description": template.get("description", ""),
        "engine": template.get("engine", "pdflatex"),
        "main_file": template.get("main_file", "main.tex"),
    }


def _row_to_template(row: Template) -> dict[str, Any]:
    try:
        source = json.loads(row.source or "{}")
    except json.JSONDecodeError:
        source = {}
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "engine": row.engine,
        "main_file": row.main_file,
        "files": source.get("files", []),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/templates")
async def list_templates(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    summaries = [_template_summary(template) for template in BUILTIN_TEMPLATES]
    rows = (
        await db.execute(select(Template).order_by(Template.name))
    ).scalars()
    for row in rows:
        if row.id in BUILTIN_IDS:
            continue
        summaries.append(_template_summary(_row_to_template(row)))
    return summaries


@router.post("/templates/{template_id}/clone", response_model=ProjectOut, status_code=201)
async def clone_template(
    template_id: str,
    body: CloneIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    template = get_builtin_template(template_id)
    if template is None:
        row = await db.get(Template, template_id)
        if row is not None:
            template = _row_to_template(row)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")

    try:
        payload = build_clone_payload(template, body.name)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))

    project = Project(
        owner_id=user.id,
        name=payload["name"],
        engine=payload["engine"],
        main_file=payload["main_file"],
    )
    db.add(project)
    await db.flush()

    dest_root = Path(settings.data_dir) / "projects" / str(project.id) / "files"
    for spec in payload["files"]:
        is_binary = spec["kind"] == "binary"
        raw = base64.b64decode(spec["content"]) if is_binary else b""
        file = File(
            project_id=project.id,
            name=spec["name"],
            kind=spec["kind"],
            mime=spec["mime"],
            size=len(raw) if is_binary else len(spec["content"].encode("utf-8")),
        )
        db.add(file)
        await db.flush()
        if is_binary:
            dest_root.mkdir(parents=True, exist_ok=True)
            dest = dest_root / str(file.id)
            dest.write_bytes(raw)
            file.disk_path = str(dest)
        else:
            db.add(Document(file_id=file.id, content=spec["content"], seq=1))

    await db.commit()
    await db.refresh(project)
    return ProjectOut(
        id=project.id,
        name=project.name,
        main_file=project.main_file,
        engine=project.engine,
        ai_enabled=project.ai_enabled,
        role="owner",
        created_at=project.created_at,
        updated_at=project.updated_at,
    )
