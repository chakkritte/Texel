import contextlib

from arq.connections import RedisSettings

from app.compile.runner import compile_project
from app.core.config import settings
from app.db import ensure_schema


async def startup(_ctx):
    with contextlib.suppress(Exception):
        await ensure_schema()


class WorkerSettings:
    functions = [compile_project]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    max_jobs = 2
    job_timeout = 300
    keep_result = 0
    on_startup = startup
