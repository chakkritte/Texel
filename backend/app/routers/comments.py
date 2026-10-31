"""Inline comments on project files (Phase 4)."""

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import ROLE_LEVEL, get_current_user, project_access
from app.models import File, Project, ProjectMember, User, utcnow
from app.models_history import Comment

router = APIRouter(tags=["comments"])


class CommentIn(BaseModel):
    file_id: uuid.UUID
    body: str = Field(min_length=1, max_length=20_000)
    anchor: dict[str, Any] | None = None


class CommentOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    file_id: uuid.UUID
    author_id: uuid.UUID
    author_name: str | None
    body: str
    anchor: dict[str, Any] | None
    resolved_at: datetime | None
    created_at: datetime


async def _role_for(db: AsyncSession, project: Project, user: User) -> str:
    if project.owner_id == user.id:
        return "owner"
    member = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    return member.role if member else "viewer"


def _out(comment: Comment, author_name: str | None = None) -> CommentOut:
    return CommentOut(
        id=comment.id,
        project_id=comment.project_id,
        file_id=comment.file_id,
        author_id=comment.author_id,
        author_name=author_name,
        body=comment.body,
        anchor=comment.anchor,
        resolved_at=comment.resolved_at,
        created_at=comment.created_at,
    )


async def _comment_or_404(db: AsyncSession, comment_id: uuid.UUID) -> Comment:
    comment = await db.get(Comment, comment_id)
    if comment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    return comment


@router.get("/projects/{project_id}/comments", response_model=list[CommentOut])
async def list_comments(
    project_id: uuid.UUID,
    file_id: uuid.UUID | None = Query(default=None),
    include_resolved: bool = Query(default=True),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user)
    stmt = (
        select(Comment, User.display_name)
        .join(User, User.id == Comment.author_id)
        .where(Comment.project_id == project_id)
        .order_by(Comment.created_at.asc())
    )
    if file_id is not None:
        stmt = stmt.where(Comment.file_id == file_id)
    if not include_resolved:
        stmt = stmt.where(Comment.resolved_at.is_(None))
    rows = (await db.execute(stmt)).all()
    return [_out(comment, author_name) for comment, author_name in rows]


@router.post(
    "/projects/{project_id}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    project_id: uuid.UUID,
    body: CommentIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user, "commenter")
    file = await db.get(File, body.file_id)
    if file is None or file.project_id != project_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid file for this project")

    comment = Comment(
        project_id=project_id,
        file_id=file.id,
        author_id=user.id,
        body=body.body,
        anchor=body.anchor,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return _out(comment, user.display_name)


@router.post("/comments/{comment_id}/resolve", response_model=CommentOut)
async def resolve_comment(
    comment_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    comment = await _comment_or_404(db, comment_id)
    project = await project_access(db, comment.project_id, user)
    role = await _role_for(db, project, user)
    if comment.author_id != user.id and ROLE_LEVEL.get(role, 0) < ROLE_LEVEL["editor"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author or an editor can resolve")

    if comment.resolved_at is None:
        comment.resolved_at = utcnow()
        await db.commit()
        await db.refresh(comment)

    author_name = (
        await db.execute(select(User.display_name).where(User.id == comment.author_id))
    ).scalar_one_or_none()
    return _out(comment, author_name)


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    comment_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    comment = await _comment_or_404(db, comment_id)
    project = await project_access(db, comment.project_id, user)
    role = await _role_for(db, project, user)
    if comment.author_id != user.id and ROLE_LEVEL.get(role, 0) < ROLE_LEVEL["editor"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author or an editor can delete")

    await db.delete(comment)
    await db.commit()
