"""In-memory document registry + lifecycle for the collab service.

Design notes
------------
* One :class:`DocState` (a pycrdt ``Doc`` plus metadata/locks) exists per open
  document *per service instance*.
* Updates are fan-out to other instances through a Redis Stream (durable) and a
  pub/sub channel (low latency wake-up).  Applying a Yjs update twice is a
  no-op, so replay/duplication is safe.
* Sequence numbers are allocated atomically together with the stream append
  (Lua script), so stream order always matches ``seq`` order.  That is what
  makes ``GET /poll?after=<seq>`` lossless.
* Dirty documents are flushed to Postgres every 5 seconds, when the last
  tracked client disappears, when the document is unloaded (10 min idle) and on
  shutdown.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import update

from app.collab import keys, protocol
from app.collab.store import CollabStore
from app.db import SessionLocal
from app.models import Document, File

log = logging.getLogger("app.collab.manager")

#: Unload documents with no requests for this long (plan: 10 minutes).
IDLE_UNLOAD_SECONDS = 600.0

#: How long a client is considered connected after its last request.
CLIENT_TTL_SECONDS = 75.0

#: Safety valve: avoid unbounded memory if many documents are opened.
MAX_OPEN_DOCS = 256

#: How often dirty documents are persisted.
FLUSH_INTERVAL_SECONDS = 5.0

#: Lifetime of the shared bootstrap CRDT snapshot (24 h).  The database
#: snapshot supersedes it after the first flush.
INIT_STATE_TTL_SECONDS = 86_400


@dataclass
class DocSnapshot:
    """Everything the manager needs from the database to open a document."""

    document_id: uuid.UUID
    file_id: uuid.UUID
    project_id: uuid.UUID
    role: str
    content: str
    ydoc_state: bytes | None
    seq: int
    user_id: uuid.UUID


@dataclass
class DocState:
    snapshot: DocSnapshot
    doc: Any
    base_update: bytes | None
    seq: int = 0
    dirty: bool = False
    last_active: float = field(default_factory=time.monotonic)
    clients: dict[str, float] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    flush_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    listener_task: asyncio.Task | None = None
    ws_queues: set[asyncio.Queue] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.seq = max(int(self.snapshot.seq or 0), 0)

    @property
    def id(self) -> str:
        return str(self.snapshot.document_id)

    @property
    def role(self) -> str:
        return self.snapshot.role

    # ------------------------------------------------------------- activity
    def touch(self, client_id: str | None = None) -> None:
        now = time.monotonic()
        self.last_active = now
        if client_id:
            self.clients[client_id] = now

    def expire_clients(self, ttl: float = CLIENT_TTL_SECONDS) -> list[str]:
        cutoff = time.monotonic() - ttl
        expired = [cid for cid, seen in self.clients.items() if seen < cutoff]
        for cid in expired:
            self.clients.pop(cid, None)
        return expired

    # ---------------------------------------------------------- doc mutation
    def apply_raw(self, raw: bytes, origin: str = "remote") -> None:
        del origin  # pycrdt updates are origin-independent
        protocol.apply_update(self.doc, raw)

    def text(self) -> str:
        return protocol.doc_text(self.doc)

    def size(self) -> int:
        return protocol.text_size(self.doc)

    def restore(self) -> None:
        """Roll back to the last persisted snapshot (used for oversize updates)."""

        self.doc = protocol.restore_doc(self.base_update)
        self.dirty = True

    # ------------------------------------------------------------ signalling
    async def notify(self) -> None:
        async with self.condition:
            self.condition.notify_all()

    def broadcast(self, message: dict[str, Any]) -> None:
        for queue in list(self.ws_queues):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # Slow WebSocket consumer: dropping is fine, it can re-sync.
                log.debug("dropping WS message for doc %s (queue full)", self.id)


class CollabManager:
    def __init__(self, redis: Any):
        self.redis = redis
        self.store = CollabStore(redis)
        self.docs: dict[str, DocState] = {}
        self._load_lock = asyncio.Lock()
        self._maintenance_task: asyncio.Task | None = None
        self._closing = False

    # ------------------------------------------------------------- lifecycle
    def start(self) -> None:
        if self._maintenance_task is None:
            self._maintenance_task = asyncio.create_task(
                self._maintenance_loop(), name="collab-maintenance"
            )

    async def close(self) -> None:
        self._closing = True
        if self._maintenance_task is not None:
            self._maintenance_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._maintenance_task
            self._maintenance_task = None

        for state in list(self.docs.values()):
            await self._stop_listener(state)
            with contextlib.suppress(Exception):
                await self.flush(state)
        self.docs.clear()

    async def _maintenance_loop(self) -> None:
        while not self._closing:
            try:
                await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
                await self.flush_dirty()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("collab flush cycle failed")
            try:
                await self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("collab sweep failed")

    # ---------------------------------------------------------------- loading
    async def _build_initial_doc(self, snapshot: DocSnapshot):
        """Create the local pycrdt Doc, sharing the bootstrap snapshot.

        ``documents.ydoc_state`` is authoritative when present.  Otherwise the
        first instance to open the document publishes the CRDT state derived
        from ``documents.content`` to Redis (``collab:init:<doc>``) and every
        other instance adopts exactly that state.  Without this, two instances
        would seed Y.Text independently and could not merge each other's
        updates before the first Postgres flush.
        """

        if snapshot.ydoc_state:
            return protocol.init_doc(snapshot.ydoc_state, snapshot.content)

        init_key = keys.init_state(str(snapshot.document_id))
        try:
            stored = await self.redis.get(init_key)
        except Exception:
            stored = None
            log.warning("could not read collab init state for %s", snapshot.document_id, exc_info=True)

        if stored:
            doc = protocol.restore_doc(protocol.b64decode(stored))
            return doc, doc.get_update()

        doc, base_update = protocol.init_doc(None, snapshot.content)
        try:
            won = await self.redis.set(
                init_key,
                protocol.b64encode(base_update),
                nx=True,
                ex=INIT_STATE_TTL_SECONDS,
            )
            if not won:
                stored = await self.redis.get(init_key)
                if stored:
                    doc = protocol.restore_doc(protocol.b64decode(stored))
                    base_update = doc.get_update()
        except Exception:
            # Redis being unavailable will fail the request later anyway; a
            # local-only bootstrap is still safer than aborting the sync.
            log.warning("could not publish collab init state for %s", snapshot.document_id, exc_info=True)

        return doc, base_update

    async def get_or_load(self, snapshot: DocSnapshot) -> DocState:
        key = str(snapshot.document_id)
        async with self._load_lock:
            existing = self.docs.get(key)
            if existing is not None:
                existing.touch()
                return existing

            doc, base_update = await self._build_initial_doc(snapshot)
            state = DocState(snapshot=snapshot, doc=doc, base_update=base_update)
            # If the DB has no CRDT snapshot yet, persist the bootstrap state
            # on the next flush cycle.  This narrows the window in which a
            # restart would have to re-derive history from plain text.
            if snapshot.ydoc_state is None:
                state.dirty = True

            try:
                await self.store.ensure_seq(state.id, state.seq)
            except Exception:
                log.exception("could not initialise seq for doc %s", state.id)
                raise

            # Replay stream entries newer than the persisted snapshot.  This
            # covers updates that were broadcast while this document was not
            # loaded (another instance handled them).
            try:
                entries = await self.store.read_updates(
                    state.id, state.seq, limit=keys.STREAM_MAXLEN
                )
                for entry in entries:
                    try:
                        state.apply_raw(protocol.b64decode(entry["update"]))
                    except protocol.InvalidUpdate:
                        log.warning("skipping corrupt stream update %s", entry.get("seq"))
                        continue
                    state.seq = max(state.seq, int(entry["seq"]))
                    # Replayed updates may not be in Postgres yet (another
                    # instance handled them and has not flushed).  Persist the
                    # merged state locally so durability does not depend on the
                    # other instance.
                    state.dirty = True
            except Exception:
                log.exception("could not replay stream for doc %s", state.id)

            self.docs[key] = state
            self._start_listener(state)

            await self._enforce_open_doc_limit()
            return state

    async def catch_up(self, state: DocState) -> None:
        """Apply stream entries newer than the locally applied ``seq``."""

        async with state.lock:
            entries = await self.store.read_updates(
                state.id, state.seq, limit=keys.STREAM_MAXLEN
            )
            applied = False
            for entry in entries:
                try:
                    state.apply_raw(protocol.b64decode(entry["update"]))
                except protocol.InvalidUpdate:
                    continue
                state.seq = max(state.seq, int(entry["seq"]))
                applied = True
            if applied:
                state.dirty = True

    # ---------------------------------------------------------------- updates
    async def ingest_update(
        self, state: DocState, client_id: str, client_seq: int, update_b64: str
    ) -> int:
        """Validate, apply, allocate a seq and fan out a client update."""

        raw = protocol.b64decode(update_b64)
        if len(raw) > protocol.MAX_DOC_BYTES:
            raise protocol.DocTooLarge("update exceeds document size limit")

        # Make sure we are not missing earlier updates before assigning a seq.
        await self.catch_up(state)

        async with state.lock:
            previous = await self.store.get_dedupe(state.id, client_id, client_seq)
            if previous is not None:
                state.touch(client_id)
                return previous

            before = state.seq
            try:
                state.apply_raw(raw)
            except protocol.InvalidUpdate:
                state.restore()
                raise
            if state.size() > protocol.MAX_DOC_BYTES:
                state.restore()
                raise protocol.DocTooLarge("document exceeds size limit")

            # Atomic INCR+XADD: stream order matches seq order even with
            # multiple service instances.
            seq = await self.store.append_update_atomic(state.id, raw, client_id, before)
            await self.store.set_dedupe(state.id, client_id, client_seq, seq)

            # Apply any entries that were appended by other instances between
            # our catch_up and the allocation (our own update is included; Yjs
            # de-duplicates it).
            try:
                gap_limit = min(max(seq - before + 1, 1), keys.STREAM_MAXLEN)
                entries = await self.store.read_updates(state.id, before, limit=gap_limit)
                for entry in entries:
                    if int(entry["seq"]) <= before:
                        continue
                    try:
                        state.apply_raw(protocol.b64decode(entry["update"]))
                    except protocol.InvalidUpdate:
                        continue
                    state.seq = max(state.seq, int(entry["seq"]))
            except Exception:
                log.exception("post-append catch-up failed for doc %s", state.id)

            state.seq = max(state.seq, seq)
            state.dirty = True
            state.touch(client_id)

            try:
                await self.store.publish_update(state.id, seq, raw)
            except Exception:
                # Pub/sub is best-effort; the stream is authoritative and the
                # long-poll loop re-checks it periodically.
                log.warning("pub/sub failed for doc %s", state.id, exc_info=True)

            state.broadcast({"type": "update", "seq": seq, "update": protocol.b64encode(raw)})
            await state.notify()
            return seq

    async def ingest_awareness(
        self, state: DocState, client_id: str, update_b64: str
    ) -> int:
        if len(update_b64) > 64 * 1024:
            raise protocol.InvalidUpdate("awareness update too large")
        # Validate the framing early so garbage never reaches other clients.
        protocol.b64decode(update_b64)
        version = await self.store.set_awareness(state.id, client_id, update_b64)
        try:
            await self.store.publish_awareness(state.id, version)
        except Exception:
            log.warning("awareness pub/sub failed for doc %s", state.id, exc_info=True)

        awareness = await self.store.get_awareness(state.id)
        state.touch(client_id)
        state.broadcast({"type": "awareness", "awareness": awareness})
        await state.notify()
        return version

    # ------------------------------------------------------------ persistence
    async def flush(self, state: DocState) -> None:
        async with state.flush_lock:
            if not state.dirty:
                return
            captured_seq = state.seq
            update_bytes = state.doc.get_update()
            text = state.text()
            size = len(text.encode("utf-8"))

            async with SessionLocal() as db:
                result = await db.execute(
                    update(Document)
                    .where(Document.id == state.snapshot.document_id, Document.seq <= captured_seq)
                    .values(
                        ydoc_state=update_bytes,
                        content=text,
                        seq=captured_seq,
                    )
                )
                if result.rowcount:
                    await db.execute(
                        update(File)
                        .where(File.id == state.snapshot.file_id)
                        .values(size=size)
                    )
                await db.commit()

            # Only advance the rollback snapshot / clear the dirty flag if no
            # update landed while the DB round-trip was in flight.  Otherwise
            # the next flush cycle will capture the newer state.
            if state.seq == captured_seq:
                state.base_update = update_bytes
                state.dirty = False

    async def flush_dirty(self) -> None:
        for state in list(self.docs.values()):
            if state.dirty:
                try:
                    await self.flush(state)
                except Exception:
                    log.exception("failed to flush doc %s", state.id)

    async def flush_doc(self, state: DocState) -> None:
        state.dirty = True
        await self.flush(state)

    # ---------------------------------------------------------------- sweeping
    async def sweep(self) -> None:
        now = time.monotonic()
        for state in list(self.docs.values()):
            expired = state.expire_clients()
            if expired and not state.clients and state.dirty:
                # Best-effort "last client disconnected" flush.
                await self.flush(state)

            idle = now - state.last_active
            if (
                idle > IDLE_UNLOAD_SECONDS
                and not state.clients
                and not state.lock.locked()
                and state.listener_task is not None
            ):
                log.info("unloading idle doc %s (idle %.0fs)", state.id, idle)
                if state.dirty:
                    await self.flush(state)
                await self._stop_listener(state)
                self.docs.pop(state.id, None)

    async def _enforce_open_doc_limit(self) -> None:
        if len(self.docs) <= MAX_OPEN_DOCS:
            return
        candidates = sorted(
            (
                s
                for s in self.docs.values()
                if not s.clients and not s.lock.locked() and s.listener_task is not None
            ),
            key=lambda s: s.last_active,
        )
        while len(self.docs) > MAX_OPEN_DOCS and candidates:
            victim = candidates.pop(0)
            if victim.dirty:
                await self.flush(victim)
            await self._stop_listener(victim)
            self.docs.pop(victim.id, None)

    # ------------------------------------------------------------- pub/sub fanout
    def _start_listener(self, state: DocState) -> None:
        if state.listener_task is None:
            state.listener_task = asyncio.create_task(
                self._listen_forever(state), name=f"collab-listen-{state.id}"
            )

    async def _stop_listener(self, state: DocState) -> None:
        task = state.listener_task
        state.listener_task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _listen_forever(self, state: DocState) -> None:
        while not self._closing:
            pubsub = None
            try:
                pubsub = self.redis.pubsub()
                await pubsub.subscribe(keys.events_channel(state.id))
                async for message in pubsub.listen():
                    if self._closing:
                        break
                    if message.get("type") != "message":
                        continue
                    await self._handle_event(state, message.get("data"))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("redis listener for doc %s failed; retrying", state.id, exc_info=True)
                await asyncio.sleep(1.0)
            finally:
                if pubsub is not None:
                    with contextlib.suppress(Exception):
                        aclose = getattr(pubsub, "aclose", None)
                        if aclose is not None:
                            await aclose()
                        else:  # pragma: no cover - older redis-py
                            await pubsub.close()

    async def _handle_event(self, state: DocState, data: Any) -> None:
        try:
            if isinstance(data, bytes):
                data = data.decode("utf-8")
            event = json.loads(data)
        except (TypeError, ValueError):
            return

        kind = event.get("type")
        if kind == "update":
            try:
                raw = protocol.b64decode(event.get("update", ""))
                state.apply_raw(raw)
                seq = int(event.get("seq") or 0)
            except (protocol.InvalidUpdate, TypeError, ValueError):
                return
            state.seq = max(state.seq, seq)
            state.dirty = True
            state.broadcast(
                {"type": "update", "seq": seq, "update": event.get("update", "")}
            )
            await state.notify()
        elif kind == "awareness":
            awareness = await self.store.get_awareness(state.id)
            state.broadcast({"type": "awareness", "awareness": awareness})
            await state.notify()
