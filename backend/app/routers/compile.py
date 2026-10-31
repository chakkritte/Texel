import re
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db import get_db
from app.deps import get_current_user, project_access
from app.models import CompileJob, User
from app.schemas import CompileOut

router = APIRouter(tags=["compile"])


def _out(job: CompileJob) -> CompileOut:
    base = f"{settings.root_path}/api/v1/compile/{job.id}"
    return CompileOut(
        id=job.id,
        status=job.status,
        exit_code=job.exit_code,
        error=job.error,
        pdf_url=f"{base}/pdf" if job.status == "success" else None,
        log_url=f"{base}/log",
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


@router.post("/projects/{project_id}/compile", response_model=CompileOut, status_code=202)
async def start_compile(
    project_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "editor")
    job = CompileJob(project_id=project.id, user_id=user.id, engine=project.engine)
    db.add(job)
    await db.commit()
    await db.refresh(job)

    arq = request.app.state.arq
    try:
        await arq.enqueue_job("compile_project", str(job.id))
    except Exception as exc:  # queue unavailable
        job.status = "failed"
        job.error = f"Could not enqueue compile: {exc}"
        await db.commit()
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Compile queue unavailable")
    return _out(job)


async def _job_for(db: AsyncSession, job_id: uuid.UUID, user: User) -> CompileJob:
    job = await db.get(CompileJob, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Compile job not found")
    await project_access(db, job.project_id, user)
    return job


@router.get("/compile/{job_id}", response_model=CompileOut)
async def get_compile(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return _out(await _job_for(db, job_id, user))


@router.get("/projects/{project_id}/compiles/latest", response_model=CompileOut | None)
async def latest_compile(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user)
    job = (
        await db.execute(
            select(CompileJob)
            .where(CompileJob.project_id == project_id)
            .order_by(CompileJob.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return _out(job) if job else None


@router.get("/compile/{job_id}/pdf")
async def compile_pdf(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await _job_for(db, job_id, user)
    if job.status != "success" or not job.pdf_path or not Path(job.pdf_path).exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF not available")
    return FileResponse(job.pdf_path, media_type="application/pdf", filename="output.pdf")


SYNCTEX_TIMEOUT = 10


def _synctex_workspace(job: CompileJob) -> tuple[Path, str]:
    if not job.pdf_path or not Path(job.pdf_path).exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF not available")
    return Path(job.pdf_path).parent, Path(job.pdf_path).name


def _run_synctex(job_dir: Path, args: list[str]) -> str:
    try:
        proc = subprocess.run(
            ["synctex", *args],
            cwd=str(job_dir),
            capture_output=True,
            text=True,
            timeout=SYNCTEX_TIMEOUT,
        )
    except FileNotFoundError:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "synctex is not installed")
    except subprocess.TimeoutExpired:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "synctex timed out")
    return proc.stdout or proc.stderr


def _project_relative(path: str) -> str:
    value = path.strip()
    value = re.sub(r"^/work/\.?/?", "", value)
    return value.lstrip("./")


@router.get("/compile/{job_id}/synctex/edit")
async def synctex_edit(
    job_id: uuid.UUID,
    page: int,
    x: float,
    y: float,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Inverse search: PDF page position -> source file/line/column."""
    job = await _job_for(db, job_id, user)
    job_dir, pdf_name = _synctex_workspace(job)
    output = _run_synctex(job_dir, ["edit", "-o", f"{page}:{x}:{y}:{pdf_name}"])
    record: dict[str, object] = {}
    for line in output.splitlines():
        if line.startswith("Input:"):
            record["file"] = _project_relative(line.split(":", 1)[1])
        elif line.startswith("Line:"):
            try:
                record["line"] = int(float(line.split(":", 1)[1]))
            except ValueError:
                pass
        elif line.startswith("Column:"):
            try:
                record["column"] = int(float(line.split(":", 1)[1]))
            except ValueError:
                pass
    if "file" not in record or "line" not in record:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No synctex match")
    return record


@router.get("/compile/{job_id}/synctex/view")
async def synctex_view(
    job_id: uuid.UUID,
    file: str,
    line: int,
    column: int = 0,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Forward search: source file/line/column -> PDF page positions."""
    job = await _job_for(db, job_id, user)
    if len(file) > 400:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid file name")
    job_dir, pdf_name = _synctex_workspace(job)

    # Tectonic records absolute input paths (/work/...); TeX Live records the
    # names as passed. Try the common spellings until one matches.
    candidates = (
        [file]
        if file.startswith("/")
        else [f"/work/{file}", f"/work/./{file}", file]
    )

    records: list[dict[str, float]] = []
    for candidate in candidates:
        output = _run_synctex(
            job_dir, ["view", "-i", f"{line}:{column}:{candidate}", "-o", pdf_name]
        )
        parsed: list[dict[str, float]] = []
        current: dict[str, float] | None = None
        for raw in output.splitlines():
            text = raw.strip()
            if text.startswith("Output:"):
                current = {}
                parsed.append(current)
                continue
            if current is None or ":" not in text:
                continue
            key, value = text.split(":", 1)
            try:
                if key == "Page":
                    current["page"] = int(float(value))
                elif key in ("x", "y", "h", "v", "W", "H"):
                    current[key] = float(value)
            except ValueError:
                continue
        records = [record for record in parsed if "page" in record]
        if records:
            break

    return {"records": records[:20]}


@router.get("/compile/{job_id}/log", response_class=PlainTextResponse)
async def compile_log(
    job_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await _job_for(db, job_id, user)
    if not job.log_path or not Path(job.log_path).exists():
        return PlainTextResponse(job.error or "(no log)")
    text = Path(job.log_path).read_text(encoding="utf-8", errors="replace")
    return PlainTextResponse(text[-200_000:])
