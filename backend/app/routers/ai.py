"""AI side-panel routes (mounted at ``/api/v1/ai``)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import service
from app.ai.context import build_context
from app.ai.providers import available_providers, default_model_for, get_provider
from app.ai.schemas import (
    ConversationIn,
    ConversationOut,
    MessageIn,
    MessageOut,
    ModelsOut,
    UsageOut,
)
from app.db import get_db
from app.deps import get_current_user, project_access
from app.models import User
from app.models_ai import AiConversation, AiMessage

router = APIRouter(prefix="/ai", tags=["ai"])


def _selection_dict(body: MessageIn) -> dict | None:
    selection = body.context.selection
    if selection is None:
        return None
    return {"from": selection.from_, "to": selection.to, "text": selection.text}


@router.get("/models", response_model=ModelsOut)
async def list_models(user: User = Depends(get_current_user)):
    return {"providers": await available_providers()}


@router.get(
    "/projects/{project_id}/conversations",
    response_model=list[ConversationOut],
)
async def list_conversations(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await project_access(db, project_id, user)
    rows = (
        await db.execute(
            select(AiConversation)
            .where(
                AiConversation.project_id == project_id,
                AiConversation.user_id == user.id,
            )
            .order_by(AiConversation.updated_at.desc())
            .limit(100)
        )
    ).scalars().all()
    return list(rows)


@router.post(
    "/projects/{project_id}/conversations",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_conversation(
    project_id: uuid.UUID,
    body: ConversationIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "editor")
    if not project.ai_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "AI is disabled for this project")
    model = body.model or default_model_for(body.provider)
    conversation = AiConversation(
        project_id=project.id,
        user_id=user.id,
        title=(body.title or "New conversation")[:200],
        provider=body.provider,
        model=model,
    )
    db.add(conversation)
    await db.commit()
    await db.refresh(conversation)
    return conversation


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=list[MessageOut],
)
async def list_messages(
    conversation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conversation = await db.get(AiConversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    await project_access(db, conversation.project_id, user)
    rows = (
        await db.execute(
            select(AiMessage)
            .where(AiMessage.conversation_id == conversation_id)
            .order_by(AiMessage.created_at.asc())
            .limit(1000)
        )
    ).scalars().all()
    return list(rows)


@router.post("/projects/{project_id}/messages")
async def send_message(
    project_id: uuid.UUID,
    body: MessageIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await project_access(db, project_id, user, "editor")
    if not project.ai_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "AI is disabled for this project")

    try:
        get_provider(body.provider)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    model = body.model or default_model_for(body.provider)

    try:
        await service.ensure_daily_quota(db, user.id)
    except service.QuotaExceeded as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Daily AI token quota exceeded ({exc.used}/{exc.quota}). "
            "Try again tomorrow or raise AI_DAILY_TOKEN_QUOTA.",
        ) from exc

    try:
        conversation = await service.get_or_create_conversation(
            db,
            project=project,
            user_id=user.id,
            conversation_id=body.conversation_id,
            provider=body.provider,
            model=model,
            title=body.content[:200],
        )
    except service.ConversationNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found") from exc

    history = await service.load_history(db, conversation.id)
    context_bundle = await build_context(
        db,
        project,
        file_id=body.context.file_id,
        selection=_selection_dict(body),
        compile_job_id=body.context.compile_job_id,
    )

    await service.add_user_message(
        db,
        conversation=conversation,
        user_id=user.id,
        content=body.content,
        provider=body.provider,
        model=model,
    )

    system = service.build_system_blocks(context_bundle, body.provider)
    messages = history + [
        {
            "role": "user",
            "content": service.compose_user_content(
                body.content, context_bundle.volatile_block
            ),
        }
    ]

    return StreamingResponse(
        service.sse_stream(
            project_id=project.id,
            user_id=user.id,
            conversation_id=conversation.id,
            provider_id=body.provider,
            model=model,
            system=system,
            messages=messages,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/usage", response_model=UsageOut)
async def usage(
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await service.usage_summary(db, user.id, days=days)
