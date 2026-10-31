import asyncio
import re
import shlex
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import docker
from sqlalchemy import select

from app.core.config import settings
from app.db import SessionLocal
from app.models import CompileJob, Document, File, Folder, Project

_project_locks: dict[str, asyncio.Lock] = {}

_INCLUDEGRAPHICS_RE = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}")
_INPUT_RE = re.compile(r"\\(?:input|include)\{([^}]+)\}")


def _lock_for(project_id: str) -> asyncio.Lock:
    lock = _project_locks.get(project_id)
    if lock is None:
        lock = asyncio.Lock()
        _project_locks[project_id] = lock
    return lock


def _create_case_aliases(root: Path) -> int:
    """Tectonic is case-sensitive while latexmk/kpathsea is tolerant. Create
    aliases for references whose capitalization differs from the stored file."""
    refs: set[str] = set()
    for tex in root.rglob("*.tex"):
        if "out" in tex.relative_to(root).parts:
            continue
        try:
            text = tex.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        refs.update(match.group(1).strip() for match in _INCLUDEGRAPHICS_RE.finditer(text))
        refs.update(match.group(1).strip() for match in _INPUT_RE.finditer(text))

    files = [
        path
        for path in root.rglob("*")
        if path.is_file() and "out" not in path.relative_to(root).parts
    ]
    lower = {
        str(path.relative_to(root)).replace("\\", "/").lower(): path for path in files
    }

    made = 0
    for ref in refs:
        if not ref or ref.startswith("/"):
            continue
        normalized = ref.replace("\\", "/")
        candidates = [normalized]
        if not Path(normalized).suffix:
            candidates.append(f"{normalized}.tex")
        for candidate in candidates:
            target = root / candidate
            if target.exists():
                continue
            match = lower.get(candidate.lower())
            if match is None:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copyfile(match, target)
                made += 1
            except OSError:
                pass
    return made


def _folder_paths(folders: list[Folder]) -> dict[uuid.UUID, str]:
    by_id = {f.id: f for f in folders}
    cache: dict[uuid.UUID, str] = {}

    def resolve(fid: uuid.UUID) -> str:
        if fid in cache:
            return cache[fid]
        folder = by_id.get(fid)
        if folder is None:
            return ""
        parent = resolve(folder.parent_id) if folder.parent_id else ""
        path = f"{parent}/{folder.name}" if parent else folder.name
        cache[fid] = path
        return path

    for fid in by_id:
        resolve(fid)
    return cache


_TEXLIVE_FLAGS = {
    "pdflatex": "-pdf",
    "xelatex": "-xelatex",
    "lualatex": "-lualatex",
}


def _compile_command(main_file: str, engine: str, use_texlive: bool) -> str:
    if use_texlive:
        flag = _TEXLIVE_FLAGS[engine]
        return (
            "mkdir -p /work/out && "
            f"latexmk -cd {flag} -interaction=nonstopmode -halt-on-error "
            f"-file-line-error -synctex=1 -outdir=/work/out {shlex.quote(main_file)}"
        )
    return (
        "mkdir -p /work/out && "
        f"tectonic -X compile {shlex.quote(main_file)} "
        "--keep-logs --synctex -o /work/out"
    )


def _run_container(
    workdir: Path, cache_host: Path, main_file: str, engine: str = "pdflatex"
) -> tuple[int, str]:
    client = docker.from_env()
    use_texlive = engine in _TEXLIVE_FLAGS and bool(settings.compile_texlive_image)
    if use_texlive:
        try:
            client.images.get(settings.compile_texlive_image)
        except docker.errors.ImageNotFound:
            # Fall back to Tectonic if the TeX Live image is not installed.
            use_texlive = False
    image = settings.compile_texlive_image if use_texlive else settings.compile_image
    command = _compile_command(main_file, engine, use_texlive)
    environment = {"HOME": "/tmp"}
    volumes = {str(workdir): {"bind": "/work", "mode": "rw"}}
    if use_texlive:
        # Keep TeX caches writable inside the container's tmpfs.
        environment["TEXMFVAR"] = "/tmp/texmf-var"
        environment["TEXMFCACHE"] = "/tmp/texmf-cache"
    else:
        environment["TECTONIC_CACHE_DIR"] = "/cache"
        # Persistent package/font cache; only new resources need fetching.
        volumes[str(cache_host)] = {"bind": "/cache", "mode": "rw"}

    container = client.containers.create(
        image,
        command=["/bin/sh", "-lc", command],
        entrypoint=[],
        working_dir="/work",
        user="65534:65534",
        environment=environment,
        volumes=volumes,
        read_only=True,
        tmpfs={"/tmp": "size=512m"},
        mem_limit=settings.compile_memory,
        nano_cpus=int(settings.compile_cpus * 1_000_000_000),
        pids_limit=settings.compile_pids,
        cap_drop=["ALL"],
        security_opt=["no-new-privileges"],
        detach=True,
    )
    logs = ""
    exit_code = -1
    try:
        container.start()
        try:
            result = container.wait(timeout=settings.compile_timeout_seconds)
            exit_code = int(result.get("StatusCode", -1))
        except Exception:
            container.kill()
            exit_code = 124
            logs = "Compile timed out\n"
        raw = container.logs(stdout=True, stderr=True)
        logs += raw.decode("utf-8", errors="replace")
    finally:
        try:
            container.remove(force=True)
        except Exception:
            pass
    return exit_code, logs


def _extract_errors(log: str) -> str | None:
    lines = []
    for line in log.splitlines():
        if re.match(r"^!|^.*:\d+: ", line) or "LaTeX Error" in line or "Emergency stop" in line:
            lines.append(line.strip())
        if len(lines) >= 25:
            break
    return "\n".join(lines) if lines else None


async def compile_project(ctx, job_id: str) -> None:
    # arq passes the worker context as the first positional argument.
    del ctx
    async with SessionLocal() as db:
        job = await db.get(CompileJob, uuid.UUID(job_id))
        if job is None:
            return
        project = await db.get(Project, job.project_id)
        if project is None or project.deleted_at is not None:
            job.status = "failed"
            job.error = "Project not found"
            await db.commit()
            return

        job.status = "running"
        job.started_at = datetime.now(timezone.utc)
        await db.commit()

        files = (
            await db.execute(select(File).where(File.project_id == project.id))
        ).scalars().all()
        folders = (
            await db.execute(select(Folder).where(Folder.project_id == project.id))
        ).scalars().all()
        docs = {
            d.file_id: d
            for d in (
                await db.execute(
                    select(Document).where(
                        Document.file_id.in_([f.id for f in files] or [uuid.uuid4()])
                    )
                )
            ).scalars()
        }
        folder_paths = _folder_paths(list(folders))

        job_dir = Path(settings.data_dir) / "compiles" / str(project.id) / str(job.id)
        tmp_container = Path(settings.data_dir) / "compile-tmp" / str(job.id)
        tmp_host = Path(settings.host_data_dir) / "compile-tmp" / str(job.id)
        tectonic_cache_container = Path(settings.data_dir) / "tectonic-cache"
        tectonic_cache_host = Path(settings.host_data_dir) / "tectonic-cache"

        lock = _lock_for(str(project.id))
        await lock.acquire()
        try:
            if tmp_container.exists():
                shutil.rmtree(tmp_container)
            tmp_container.mkdir(parents=True, exist_ok=True)
            (tmp_container / "out").mkdir(exist_ok=True)
            # The compile container runs as uid 65534 and writes into /work/out.
            tmp_container.chmod(0o777)
            (tmp_container / "out").chmod(0o777)

            main = project.main_file
            tectonic_cache_container.mkdir(parents=True, exist_ok=True)
            try:
                tectonic_cache_container.chmod(0o777)
            except OSError:
                pass

            for file in files:
                rel = folder_paths.get(file.folder_id, "")
                dest = tmp_container / rel / file.name if rel else tmp_container / file.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                # latexmk runs as uid 65534 and may write aux files beside the
                # main document when -cd is used.
                try:
                    dest.parent.chmod(0o777)
                except OSError:
                    pass
                if file.kind == "doc":
                    doc = docs.get(file.id)
                    dest.write_text(doc.content if doc else "", encoding="utf-8")
                elif file.disk_path and Path(file.disk_path).exists():
                    shutil.copyfile(file.disk_path, dest)

            if not (tmp_container / main).exists():
                raise FileNotFoundError(f"Main file '{main}' not found in project")

            # Tectonic is case-sensitive; alias references with different case.
            _create_case_aliases(tmp_container)

            exit_code, logs = await asyncio.to_thread(
                _run_container, tmp_host, tectonic_cache_host, main, project.engine
            )

            job_dir.mkdir(parents=True, exist_ok=True)
            out_dir = tmp_container / "out"
            if out_dir.exists():
                for item in out_dir.rglob("*"):
                    if item.is_file():
                        relative = item.relative_to(out_dir)
                        destination = job_dir / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(item, destination)

            log_file = job_dir / "compile.log"
            log_file.write_text(logs, encoding="utf-8", errors="replace")

            stem = Path(main).stem
            pdf = job_dir / f"{stem}.pdf"
            synctex = job_dir / f"{stem}.synctex.gz"
            tex_log = job_dir / f"{stem}.log"

            job.exit_code = exit_code
            job.log_path = str(tex_log if tex_log.exists() else log_file)
            job.synctex_path = str(synctex) if synctex.exists() else None
            if exit_code == 0 and pdf.exists():
                job.status = "success"
                job.pdf_path = str(pdf)
                job.error = None
            else:
                job.status = "failed"
                job.pdf_path = None
                job.error = _extract_errors(logs) or (
                    f"Compilation failed with exit code {exit_code}"
                )
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)[:4000]
        finally:
            job.finished_at = datetime.now(timezone.utc)
            await db.commit()
            shutil.rmtree(tmp_container, ignore_errors=True)
            lock.release()
