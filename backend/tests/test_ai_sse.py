import asyncio
import json
import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.ai.service as service
import app.routers.ai as ai_router
from app.ai.context import ContextBundle
from app.ai.providers import ProviderError
from app.ai.service import compose_user_content, format_sse, stream_events
from app.db import get_db
from app.deps import get_current_user


class FakeProvider:
    id = "fake"
    default_model = "fake-1"
    supports_tools = False

    def __init__(self, chunks, done=True):
        self.chunks = chunks
        self._done = done

    async def stream(self, *, model, system, messages, tools=None):
        for chunk in self.chunks:
            yield {"type": "token", "text": chunk}
        if self._done:
            yield {
                "type": "done",
                "provider": self.id,
                "model": model,
                "tokens_in": 11,
                "tokens_out": 3,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            }


def collect(provider, model="fake-1", messages=None):
    async def run():
        out = []
        async for event in stream_events(
            provider,
            model=model,
            system=[{"type": "text", "text": "sys"}],
            messages=messages or [{"role": "user", "content": "hi"}],
            tools=None,
        ):
            out.append(event)
        return out

    return asyncio.run(run())


def test_stream_events_tokens_and_done():
    events = collect(FakeProvider(["Hello", " world"]))
    assert [event["type"] for event in events] == ["token", "token", "done"]
    assert events[0]["text"] == "Hello"
    assert events[-1]["tokens_in"] == 11
    assert events[-1]["tokens_out"] == 3


def test_stream_events_parses_json_convention_for_non_tool_provider():
    text = (
        "Try this:\n"
        "```json\n"
        '{"tool": "propose_edit", "input": {"file_id": "f", "range": '
        '{"from": 0, "to": 1}, "replacement": "X", "rationale": "r"}}\n'
        "```"
    )
    events = collect(FakeProvider([text]))
    types = [event["type"] for event in events]
    assert types == ["token", "tool", "done"]
    assert events[1]["name"] == "propose_edit"
    assert events[1]["input"]["file_id"] == "f"


def test_stream_events_validates_native_tool_events():
    class NativeToolProvider(FakeProvider):
        supports_tools = True

        async def stream(self, *, model, system, messages, tools=None):
            yield {"type": "token", "text": "x"}
            yield {
                "type": "tool",
                "name": "propose_edit",
                "input": {
                    "file_id": "f",
                    "range": {"from": 0, "to": 2},
                    "replacement": "ok",
                    "rationale": "r",
                },
            }
            # Invalid range must be dropped, not forwarded to the browser.
            yield {
                "type": "tool",
                "name": "propose_edit",
                "input": {
                    "file_id": "f",
                    "range": {"from": 5, "to": 2},
                    "replacement": "bad",
                },
            }
            yield {
                "type": "done",
                "provider": self.id,
                "model": model,
                "tokens_in": 1,
                "tokens_out": 1,
            }

    events = collect(NativeToolProvider(["ignored"]))
    tools = [event for event in events if event["type"] == "tool"]
    assert len(tools) == 1
    assert tools[0]["input"]["replacement"] == "ok"


def test_stream_events_synthesizes_done_when_provider_omits_it():
    events = collect(FakeProvider(["only text"], done=False))
    assert events[-1]["type"] == "done"
    assert events[-1]["tokens_in"] == 0
    assert events[-1]["tokens_out"] == 0


def test_format_sse():
    frame = format_sse({"type": "token", "text": "a\nb"})
    assert frame.startswith("event: token\n")
    assert frame.endswith("\n\n")
    data_line = frame.splitlines()[1]
    assert data_line.startswith("data: ")
    assert json.loads(data_line[len("data: ") :]) == {"text": "a\nb"}


def test_format_sse_done_serializes_uuids_and_usage():
    class FakeId:
        def __str__(self):
            return "abc"

    frame = format_sse(
        {"type": "done", "conversation_id": FakeId(), "usage": {"tokens_in": 1}}
    )
    assert "event: done" in frame
    assert '"conversation_id": "abc"' in frame


def test_compose_user_content_places_context_before_request():
    content = compose_user_content("Fix it", "# EDITOR STATE\nCurrent file: main.tex")
    assert content.startswith("# EDITOR STATE")
    assert content.endswith("# USER REQUEST\nFix it")

    assert compose_user_content("Fix it", "") == "Fix it"


def test_sse_stream_emits_frames_with_mocked_provider(monkeypatch):
    fake = FakeProvider(["Hello", " world"])
    monkeypatch.setattr(service, "get_provider", lambda provider_id: fake)

    persisted = {}

    async def fake_persist(**kwargs):
        persisted.update(kwargs)

    monkeypatch.setattr(service, "_persist_assistant_turn", fake_persist)

    async def run():
        frames = []
        async for frame in service.sse_stream(
            project_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            conversation_id=uuid.uuid4(),
            provider_id="fake",
            model="fake-1",
            system=[{"type": "text", "text": "sys"}],
            messages=[{"role": "user", "content": "hi"}],
        ):
            frames.append(frame)
        return frames

    frames = asyncio.run(run())
    assert frames[0].startswith("event: token")
    assert frames[0].endswith("\n\n")
    assert any(frame.startswith("event: done") for frame in frames)
    assert persisted["content"] == "Hello world"
    assert persisted["tokens_in"] == 11
    assert persisted["tokens_out"] == 3
    assert persisted["model"] == "fake-1"


def test_sse_stream_maps_provider_errors_to_error_event(monkeypatch):
    class ErrorProvider(FakeProvider):
        async def stream(self, *, model, system, messages, tools=None):
            raise ProviderError("upstream unavailable")
            yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(service, "get_provider", lambda provider_id: ErrorProvider([]))

    async def run():
        frames = []
        async for frame in service.sse_stream(
            project_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            conversation_id=uuid.uuid4(),
            provider_id="fake",
            model="fake-1",
            system=[{"type": "text", "text": "sys"}],
            messages=[{"role": "user", "content": "hi"}],
        ):
            frames.append(frame)
        return frames

    frames = asyncio.run(run())
    assert len(frames) == 1
    assert frames[0].startswith("event: error")
    assert "upstream unavailable" in frames[0]


def test_messages_endpoint_streams_sse_with_mocked_provider(monkeypatch):
    """Wire-level check of POST /ai/projects/{id}/messages (DB and provider mocked)."""
    project_id = uuid.uuid4()
    conversation_id = uuid.uuid4()
    project = SimpleNamespace(id=project_id, ai_enabled=True)
    user = SimpleNamespace(id=uuid.uuid4())

    async def fake_project_access(db, pid, _user, min_role="viewer"):
        assert pid == project_id
        return project

    monkeypatch.setattr(ai_router, "project_access", fake_project_access)

    async def fake_quota(db, user_id):
        return 0

    monkeypatch.setattr(service, "ensure_daily_quota", fake_quota)

    async def fake_conversation(db, **kwargs):
        return SimpleNamespace(id=conversation_id)

    monkeypatch.setattr(service, "get_or_create_conversation", fake_conversation)

    async def fake_history(db, cid):
        return []

    monkeypatch.setattr(service, "load_history", fake_history)

    async def fake_context(db, current_project, **kwargs):
        assert current_project is project
        return ContextBundle(project_block="PROJECT", volatile_block="STATE")

    monkeypatch.setattr(ai_router, "build_context", fake_context)

    async def fake_add_user_message(db, **kwargs):
        return None

    monkeypatch.setattr(service, "add_user_message", fake_add_user_message)

    seen = {}

    async def fake_stream(**kwargs):
        seen.update(kwargs)
        yield 'event: token\ndata: {"text":"hi"}\n\n'
        yield 'event: done\ndata: {"conversation_id":"x"}\n\n'

    monkeypatch.setattr(service, "sse_stream", fake_stream)

    app = FastAPI()
    app.include_router(ai_router.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: None

    with TestClient(app) as client:
        response = client.post(
            f"/api/v1/ai/projects/{project_id}/messages",
            json={
                "provider": "anthropic",
                "model": "claude-sonnet-5-5",
                "content": "hi",
                "context": {},
            },
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: token" in response.text
    assert "event: done" in response.text
    assert seen["conversation_id"] == conversation_id
    assert seen["messages"][-1]["content"].startswith("STATE")
    assert seen["messages"][-1]["content"].endswith("hi")

