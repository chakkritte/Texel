"""Pydantic request/response models for ``/api/v1/ai``."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ProviderId = Literal["anthropic", "ollama"]


class SelectionIn(BaseModel):
    """A 0-based line selection (``to`` exclusive)."""

    model_config = ConfigDict(populate_by_name=True)

    from_: int = Field(alias="from", ge=0)
    to: int = Field(ge=0)
    text: str | None = None


class ContextIn(BaseModel):
    file_id: uuid.UUID | None = None
    selection: SelectionIn | None = None
    compile_job_id: uuid.UUID | None = None


class MessageIn(BaseModel):
    conversation_id: uuid.UUID | None = None
    provider: ProviderId = "anthropic"
    model: str | None = Field(default=None, max_length=120)
    content: str = Field(min_length=1, max_length=100_000)
    context: ContextIn = Field(default_factory=ContextIn)


class ConversationIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    provider: ProviderId = "anthropic"
    model: str | None = Field(default=None, max_length=120)


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    title: str
    provider: str
    model: str
    created_at: datetime
    updated_at: datetime


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    role: str
    content: str
    provider: str | None = None
    model: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    tool_calls: list[dict[str, Any]] | None = None
    created_at: datetime


class ProviderModelsOut(BaseModel):
    id: str
    models: list[str]
    default: str


class ModelsOut(BaseModel):
    providers: list[ProviderModelsOut]


class UsageBucketOut(BaseModel):
    provider: str
    messages: int
    tokens_in: int
    tokens_out: int
    cost_usd: float


class UsageOut(BaseModel):
    days: int
    messages: int
    tokens_in: int
    tokens_out: int
    total_tokens: int
    cost_usd: float
    today_tokens: int
    daily_quota: int
    since: datetime
    by_provider: list[UsageBucketOut]
