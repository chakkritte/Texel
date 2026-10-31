"""Project context builder for the AI side panel.

The builder separates *stable* content (project tree, main file, resolved
``\\input``/``\\include`` files) from *volatile* content (the current
selection, the latest compile error, open comments).  The stable part is sent
as a cached system block on Anthropic; volatile content is prepended to the
user's message so moving the cursor does not invalidate the prompt cache.

Everything is capped at roughly 60k tokens.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CompileJob, Document, File, Folder, Project, User

MAX_CONTEXT_TOKENS = 60_000
PROJECT_TOKEN_BUDGET = 45_000
VOLATILE_TOKEN_BUDGET = 15_000
SELECTION_RADIUS_LINES = 40
MAX_INCLUDED_FILES = 5
LOG_TAIL_CHARS = 8_000
CHARS_PER_TOKEN = 4

_INCLUDE_RE = re.compile(r"\\(?:input|include|subfile)\s*\{([^}]+)\}")
_COMMENT_RE = re.compile(r"(?<!\\)%.*")


# ---------------------------------------------------------------------------
# Pure helpers (unit tested)
# ---------------------------------------------------------------------------


def estimate_tokens(text: str) -> int:
    """Cheap conservative estimate: ~4 characters per token."""
    if not text:
        return 0
    return (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def truncate_to_tokens(text: str, max_tokens: int, marker: str = "\n…[truncated]") -> str:
    if max_tokens <= 0:
        return ""
    if estimate_tokens(text) <= max_tokens:
        return text
    max_chars = max_tokens * CHARS_PER_TOKEN
    if max_chars <= len(marker):
        return text[:max_chars]
    return text[: max_chars - len(marker)] + marker


def strip_latex_comments(content: str) -> str:
    return _COMMENT_RE.sub("", content or "")


def find_tex_includes(content: str) -> list[str]:
    """Return normalized, de-duplicated include targets from LaTeX source."""
    found: list[str] = []
    seen: set[str] = set()
    for match in _INCLUDE_RE.finditer(strip_latex_comments(content or "")):
        name = match.group(1).strip()
        if not name or "#" in name:
            continue
        normalized = normalize_include(name)
        if normalized and normalized not in seen:
            seen.add(normalized)
            found.append(normalized)
    return found


def normalize_include(name: str) -> str:
    name = name.strip().replace("\\", "/")
    while name.startswith("./"):
        name = name[2:]
    name = name.lstrip("/")
    if name and not Path(name).suffix:
        name += ".tex"
    return name


@dataclass(frozen=True)
class SelectionSlice:
    text: str
    start_line: int  # 0-based, first line included in the excerpt
    end_line: int  # 0-based, exclusive
    char_from: int  # absolute character offset of the selection start
    char_to: int  # absolute character offset of the selection end (exclusive)
    selected_text: str


def slice_selection(
    content: str, from_line: int, to_line: int, radius: int = SELECTION_RADIUS_LINES
) -> SelectionSlice:
    """Return ±radius lines around a 0-based line selection.

    ``to_line`` is exclusive.  Character offsets always refer to the complete
    file, which is what ``propose_edit.range`` expects.
    """
    lines = content.splitlines(keepends=True)
    total = len(lines)
    start_sel = max(0, min(int(from_line), total))
    end_sel = max(0, min(int(to_line), total))
    if end_sel <= start_sel:
        end_sel = min(total, start_sel + 1)

    start = max(0, start_sel - radius)
    end = min(total, end_sel + radius)
    char_from = sum(len(line) for line in lines[:start_sel])
    char_to = sum(len(line) for line in lines[:end_sel])
    return SelectionSlice(
        text="".join(lines[start:end]),
        start_line=start,
        end_line=end,
        char_from=char_from,
        char_to=char_to,
        selected_text="".join(lines[start_sel:end_sel]),
    )


@dataclass
class ContextBundle:
    project_block: str
    volatile_block: str
    included_files: list[str] = field(default_factory=list)
    truncated: bool = False
    estimated_tokens: int = 0

    @property
    def stable_tokens(self) -> int:
        return estimate_tokens(self.project_block)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FileEntry:
    id: uuid.UUID
    path: str
    name: str
    kind: str
    size: int


def render_project_block(
    *,
    project_name: str,
    main_file: str,
    engine: str,
    file_entries: Sequence[FileEntry],
    content_order: Sequence[uuid.UUID],
    contents: dict[uuid.UUID, tuple[str, str]],
    max_tokens: int = PROJECT_TOKEN_BUDGET,
) -> tuple[str, list[str], bool]:
    """Render the stable project block deterministically."""
    header_lines = [
        "# PROJECT CONTEXT",
        "",
        f"Project: {project_name}",
        f"Main file: {main_file}",
        f"Engine: {engine}",
        "",
        "## Project files",
    ]
    for entry in sorted(file_entries, key=lambda item: (item.path, str(item.id))):
        # Deliberately no size/mtime here: the block must stay byte-stable for
        # prompt caching across saves and cursor moves.
        header_lines.append(f"- {entry.path} (id={entry.id}, kind={entry.kind})")
    header = "\n".join(header_lines) + "\n\n## File contents\n"
    rendered = header
    included: list[str] = []
    truncated = False

    for file_id in content_order:
        item = contents.get(file_id)
        if item is None:
            continue
        path, content = item
        language = "tex" if path.endswith((".tex", ".sty", ".cls")) else "text"
        section = f"\n### {path} (id={file_id})\n```{language}\n{content}\n```\n"
        remaining = max_tokens - estimate_tokens(rendered)
        if remaining <= 64:
            truncated = True
            break
        if estimate_tokens(section) > remaining:
            section = (
                f"\n### {path} (id={file_id})\n```{language}\n"
                f"{truncate_to_tokens(content, max(1, remaining - 24))}\n```\n"
            )
            truncated = True
        rendered += section
        included.append(path)

    return rendered, included, truncated


def _entry_lookup(entries: Sequence[FileEntry]) -> dict[str, FileEntry]:
    lookup: dict[str, FileEntry] = {}
    for entry in entries:
        keys = {
            entry.path,
            entry.name,
            str(Path(entry.path).with_suffix("")),
            Path(entry.name).stem,
        }
        for key in keys:
            if key:
                lookup.setdefault(key, entry)
    return lookup


def match_include(name: str, entries: Sequence[FileEntry]) -> FileEntry | None:
    normalized = normalize_include(name)
    lookup = _entry_lookup(entries)
    direct = lookup.get(normalized)
    if direct is not None:
        return direct
    # Fall back to a suffix match (``sections/intro.tex`` may live one folder
    # deeper in the actual tree).
    candidates = [
        entry
        for entry in entries
        if entry.path == normalized or entry.path.endswith("/" + normalized)
    ]
    if candidates:
        return min(candidates, key=lambda item: len(item.path))
    return None


# ---------------------------------------------------------------------------
# DB-backed builder
# ---------------------------------------------------------------------------


def _folder_paths(folders: Sequence[Folder]) -> dict[uuid.UUID, str]:
    by_id = {folder.id: folder for folder in folders}
    cache: dict[uuid.UUID, str] = {}

    def resolve(folder_id: uuid.UUID, seen: frozenset[uuid.UUID]) -> str:
        if folder_id in cache:
            return cache[folder_id]
        folder = by_id.get(folder_id)
        if folder is None or folder_id in seen:
            return ""
        parent = ""
        if folder.parent_id is not None:
            parent = resolve(folder.parent_id, seen | {folder_id})
        path = f"{parent}/{folder.name}" if parent else folder.name
        cache[folder_id] = path
        return path

    for folder_id in by_id:
        resolve(folder_id, frozenset())
    return cache


async def _load_documents(
    db: AsyncSession, file_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, str]:
    ids = list(dict.fromkeys(file_ids))
    if not ids:
        return {}
    rows = await db.execute(
        select(Document.file_id, Document.content).where(Document.file_id.in_(ids))
    )
    return {file_id: content for file_id, content in rows.all()}


def _read_log_tail(path: str | None, max_chars: int = LOG_TAIL_CHARS) -> str:
    if not path:
        return ""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - max_chars * 3))
            data = handle.read()
        return data.decode("utf-8", "replace")[-max_chars:]
    except OSError:
        return ""


async def _latest_compile(
    db: AsyncSession, project: Project, compile_job_id: uuid.UUID | None
) -> CompileJob | None:
    if compile_job_id is not None:
        job = await db.get(CompileJob, compile_job_id)
        if job is not None and job.project_id == project.id:
            return job
    result = await db.execute(
        select(CompileJob)
        .where(CompileJob.project_id == project.id)
        .order_by(CompileJob.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _open_comments(db: AsyncSession, project_id: uuid.UUID) -> list[str]:
    """Best effort: the comments table only exists after Phase 4."""
    Comment = None
    for module_name in ("app.models_history", "app.models"):
        try:  # pragma: no cover - depends on Phase 4 model
            module = __import__(module_name, fromlist=["Comment"])
            Comment = getattr(module, "Comment")
            break
        except (ImportError, AttributeError):
            continue
    if Comment is None:
        return []

    try:
        statement = select(Comment).where(Comment.project_id == project_id)
        if hasattr(Comment, "resolved_at"):
            statement = statement.where(Comment.resolved_at.is_(None))
        elif hasattr(Comment, "resolved"):
            statement = statement.where(Comment.resolved.is_(False))
        comments = (
            await db.execute(
                statement.order_by(Comment.created_at.desc()).limit(20)
            )
        ).scalars().all()

        authors: dict[uuid.UUID, str] = {}
        author_ids = {
            getattr(comment, "author_id", None) for comment in comments
        }
        author_ids.discard(None)
        if author_ids:
            try:
                author_rows = await db.execute(
                    select(User.id, User.display_name).where(User.id.in_(author_ids))
                )
                authors = {user_id: name or "" for user_id, name in author_rows.all()}
            except Exception:  # noqa: BLE001 - comments are best effort
                authors = {}

        out: list[str] = []
        for comment in comments:
            body = getattr(comment, "body", None) or getattr(comment, "content", "")
            author_id = getattr(comment, "author_id", None)
            author = getattr(comment, "author_name", "") or authors.get(author_id, "")
            if not author and author_id is not None:
                author = str(author_id)[:8]
            anchor = getattr(comment, "anchor", None)
            file_id = getattr(comment, "file_id", None)
            details: list[str] = []
            if body:
                details.append(str(body))
            if anchor:
                try:
                    details.append(
                        "anchor=" + json.dumps(anchor, ensure_ascii=False, default=str)
                    )
                except (TypeError, ValueError):
                    details.append(f"anchor={anchor}")
            if file_id is not None:
                details.append(f"file={str(file_id)[:8]}")
            prefix = f"- {author}: " if author else "- "
            out.append((prefix + " ".join(details)).strip())
        return out
    except Exception:  # noqa: BLE001 - schema may differ; skip silently
        return []


def _coerce_selection(selection: Any) -> SelectionSlice | None:
    if selection is None:
        return None
    if isinstance(selection, dict):
        start = selection.get("from", selection.get("from_line", 0))
        end = selection.get("to", selection.get("to_line", 0))
    else:
        start = getattr(selection, "from_", getattr(selection, "from_line", 0))
        end = getattr(selection, "to", getattr(selection, "to_line", 0))
    try:
        start_i = int(start)
        end_i = int(end)
    except (TypeError, ValueError):
        return None
    return SelectionSlice(
        text="",
        start_line=max(0, start_i),
        end_line=max(0, end_i),
        char_from=0,
        char_to=0,
        selected_text="",
    )


def _volatile_block(
    *,
    current_path: str | None,
    current_id: uuid.UUID | None,
    content: str | None,
    selection: SelectionSlice | None,
    compile_job: CompileJob | None,
    comments: Sequence[str],
) -> str:
    lines: list[str] = ["# EDITOR STATE"]
    if current_path and current_id is not None:
        lines.append(f"Current file: {current_path} (id={current_id})")
    if content is not None:
        if selection is not None:
            excerpt = slice_selection(content, selection.start_line, selection.end_line)
            lines.extend(
                [
                    (
                        "Selection: 0-based lines "
                        f"{selection.start_line}-{selection.end_line}, "
                        f"chars {excerpt.char_from}-{excerpt.char_to}"
                    ),
                    f"Selected text:\n{excerpt.selected_text}",
                    "File excerpt (selection ±40 lines):",
                    "```tex",
                    excerpt.text,
                    "```",
                ]
            )
        else:
            lines.extend(["Current file content:", "```tex", content, "```"])

    if compile_job is not None:
        lines.append("")
        lines.append("# LATEST COMPILE")
        lines.append(f"Status: {compile_job.status}")
        if compile_job.exit_code is not None:
            lines.append(f"Exit code: {compile_job.exit_code}")
        if compile_job.error:
            lines.append(f"Error: {compile_job.error}")
        log_tail = _read_log_tail(compile_job.log_path)
        if log_tail:
            lines.extend(["Log tail:", "```text", log_tail, "```"])

    if comments:
        lines.append("")
        lines.append("# OPEN COMMENTS")
        lines.extend(comments)

    return truncate_to_tokens(
        "\n".join(lines).rstrip(), VOLATILE_TOKEN_BUDGET, marker="\n…[context truncated]"
    )


async def build_context(
    db: AsyncSession,
    project: Project,
    *,
    file_id: uuid.UUID | None = None,
    selection: Any = None,
    compile_job_id: uuid.UUID | None = None,
) -> ContextBundle:
    """Build the stable project block and the volatile editor block."""
    folders = (
        await db.execute(
            select(Folder).where(Folder.project_id == project.id).order_by(Folder.name)
        )
    ).scalars().all()
    files = (
        await db.execute(
            select(File).where(File.project_id == project.id).order_by(File.name)
        )
    ).scalars().all()

    folder_paths = _folder_paths(folders)
    entries: list[FileEntry] = []
    by_id: dict[uuid.UUID, File] = {}
    for file in files:
        by_id[file.id] = file
        folder_path = folder_paths.get(file.folder_id) if file.folder_id else ""
        path = f"{folder_path}/{file.name}" if folder_path else file.name
        entries.append(
            FileEntry(
                id=file.id,
                path=path,
                name=file.name,
                kind=file.kind,
                size=file.size,
            )
        )
    entry_by_id = {entry.id: entry for entry in entries}

    main_entry = next(
        (
            entry
            for entry in entries
            if entry.path == project.main_file or entry.name == project.main_file
        ),
        None,
    )
    current_entry = entry_by_id.get(file_id) if file_id is not None else None
    if current_entry is None:
        current_entry = main_entry or next(
            (entry for entry in entries if entry.kind == "doc"), None
        )

    # Load main + current content up front.
    seed_ids: list[uuid.UUID] = []
    if main_entry is not None:
        seed_ids.append(main_entry.id)
    if current_entry is not None and current_entry.id not in seed_ids:
        seed_ids.append(current_entry.id)
    seed_contents = await _load_documents(db, seed_ids)

    # Best-effort include resolution (current file first, then main), max 5.
    included_ids: list[uuid.UUID] = []
    queue: list[str] = []
    for seed in (current_entry, main_entry):
        if seed is not None:
            queue.extend(find_tex_includes(seed_contents.get(seed.id, "")))
    while queue and len(included_ids) < MAX_INCLUDED_FILES:
        name = queue.pop(0)
        match = match_include(name, entries)
        if match is None or match.kind != "doc":
            continue
        if match.id in included_ids or match.id in seed_ids:
            continue
        included_ids.append(match.id)

    included_contents = await _load_documents(db, included_ids)
    all_contents = {**seed_contents, **included_contents}

    # Deeper include expansion (still capped).
    for included_id in list(included_ids):
        if len(included_ids) >= MAX_INCLUDED_FILES:
            break
        for name in find_tex_includes(included_contents.get(included_id, "")):
            if len(included_ids) >= MAX_INCLUDED_FILES:
                break
            match = match_include(name, entries)
            if (
                match is None
                or match.kind != "doc"
                or match.id in included_ids
                or match.id in seed_ids
            ):
                continue
            extra = await _load_documents(db, [match.id])
            included_ids.append(match.id)
            included_contents.update(extra)
            all_contents.update(extra)

    # Stable block: main file first, then the other resolved includes.
    order: list[uuid.UUID] = []
    if main_entry is not None:
        order.append(main_entry.id)
    for included_id in included_ids:
        if included_id not in order:
            order.append(included_id)
    content_map = {
        fid: (entry_by_id[fid].path, content)
        for fid, content in all_contents.items()
        if fid in entry_by_id
    }
    project_block, included_paths, truncated = render_project_block(
        project_name=project.name,
        main_file=project.main_file,
        engine=project.engine,
        file_entries=entries,
        content_order=order,
        contents=content_map,
    )

    # Volatile block: current file/selection + compile + comments.
    current_content: str | None = None
    current_path: str | None = None
    if current_entry is not None:
        current_path = current_entry.path
        current_content = all_contents.get(current_entry.id)
        if current_content is None:
            loaded = await _load_documents(db, [current_entry.id])
            current_content = loaded.get(current_entry.id, "")
    selection_value = _coerce_selection(selection)
    compile_job = await _latest_compile(db, project, compile_job_id)
    comments = await _open_comments(db, project.id)
    volatile = _volatile_block(
        current_path=current_path,
        current_id=current_entry.id if current_entry else None,
        content=current_content,
        selection=selection_value,
        compile_job=compile_job,
        comments=comments,
    )

    # Trim the volatile block to leave the total under the 60k-token cap.
    stable_tokens = estimate_tokens(project_block)
    remaining = max(1, MAX_CONTEXT_TOKENS - stable_tokens)
    if estimate_tokens(volatile) > remaining:
        volatile = truncate_to_tokens(
            volatile, remaining, marker="\n…[context truncated]"
        )
        truncated = True

    return ContextBundle(
        project_block=project_block,
        volatile_block=volatile,
        included_files=included_paths,
        truncated=truncated,
        estimated_tokens=estimate_tokens(project_block) + estimate_tokens(volatile),
    )
