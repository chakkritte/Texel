"""Unit tests for document bootstrap coordination (no Redis/Postgres needed).

The key invariant: two service instances opening the same document from Phase 1
plain text must share the *same* CRDT history, otherwise their Yjs updates
cannot merge.
"""

from __future__ import annotations

import unittest
import uuid

from pycrdt import Text

from app.collab import protocol
from app.collab.manager import CollabManager, DocSnapshot


class BootstrapFakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return None
        self.values[key] = str(value)
        return True


def _snapshot(content: str, ydoc_state: bytes | None = None, seq: int = 0) -> DocSnapshot:
    return DocSnapshot(
        document_id=uuid.uuid4(),
        file_id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        role="editor",
        content=content,
        ydoc_state=ydoc_state,
        seq=seq,
        user_id=uuid.uuid4(),
    )


class BootstrapTests(unittest.IsolatedAsyncioTestCase):
    async def test_instances_share_bootstrap_history(self):
        redis = BootstrapFakeRedis()
        manager = CollabManager(redis)
        snapshot = _snapshot("hello ")

        doc_a, base_a = await manager._build_initial_doc(snapshot)
        doc_b, base_b = await manager._build_initial_doc(snapshot)

        self.assertEqual(protocol.doc_text(doc_a), "hello ")
        self.assertEqual(protocol.doc_text(doc_b), "hello ")
        # Same client id / item ids: state vectors match exactly.
        self.assertEqual(doc_a.get_state(), doc_b.get_state())
        self.assertEqual(base_a, base_b)

        # A client synced from instance A can have its delta applied on B.
        client = protocol.restore_doc(base_a)
        state_vector = client.get_state()
        protocol.get_text(client).insert(6, "world")
        delta = client.get_update(state_vector)
        doc_b.apply_update(delta)
        self.assertEqual(protocol.doc_text(doc_b), "hello world")

    async def test_ydoc_state_wins_over_plain_text_and_init_key(self):
        redis = BootstrapFakeRedis()
        manager = CollabManager(redis)

        persisted, _ = protocol.init_doc(None, "persisted ")
        snapshot = _snapshot("stale plain text", ydoc_state=persisted.get_update())

        doc, _ = await manager._build_initial_doc(snapshot)
        self.assertEqual(protocol.doc_text(doc), "persisted ")
        # The init key must not even be consulted for persisted documents.
        self.assertEqual(redis.values, {})

    async def test_empty_document_bootstrap(self):
        redis = BootstrapFakeRedis()
        manager = CollabManager(redis)
        doc, base = await manager._build_initial_doc(_snapshot(""))
        self.assertEqual(protocol.doc_text(doc), "")
        self.assertEqual(base, protocol.EMPTY_UPDATE)

    async def test_restore_after_oversize_is_last_snapshot(self):
        from app.collab.manager import DocState

        doc, base = protocol.init_doc(None, "safe")
        state = DocState(snapshot=_snapshot("safe"), doc=doc, base_update=base)
        protocol.get_text(state.doc).insert(4, " but now different")
        state.restore()
        self.assertEqual(state.text(), "safe")


if __name__ == "__main__":
    unittest.main()
