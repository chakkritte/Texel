"""Standalone ASGI application for Phase 2 real-time collaboration.

Run with::

    uvicorn app.collab.main:app --host 0.0.0.0 --port 8000

All routes live under ``/collab/v1`` so the edge proxy can map
``/studio/collab/`` -> ``http://127.0.0.1:9001/collab/`` (prefix preserved by
nginx's ``proxy_pass`` URI) without touching the main API app.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import uuid
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import (
    APIRouter,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware

from app.collab import protocol
from app.collab.auth import ROLE_LEVEL, resolve_doc_access
from app.collab.manager import CollabManager
from app.collab.schemas import (
    AwarenessIn,
    FlushOut,
    PollOut,
    PollUpdate,
    SyncOut,
    UpdateIn,
    UpdateOut,
)
from app.core.config import settings
from app.db import engine, ensure_schema

log = logging.getLogger("app.collab")

#: Maximum long-poll hold time accepted from a client.  The edge proxy uses a
#: 75 s read timeout, so 25 s (the plan's value) leaves plenty of head-room.
MAX_POLL_TIMEOUT = 60.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis = aioredis.from_url(settings.redis_url, decode_responses=False)
    manager = CollabManager(redis)
    app.state.redis = redis
    app.state.manager = manager

    try:
        await redis.ping()
    except Exception:
        log.warning("Redis is not reachable at startup; collab requests will fail", exc_info=True)

    # The API usually creates the tables first; suppress failures so a fresh
    # database started in parallel does not take the collab service down.
    with contextlib.suppress(Exception):
        await ensure_schema()

    manager.start()
    try:
        yield
    finally:
        await manager.close()
        with contextlib.suppress(Exception):
            await redis.aclose()
        # This process owns its copy of the global engine; release its pool.
        with contextlib.suppress(Exception):
            await engine.dispose()


app = FastAPI(
    title="SGtech LaTeX Studio — Collaboration",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

router = APIRouter(prefix="/collab/v1", tags=["collab"])


# --------------------------------------------------------------------- helpers
def _manager(request: Request) -> CollabManager:
    return request.app.state.manager


def _authorization(request: Request) -> str | None:
    return request.headers.get("authorization")


async def _access(
    doc_id: uuid.UUID, request: Request, min_role: str = "viewer"
):
    return await resolve_doc_access(
        doc_id,
        authorization=_authorization(request),
        min_role=min_role,
    )


async def _state(manager: CollabManager, access):
    try:
        return await manager.get_or_load(access)
    except protocol.DocTooLarge as exc:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(exc))


# ----------------------------------------------------------------------- sync
@router.get("/doc/{doc_id}/sync", response_model=SyncOut)
async def sync_doc(
    doc_id: uuid.UUID,
    request: Request,
    sv: str | None = None,
    client_id: str | None = None,
):
    access = await _access(doc_id, request)
    manager = _manager(request)
    state = await _state(manager, access)
    state.touch(client_id)
    await manager.catch_up(state)

    async with state.lock:
        seq = state.seq
        try:
            update = protocol.update_for_state_vector(state.doc, sv)
        except protocol.InvalidUpdate as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
        awareness = await manager.store.get_awareness(state.id)

    return SyncOut(seq=seq, update=update, awareness=awareness)


# --------------------------------------------------------------------- update
@router.post("/doc/{doc_id}/update", response_model=UpdateOut)
async def post_update(doc_id: uuid.UUID, body: UpdateIn, request: Request):
    access = await _access(doc_id, request, "editor")
    manager = _manager(request)
    state = await _state(manager, access)
    try:
        seq = await manager.ingest_update(
            state, body.client_id, body.client_seq, body.update
        )
    except protocol.InvalidUpdate as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except protocol.DocTooLarge as exc:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(exc))
    return UpdateOut(seq=seq)


# ----------------------------------------------------------------------- poll
@router.get("/doc/{doc_id}/poll", response_model=PollOut)
async def poll_doc(
    doc_id: uuid.UUID,
    request: Request,
    after: int = 0,
    timeout: float = 25.0,
    client_id: str | None = None,
):
    access = await _access(doc_id, request)
    manager = _manager(request)
    state = await _state(manager, access)
    state.touch(client_id)

    after = max(0, int(after))
    timeout = float(timeout)
    if not math.isfinite(timeout):
        timeout = 25.0
    timeout = min(max(timeout, 0.0), MAX_POLL_TIMEOUT)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    start_awareness = await manager.store.awareness_version(state.id)

    while True:
        entries = await manager.store.read_updates(state.id, after, limit=500)
        if entries:
            dirty = False
            async with state.lock:
                for entry in entries:
                    if int(entry["seq"]) > state.seq:
                        try:
                            state.apply_raw(protocol.b64decode(entry["update"]))
                            dirty = True
                        except protocol.InvalidUpdate:
                            continue
                        state.seq = max(state.seq, int(entry["seq"]))
                if dirty:
                    state.dirty = True
                seq = max(state.seq, int(entries[-1]["seq"]))
            awareness = await manager.store.get_awareness(state.id)
            return PollOut(
                seq=seq,
                updates=[
                    PollUpdate(seq=int(e["seq"]), update=e["update"]) for e in entries
                ],
                awareness=awareness,
            )

        awareness_version = await manager.store.awareness_version(state.id)
        if awareness_version != start_awareness:
            awareness = await manager.store.get_awareness(state.id)
            return PollOut(seq=state.seq, updates=[], awareness=awareness)

        remaining = deadline - loop.time()
        if remaining <= 0:
            return Response(status_code=status.HTTP_204_NO_CONTENT)

        try:
            async with state.condition:
                await asyncio.wait_for(state.condition.wait(), timeout=min(remaining, 5.0))
        except asyncio.TimeoutError:
            # Another instance may have appended to the stream without us
            # receiving pub/sub; loop around and re-check.
            pass


# ------------------------------------------------------------------ awareness
@router.post(
    "/doc/{doc_id}/awareness",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def post_awareness(doc_id: uuid.UUID, body: AwarenessIn, request: Request):
    # Presence is allowed for every project role, including viewers.
    access = await _access(doc_id, request, "viewer")
    manager = _manager(request)
    state = await _state(manager, access)
    try:
        await manager.ingest_awareness(state, body.client_id, body.update)
    except protocol.InvalidUpdate as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------- flush
@router.post("/doc/{doc_id}/flush", response_model=FlushOut)
async def flush_doc(doc_id: uuid.UUID, request: Request):
    """Force a persistence flush (e.g. right before requesting a compile)."""

    access = await _access(doc_id, request, "editor")
    manager = _manager(request)
    state = await _state(manager, access)
    await manager.flush_doc(state)
    return FlushOut(seq=state.seq)


# ------------------------------------------------------------------- websocket
@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    doc_id: uuid.UUID,
    token: str | None = None,
    sv: str | None = None,
):
    """Optional WebSocket transport using the same JSON framing as HTTP.

    WebSocket is opportunistic only: the HTTP provider must keep working when
    the network path (gw-22) does not forward upgrades.
    """

    try:
        access = await resolve_doc_access(doc_id, token_query=token, min_role="viewer")
    except HTTPException as exc:
        await websocket.close(
            code=4401 if exc.status_code == status.HTTP_401_UNAUTHORIZED else 4403
        )
        return
    except Exception:
        log.exception("websocket auth failed for doc %s", doc_id)
        with contextlib.suppress(Exception):
            await websocket.close(code=1011)
        return

    await websocket.accept()
    manager: CollabManager = websocket.app.state.manager
    state = None
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    sender_task: asyncio.Task | None = None
    send_lock = asyncio.Lock()

    async def send(payload: dict) -> None:
        # Starlette does not serialise concurrent sends; the sender task and the
        # request loop both write to this socket, so guard them.
        async with send_lock:
            await websocket.send_json(payload)

    try:
        state = await _state(manager, access)
        state.touch()

        state.ws_queues.add(queue)

        await manager.catch_up(state)
        async with state.lock:
            update = protocol.update_for_state_vector(state.doc, sv)
            seq = state.seq
        awareness = await manager.store.get_awareness(state.id)
        await send({"type": "sync", "seq": seq, "update": update, "awareness": awareness})

        async def sender() -> None:
            while True:
                message = await queue.get()
                await send(message)

        sender_task = asyncio.create_task(sender())

        while True:
            message = await websocket.receive_json()
            kind = message.get("type") if isinstance(message, dict) else None

            if kind == "update":
                if ROLE_LEVEL.get(state.role, 0) < ROLE_LEVEL["editor"]:
                    await send({"type": "error", "error": "insufficient project role"})
                    continue
                try:
                    ack_seq = await manager.ingest_update(
                        state,
                        str(message.get("client_id", "")),
                        int(message.get("client_seq", 0)),
                        str(message.get("update", "")),
                    )
                except protocol.DocTooLarge as exc:
                    await send({"type": "error", "error": str(exc)})
                except (protocol.InvalidUpdate, ValueError) as exc:
                    await send({"type": "error", "error": str(exc)})
                else:
                    await send({"type": "ack", "seq": ack_seq})

            elif kind == "awareness":
                try:
                    await manager.ingest_awareness(
                        state,
                        str(message.get("client_id", "")),
                        str(message.get("update", "")),
                    )
                    await send({"type": "ack"})
                except protocol.InvalidUpdate as exc:
                    await send({"type": "error", "error": str(exc)})

            elif kind == "ping":
                await send({"type": "pong"})

    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("websocket error for doc %s", doc_id)
        with contextlib.suppress(Exception):
            await websocket.close()
    finally:
        if state is not None:
            state.ws_queues.discard(queue)
        if sender_task is not None:
            sender_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await sender_task


# ---------------------------------------------------------------------- misc
@router.get("/healthz")
async def healthz(request: Request):
    try:
        await request.app.state.redis.ping()
    except Exception as exc:  # pragma: no cover - operational path
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "redis unavailable") from exc
    return {"status": "ok", "redis": "ok"}


app.include_router(router)


@app.get("/healthz")
async def root_healthz():
    return {"status": "ok"}
