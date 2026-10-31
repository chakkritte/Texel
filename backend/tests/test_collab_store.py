"""Unit tests for the Redis store logic using an in-memory fake.

These exercise the parts that do not need a real Redis server: seq allocation,
dedupe, stream reads, awareness versioning and the atomic append wrapper.

The ``FakeRedis.eval`` implementation simulates only the fixed Lua script in
``app.collab.store``; it is not a general Lua interpreter.
"""

from __future__ import annotations

import fnmatch
import unittest

from app.collab import keys
from app.collab.store import CollabStore


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.published: list[tuple[str, str]] = []

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return None
        self.values[key] = str(value)
        return True

    async def get(self, key):
        return self.values.get(key)

    async def incr(self, key):
        value = int(self.values.get(key, 0)) + 1
        self.values[key] = str(value)
        return value

    async def xadd(self, name, fields, id="*", maxlen=None, approximate=True):
        stream = self.streams.setdefault(name, [])
        stream.append((str(id), {str(k): str(v) for k, v in fields.items()}))
        stream.sort(key=lambda row: int(row[0].split("-")[0]))
        return str(id)

    async def xrange(self, name, min="-", max="+", count=None):
        low = int(str(min).split("-")[0]) if min not in ("-", None) else -1
        high = int(str(max).split("-")[0]) if max not in ("+", None) else 2**63 - 1
        rows = [
            row
            for row in self.streams.get(name, [])
            if low <= int(row[0].split("-")[0]) <= high
        ]
        return rows[:count] if count else rows

    async def xrevrange(self, name, max="+", min="-", count=None):
        rows = list(reversed(self.streams.get(name, [])))
        return rows[:count] if count else rows

    async def scan_iter(self, match=None, count=None):
        for key in list(self.values):
            if match is None or fnmatch.fnmatch(key, match):
                yield key

    async def mget(self, redis_keys):
        return [self.values.get(key) for key in redis_keys]

    async def publish(self, channel, payload):
        self.published.append((channel, payload))
        return 1

    async def ping(self):
        return True

    async def eval(self, script, numkeys, *args):
        # Simulates store._APPEND_UPDATE_LUA for unit tests.
        self.assert_numkeys = numkeys
        seq_key, stream_key, update, client_id, maxlen = args
        seq = await self.incr(seq_key)
        await self.xadd(
            stream_key,
            {"seq": seq, "update": update, "client_id": client_id},
            id=f"{seq}-0",
            maxlen=maxlen,
        )
        return seq


class StoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.redis = FakeRedis()
        self.store = CollabStore(self.redis)
        self.doc_id = "doc-1"

    async def test_next_seq_starts_after_db_seq(self):
        self.assertEqual(await self.store.next_seq(self.doc_id, initial=41), 42)
        self.assertEqual(await self.store.next_seq(self.doc_id, initial=41), 43)

    async def test_ensure_seq_accounts_for_stream_tail(self):
        # A stream entry exists but the counter key was lost (e.g. Redis flush).
        await self.store.append_update(self.doc_id, 10, b"\x00\x00")
        self.assertEqual(await self.store.next_seq(self.doc_id, initial=0), 11)

    async def test_dedupe(self):
        self.assertIsNone(await self.store.get_dedupe(self.doc_id, "client-a", 7))
        await self.store.set_dedupe(self.doc_id, "client-a", 7, 99)
        self.assertEqual(await self.store.get_dedupe(self.doc_id, "client-a", 7), 99)
        # Different client or client_seq is a different key.
        self.assertIsNone(await self.store.get_dedupe(self.doc_id, "client-a", 8))
        self.assertIsNone(await self.store.get_dedupe(self.doc_id, "client-b", 7))

    async def test_dedupe_key_format(self):
        key = keys.dedupe(self.doc_id, "client-a", 7)
        self.assertEqual(key, "collab:dedupe:doc-1:client-a:7")

    async def test_append_atomic_and_read(self):
        import base64

        first = await self.store.append_update_atomic(self.doc_id, b"aaa", "c1", 0)
        second = await self.store.append_update_atomic(self.doc_id, b"bbb", "c2", 0)
        self.assertEqual((first, second), (1, 2))

        updates = await self.store.read_updates(self.doc_id, 0)
        self.assertEqual([u["seq"] for u in updates], [1, 2])
        self.assertEqual(
            [base64.b64decode(u["update"]) for u in updates], [b"aaa", b"bbb"]
        )

        # `after` is exclusive.
        after_first = await self.store.read_updates(self.doc_id, 1)
        self.assertEqual([u["seq"] for u in after_first], [2])

    async def test_read_updates_empty(self):
        self.assertEqual(await self.store.read_updates(self.doc_id, 0), [])

    async def test_awareness(self):
        self.assertEqual(await self.store.awareness_version(self.doc_id), 0)
        version = await self.store.set_awareness(self.doc_id, "client-a", "b64-data")
        self.assertEqual(version, 1)
        self.assertEqual(await self.store.awareness_version(self.doc_id), 1)
        self.assertEqual(await self.store.get_awareness(self.doc_id), ["b64-data"])

        await self.store.set_awareness(self.doc_id, "client-b", "b64-other")
        self.assertEqual(
            sorted(await self.store.get_awareness(self.doc_id)),
            ["b64-data", "b64-other"],
        )

    async def test_publish_payload(self):
        import json

        await self.store.publish_update(self.doc_id, 5, b"xyz")
        channel, payload = self.redis.published[-1]
        self.assertEqual(channel, keys.events_channel(self.doc_id))
        decoded = json.loads(payload)
        self.assertEqual(decoded["type"], "update")
        self.assertEqual(decoded["seq"], 5)

    async def test_ping(self):
        self.assertTrue(await self.store.ping())


if __name__ == "__main__":
    unittest.main()
