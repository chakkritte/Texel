"""Redis-backed coordination for the collaboration service.

The Redis Stream is the durable, ordered log of updates for a document.  The
pub/sub channel is only a low-latency wake-up signal; consumers always re-read
the stream so a missed pub/sub message cannot lose an update.
"""

from __future__ import annotations

import json
from typing import Any

from app.collab import keys
from app.collab.protocol import b64encode

# KEYS[1] = seq counter, KEYS[2] = stream
# ARGV[1] = base64 update, ARGV[2] = client id, ARGV[3] = stream maxlen
_APPEND_UPDATE_LUA = """
local seq = redis.call('INCR', KEYS[1])
local id = tostring(seq) .. '-0'
redis.call(
  'XADD', KEYS[2], 'MAXLEN', '~', ARGV[3], id,
  'seq', seq, 'update', ARGV[1], 'client_id', ARGV[2]
)
return seq
"""


def _as_str(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _as_int(value: Any) -> int:
    try:
        return int(_as_str(value))
    except (TypeError, ValueError):
        return 0


class CollabStore:
    """Thin async wrapper around the Redis commands used by the service."""

    def __init__(self, redis: Any):
        self.redis = redis

    # ------------------------------------------------------------------ seq
    async def _last_stream_seq(self, doc_id: str) -> int:
        rows = await self.redis.xrevrange(keys.stream(doc_id), max="+", min="-", count=1)
        if not rows:
            return 0
        stream_id = _as_str(rows[0][0])
        return _as_int(stream_id.split("-", 1)[0])

    async def ensure_seq(self, doc_id: str, initial: int) -> int:
        """Make sure the per-doc seq counter exists and is >= ``initial``.

        The counter is normally initialised from ``documents.seq`` and grows
        atomically with every append.  Only when the key is missing (first use
        or after a Redis flush) do we consult the stream tail so a re-created
        counter can never hand out an id that already exists.
        """

        counter_key = keys.seq(doc_id)
        raw = await self.redis.get(counter_key)

        if raw is None:
            initial = max(int(initial or 0), await self._last_stream_seq(doc_id))
            await self.redis.set(counter_key, initial, nx=True)
            raw = await self.redis.get(counter_key)

        value = _as_int(raw)
        target = max(value, int(initial or 0))
        if target != value:
            # DB seq advanced (e.g. a Phase 1 save) since the counter was made.
            await self.redis.set(counter_key, target)
            value = target
        return value

    async def current_seq(self, doc_id: str, initial: int = 0) -> int:
        return await self.ensure_seq(doc_id, initial)

    async def next_seq(self, doc_id: str, initial: int = 0) -> int:
        await self.ensure_seq(doc_id, initial)
        return _as_int(await self.redis.incr(keys.seq(doc_id)))

    # --------------------------------------------------------------- dedupe
    async def get_dedupe(self, doc_id: str, client_id: str, client_seq: int) -> int | None:
        value = await self.redis.get(keys.dedupe(doc_id, client_id, client_seq))
        if value is None:
            return None
        return _as_int(value)

    async def set_dedupe(
        self, doc_id: str, client_id: str, client_seq: int, seq: int
    ) -> None:
        await self.redis.set(
            keys.dedupe(doc_id, client_id, client_seq),
            str(seq),
            ex=keys.DEDUPE_TTL_SECONDS,
        )

    # --------------------------------------------------------------- stream
    async def append_update(
        self, doc_id: str, seq: int, update: bytes, client_id: str = ""
    ) -> None:
        """Append an update with a caller-supplied seq (non-atomic helper).

        Production callers should use :meth:`append_update_atomic`, which keeps
        seq allocation and stream order consistent across service instances.
        """

        await self.redis.xadd(
            keys.stream(doc_id),
            {"seq": str(seq), "update": b64encode(update), "client_id": client_id},
            id=f"{seq}-0",
            maxlen=keys.STREAM_MAXLEN,
            approximate=True,
        )

    async def append_update_atomic(
        self, doc_id: str, update: bytes, client_id: str, initial_seq: int = 0
    ) -> int:
        """Allocate the next seq and append the update in one atomic script.

        Atomicity matters: it guarantees that stream entry ``N`` is written
        before seq ``N+1`` is handed out, so ``GET /poll?after=N`` can never
        skip an update when several service instances are running.
        """

        await self.ensure_seq(doc_id, initial_seq)
        result = await self.redis.eval(
            _APPEND_UPDATE_LUA,
            2,
            keys.seq(doc_id),
            keys.stream(doc_id),
            b64encode(update),
            client_id,
            str(keys.STREAM_MAXLEN),
        )
        return _as_int(result)

    async def read_updates(
        self, doc_id: str, after: int, limit: int = 500
    ) -> list[dict[str, Any]]:
        if after < 0:
            after = 0
        rows = await self.redis.xrange(
            keys.stream(doc_id),
            min=f"{after + 1}-0",
            max="+",
            count=limit,
        )
        out: list[dict[str, Any]] = []
        for stream_id, fields in rows:
            stream_id_str = _as_str(stream_id)
            seq = _as_int(
                fields.get(b"seq", fields.get("seq", stream_id_str.split("-", 1)[0]))
            )
            update = fields.get(b"update", fields.get("update", b""))
            out.append({"seq": seq, "update": _as_str(update)})
        return out

    # ------------------------------------------------------------ awareness
    async def set_awareness(self, doc_id: str, client_id: str, update_b64: str) -> int:
        await self.redis.set(
            keys.awareness(doc_id, client_id),
            update_b64,
            ex=keys.AWARENESS_TTL_SECONDS,
        )
        return _as_int(await self.redis.incr(keys.awareness_version(doc_id)))

    async def get_awareness(self, doc_id: str) -> list[str]:
        pattern = keys.awareness_pattern(doc_id)
        redis_keys = [k async for k in self.redis.scan_iter(match=pattern, count=100)]
        if not redis_keys:
            return []
        values = await self.redis.mget(redis_keys)
        return [_as_str(v) for v in values if v]

    async def awareness_version(self, doc_id: str) -> int:
        return _as_int(await self.redis.get(keys.awareness_version(doc_id)))

    # ------------------------------------------------------------- pub/sub
    async def publish_update(self, doc_id: str, seq: int, update: bytes) -> None:
        payload = {
            "type": "update",
            "seq": seq,
            "update": b64encode(update),
        }
        await self.redis.publish(keys.events_channel(doc_id), json.dumps(payload))

    async def publish_awareness(self, doc_id: str, version: int) -> None:
        payload = {"type": "awareness", "version": version}
        await self.redis.publish(keys.events_channel(doc_id), json.dumps(payload))

    # ---------------------------------------------------------------- misc
    async def ping(self) -> bool:
        await self.redis.ping()
        return True
