"""Streaming orchestration, usage accounting, quota and SSE framing."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, time as datetime_time, timedelta, timezone
from typing import Any, AsyncIterator

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.context import ContextBundle, estimate_tokens, truncate_to_tokens
from app.ai.providers import (
    Provider,
    ProviderError,
    get_provider,
    usage_from_done,
)
from app.ai.tools import (
    TEXT_TOOL_CONVENTION,
    normalize_tool_call,
    parse_text_tool_calls,
    tool_definitions_for,
)
from app.db import SessionLocal
from app.models import Project
from app.models_ai import AiConversation, AiMessage, AiUsage, utcnow

logger = logging.getLogger(__name__)

HISTORY_MESSAGE_LIMIT = 20
HISTORY_TOKEN_BUDGET = 20_000


def _quota_from_env() -> int:
    try:
        return max(1, int(os.getenv("AI_DAILY_TOKEN_QUOTA", "2000000")))
    except (TypeError, ValueError):
        logger.warning("Invalid AI_DAILY_TOKEN_QUOTA; using 2000000")
        return 2_000_000


DAILY_TOKEN_QUOTA = _quota_from_env()


class QuotaExceeded(Exception):
    def __init__(self, used: int, quota: int) -> None:
        super().__init__(f"Daily AI token quota exceeded ({used}/{quota})")
        self.used = used
        self.quota = quota


class ConversationNotFound(Exception):
    pass


SYSTEM_PROMPT = """\
You are the AI assistant inside SGtech LaTeX Studio, a collaborative LaTeX
editor. You help the user write, debug and explain the current project.

Rules:
- Ground every answer in the supplied project context. Never invent file ids,
  paths or file contents.
- Never claim an edit was applied. Edits are proposals the user must review and
  accept.
- For propose_edit, range.from and range.to are 0-based character offsets into
  the complete file content (to is exclusive). Keep the replacement valid
  LaTeX and preserve the user's style.
- Use jump_to_error when referring to a concrete compiler error.
- Prefer minimal, targeted changes. Be concise when explaining.
"""


def utc_day_start() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime.combine(now.date(), datetime_time.min, tzinfo=timezone.utc)


def compose_user_content(content: str, volatile_block: str) -> str:
    volatile = (volatile_block or "").strip()
    if not volatile:
        return content
    return f"{volatile}\n\n# USER REQUEST\n{content}"


def build_system_blocks(context: ContextBundle, provider_id: str) -> list[dict[str, Any]]:
    """Stable prompt first, cached project block second."""
    stable = SYSTEM_PROMPT
    if provider_id != "anthropic":
        stable = f"{stable}\n\n{TEXT_TOOL_CONVENTION}"
    blocks: list[dict[str, Any]] = [
        {"type": "text", "text": stable},
        {
            "type": "text",
            "text": context.project_block,
            "cache_control": {"type": "ephemeral"},
        },
    ]
    return blocks


def format_sse(event: dict[str, Any]) -> str:
    event_type = str(event.get("type") or "message")
    payload = {key: value for key, value in event.items() if key != "type"}
    data = json.dumps(payload, ensure_ascii=False, default=str)
    return f"event: {event_type}\ndata: {data}\n\n"


async def stream_events(
    provider: Provider,
    *,
    model: str,
    system: Any,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
) -> AsyncIterator[dict[str, Any]]:
    """Normalize a provider stream; providers may implement tools natively or
    through the fenced-JSON convention."""
    text_parts: list[str] = []
    done_event: dict[str, Any] | None = None
    try:
        async for event in provider.stream(
            model=model, system=system, messages=messages, tools=tools
        ):
            event_type = event.get("type")
            if event_type == "token":
                text = str(event.get("text", ""))
                if text:
                    text_parts.append(text)
                    yield {"type": "token", "text": text}
            elif event_type == "tool":
                # Validate native (Anthropic) and fallback (JSON block) calls
                # through the same guard before the browser sees them.
                call = normalize_tool_call(
                    str(event.get("name", "")), event.get("input", {})
                )
                if call is not None:
                    yield {
                        "type": "tool",
                        "name": call["name"],
                        "input": call["input"],
                    }
            elif event_type == "done":
                done_event = dict(event)

        if not provider.supports_tools:
            for call in parse_text_tool_calls("".join(text_parts)):
                yield {
                    "type": "tool",
                    "name": call["name"],
                    "input": call["input"],
                }

        if done_event is None:
            done_event = {
                "provider": provider.id,
                "model": model,
                "tokens_in": 0,
                "tokens_out": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            }
        yield {"type": "done", **done_event}
    except ProviderError as exc:
        yield {"type": "error", "message": str(exc)}
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - never kill an in-flight SSE response
        logger.exception("Unexpected AI provider failure")
        yield {"type": "error", "message": "AI request failed unexpectedly; please retry."}


async def ensure_daily_quota(db: AsyncSession, user_id: uuid.UUID) -> int:
    used = await db.scalar(
        select(
            func.coalesce(func.sum(AiUsage.tokens_in + AiUsage.tokens_out), 0)
        ).where(AiUsage.user_id == user_id, AiUsage.created_at >= utc_day_start())
    )
    used = int(used or 0)
    if used >= DAILY_TOKEN_QUOTA:
        raise QuotaExceeded(used=used, quota=DAILY_TOKEN_QUOTA)
    return used


async def load_history(
    db: AsyncSession, conversation_id: uuid.UUID, limit: int = HISTORY_MESSAGE_LIMIT
) -> list[dict[str, str]]:
    rows = (
        await db.execute(
            select(AiMessage)
            .where(
                AiMessage.conversation_id == conversation_id,
                AiMessage.role.in_(("user", "assistant")),
                AiMessage.content != "",
            )
            .order_by(AiMessage.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    # Keep the newest turns within a token budget, then restore chronological
    # order. This keeps the current context block from being drowned out.
    trimmed: list[dict[str, str]] = []
    budget = HISTORY_TOKEN_BUDGET
    for message in reversed(rows):
        if budget <= 0:
            break
        content = message.content
        if estimate_tokens(content) > budget:
            content = truncate_to_tokens(content, budget)
        trimmed.append({"role": message.role, "content": content})
        budget -= estimate_tokens(content)
    trimmed.reverse()

    # The Messages API requires the first turn to be a user turn; trimming can
    # otherwise leave an assistant message at the front.
    while trimmed and trimmed[0]["role"] != "user":
        trimmed.pop(0)
    return trimmed


async def get_or_create_conversation(
    db: AsyncSession,
    *,
    project: Project,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    provider: str,
    model: str,
    title: str = "",
) -> AiConversation:
    if conversation_id is not None:
        conversation = await db.get(AiConversation, conversation_id)
        if (
            conversation is None
            or conversation.project_id != project.id
            or conversation.user_id != user_id
        ):
            raise ConversationNotFound("Conversation not found")
        return conversation

    conversation = AiConversation(
        project_id=project.id,
        user_id=user_id,
        title=title[:200],
        provider=provider,
        model=model,
    )
    db.add(conversation)
    await db.flush()
    return conversation


async def add_user_message(
    db: AsyncSession,
    *,
    conversation: AiConversation,
    user_id: uuid.UUID,
    content: str,
    provider: str,
    model: str,
) -> AiMessage:
    message = AiMessage(
        conversation_id=conversation.id,
        user_id=user_id,
        role="user",
        content=content,
        provider=provider,
        model=model,
    )
    db.add(message)
    conversation.provider = provider
    conversation.model = model
    conversation.updated_at = utcnow()
    if not conversation.title:
        conversation.title = content.strip().splitlines()[0][:200] if content.strip() else ""
    await db.commit()
    await db.refresh(message)
    return message


async def _persist_assistant_turn(
    *,
    assistant_id: uuid.UUID,
    conversation_id: uuid.UUID,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    provider: str,
    model: str,
    content: str,
    tool_calls: list[dict[str, Any]],
    tokens_in: int,
    tokens_out: int,
    cost_usd: float,
    latency_ms: int,
) -> None:
    async with SessionLocal() as session:
        session.add(
            AiMessage(
                id=assistant_id,
                conversation_id=conversation_id,
                user_id=user_id,
                role="assistant",
                content=content,
                provider=provider,
                model=model,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                tool_calls=tool_calls or None,
            )
        )
        session.add(
            AiUsage(
                user_id=user_id,
                project_id=project_id,
                conversation_id=conversation_id,
                provider=provider,
                model=model,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cost_usd=cost_usd,
                latency_ms=latency_ms,
            )
        )
        conversation = await session.get(AiConversation, conversation_id)
        if conversation is not None:
            conversation.provider = provider
            conversation.model = model
            conversation.updated_at = utcnow()
        await session.commit()


async def sse_stream(
    *,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    provider_id: str,
    model: str,
    system: list[dict[str, Any]],
    messages: list[dict[str, Any]],
) -> AsyncIterator[str]:
    """Run one assistant turn and emit SSE frames.

    Persistence uses a fresh session because the request-scoped session is
    released once the streaming response starts.
    """
    provider = get_provider(provider_id)
    tools = tool_definitions_for(provider_id)
    assistant_id = uuid.uuid4()
    started = time.monotonic()
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []

    try:
        async for event in stream_events(
            provider, model=model, system=system, messages=messages, tools=tools
        ):
            event_type = event.get("type")
            if event_type == "token":
                text_parts.append(str(event.get("text", "")))
                yield format_sse(event)
            elif event_type == "tool":
                tool_calls.append(
                    {"name": event.get("name", ""), "input": event.get("input", {})}
                )
                yield format_sse(event)
            elif event_type == "error":
                yield format_sse(event)
                return
            elif event_type == "done":
                usage = usage_from_done(event)
                latency_ms = int((time.monotonic() - started) * 1000)
                content = "".join(text_parts)
                try:
                    await _persist_assistant_turn(
                        assistant_id=assistant_id,
                        conversation_id=conversation_id,
                        user_id=user_id,
                        project_id=project_id,
                        provider=provider_id,
                        model=str(event.get("model") or model),
                        content=content,
                        tool_calls=tool_calls,
                        tokens_in=usage.tokens_in,
                        tokens_out=usage.tokens_out,
                        cost_usd=usage.cost_usd,
                        latency_ms=latency_ms,
                    )
                except Exception:  # noqa: BLE001 - streaming already succeeded
                    logger.exception("Could not persist AI usage/message")
                yield format_sse(
                    {
                        "type": "done",
                        "conversation_id": str(conversation_id),
                        "message_id": str(assistant_id),
                        "provider": provider_id,
                        "model": str(event.get("model") or model),
                        "usage": {
                            "tokens_in": usage.tokens_in,
                            "tokens_out": usage.tokens_out,
                            "total_tokens": usage.tokens_in + usage.tokens_out,
                            "cost_usd": usage.cost_usd,
                        },
                        "latency_ms": latency_ms,
                    }
                )
                return
    except asyncio.CancelledError:
        # Client disconnected; keep whatever was generated.
        if text_parts:
            try:
                await _persist_assistant_turn(
                    assistant_id=assistant_id,
                    conversation_id=conversation_id,
                    user_id=user_id,
                    project_id=project_id,
                    provider=provider_id,
                    model=model,
                    content="".join(text_parts),
                    tool_calls=tool_calls,
                    tokens_in=0,
                    tokens_out=0,
                    cost_usd=0.0,
                    latency_ms=int((time.monotonic() - started) * 1000),
                )
            except Exception:  # noqa: BLE001
                logger.exception("Could not persist cancelled AI turn")
        raise


async def usage_summary(
    db: AsyncSession, user_id: uuid.UUID, days: int = 30
) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))
    totals = (
        await db.execute(
            select(
                func.count(AiUsage.id),
                func.coalesce(func.sum(AiUsage.tokens_in), 0),
                func.coalesce(func.sum(AiUsage.tokens_out), 0),
                func.coalesce(func.sum(AiUsage.cost_usd), 0.0),
            ).where(AiUsage.user_id == user_id, AiUsage.created_at >= since)
        )
    ).one()
    messages, tokens_in, tokens_out, cost_usd = totals

    by_provider_rows = (
        await db.execute(
            select(
                AiUsage.provider,
                func.count(AiUsage.id),
                func.coalesce(func.sum(AiUsage.tokens_in), 0),
                func.coalesce(func.sum(AiUsage.tokens_out), 0),
                func.coalesce(func.sum(AiUsage.cost_usd), 0.0),
            )
            .where(AiUsage.user_id == user_id, AiUsage.created_at >= since)
            .group_by(AiUsage.provider)
            .order_by(AiUsage.provider)
        )
    ).all()

    today_used = await db.scalar(
        select(
            func.coalesce(func.sum(AiUsage.tokens_in + AiUsage.tokens_out), 0)
        ).where(AiUsage.user_id == user_id, AiUsage.created_at >= utc_day_start())
    )

    return {
        "days": days,
        "messages": int(messages or 0),
        "tokens_in": int(tokens_in or 0),
        "tokens_out": int(tokens_out or 0),
        "total_tokens": int(tokens_in or 0) + int(tokens_out or 0),
        "cost_usd": round(float(cost_usd or 0.0), 6),
        "today_tokens": int(today_used or 0),
        "daily_quota": DAILY_TOKEN_QUOTA,
        "since": since,
        "by_provider": [
            {
                "provider": provider,
                "messages": int(count or 0),
                "tokens_in": int(tin or 0),
                "tokens_out": int(tout or 0),
                "cost_usd": round(float(cost or 0.0), 6),
            }
            for provider, count, tin, tout, cost in by_provider_rows
        ],
    }
