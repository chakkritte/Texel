from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class Base(DeclarativeBase):
    pass


async def ensure_schema() -> None:
    """Apply small idempotent migrations for databases created by older builds.

    ``create_all`` only creates missing tables; it never adds columns to an
    existing table, so new columns need an explicit ``ADD COLUMN IF NOT EXISTS``.
    """
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS "
                "deleted_at TIMESTAMP WITH TIME ZONE"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE projects ADD COLUMN IF NOT EXISTS "
                "archived_at TIMESTAMP WITH TIME ZONE"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS "
                "is_active BOOLEAN NOT NULL DEFAULT TRUE"
            )
        )


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
