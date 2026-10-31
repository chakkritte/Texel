"""Request/response models for the collab HTTP API."""

from __future__ import annotations

from pydantic import BaseModel, Field

# 5 MiB of Yjs update -> ~7 MiB base64; leave head-room for framing.
_MAX_B64 = 8_000_000


class SyncOut(BaseModel):
    seq: int
    update: str
    awareness: list[str] = Field(default_factory=list)


class UpdateIn(BaseModel):
    client_id: str = Field(min_length=1, max_length=200)
    client_seq: int = Field(ge=0)
    update: str = Field(min_length=1, max_length=_MAX_B64)


class UpdateOut(BaseModel):
    seq: int


class PollUpdate(BaseModel):
    seq: int
    update: str


class PollOut(BaseModel):
    seq: int
    updates: list[PollUpdate] = Field(default_factory=list)
    awareness: list[str] = Field(default_factory=list)


class AwarenessIn(BaseModel):
    client_id: str = Field(min_length=1, max_length=200)
    update: str = Field(min_length=1, max_length=64 * 1024)


class FlushOut(BaseModel):
    seq: int
