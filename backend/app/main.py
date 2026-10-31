from contextlib import asynccontextmanager
from pathlib import Path

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

import app.models_ai  # noqa: F401  # register Phase 3 tables before create_all
import app.models_history  # noqa: F401  # register Phase 4 tables before create_all
from app.core.config import settings
from app.db import Base, engine, ensure_schema
from app.routers import admin, ai, auth, comments, compile, history, projects, share, templates


@asynccontextmanager
async def lifespan(app: FastAPI):
    for sub in ("projects", "compiles", "versions", "uploads"):
        (Path(settings.data_dir) / sub).mkdir(parents=True, exist_ok=True)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await ensure_schema()

    app.state.arq = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        yield
    finally:
        await app.state.arq.close()
        await engine.dispose()


app = FastAPI(
    title="SGtech LaTeX Studio",
    version="0.1.0",
    root_path=settings.root_path,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(projects.router, prefix="/api/v1")
app.include_router(compile.router, prefix="/api/v1")
# Phase 3
app.include_router(ai.router, prefix="/api/v1")
# Phase 4
app.include_router(history.router, prefix="/api/v1")
app.include_router(comments.router, prefix="/api/v1")
app.include_router(share.router, prefix="/api/v1")
app.include_router(templates.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1")


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/v1/healthz")
async def healthz_api():
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ok", "db": "ok"}
