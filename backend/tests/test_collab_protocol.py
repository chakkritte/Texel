"""Unit tests for pure CRDT/protocol helpers (no Redis or Postgres needed).

Run with either::

    cd backend && python -m unittest discover -s tests -p 'test_collab_*.py'
    cd backend && python -m pytest tests/test_collab_protocol.py
"""

from __future__ import annotations

import unittest

from pycrdt import Doc, Text

from app.collab import protocol


class Base64Tests(unittest.TestCase):
    def test_round_trip(self):
        for payload in (b"", b"\x00\x01\x02", b"hello world", bytes(range(256))):
            self.assertEqual(protocol.b64decode(protocol.b64encode(payload)), payload)

    def test_invalid_base64(self):
        with self.assertRaises(protocol.InvalidUpdate):
            protocol.b64decode("not base64 !!!")

    def test_empty_state_vector_encoding(self):
        empty = Doc()
        self.assertEqual(protocol.state_vector_b64(empty), "AA==")


class DocInitTests(unittest.TestCase):
    def test_init_from_plain_text(self):
        doc, base_update = protocol.init_doc(None, "hello ")
        self.assertEqual(protocol.doc_text(doc), "hello ")
        self.assertGreater(len(base_update), 2)

    def test_init_from_ydoc_state_is_authoritative(self):
        source, _ = protocol.init_doc(None, "persisted")
        state = source.get_update()

        doc, _ = protocol.init_doc(state, "ignored plain text")
        self.assertEqual(protocol.doc_text(doc), "persisted")

    def test_init_empty(self):
        doc, base_update = protocol.init_doc(None, "")
        self.assertEqual(protocol.doc_text(doc), "")
        self.assertEqual(base_update, protocol.EMPTY_UPDATE)

    def test_corrupt_state_falls_back_to_content(self):
        doc, _ = protocol.init_doc(b"definitely not a yjs update", "fallback")
        self.assertEqual(protocol.doc_text(doc), "fallback")

    def test_size_cap(self):
        with self.assertRaises(protocol.DocTooLarge):
            protocol.init_doc(None, "x" * (protocol.MAX_DOC_BYTES + 1))

    def test_restore_doc(self):
        doc, base = protocol.init_doc(None, "base")
        protocol.get_text(doc).insert(4, " updated")

        restored = protocol.restore_doc(base)
        self.assertEqual(protocol.doc_text(restored), "base")

    def test_empty_update_constant(self):
        self.assertEqual(Doc().get_update(), protocol.EMPTY_UPDATE)


class StateVectorTests(unittest.TestCase):
    def test_missing_update_from_empty_state_vector(self):
        server, _ = protocol.init_doc(None, "line one\nline two")
        client = Doc()

        update = protocol.update_for_state_vector(server, protocol.state_vector_b64(client))
        client.apply_update(protocol.b64decode(update))

        self.assertEqual(protocol.doc_text(client), "line one\nline two")

    def test_incremental_update(self):
        server, _ = protocol.init_doc(None, "hello")
        client = Doc()
        client.apply_update(server.get_update())

        # Capture the state vector *before* the change to compute a delta.
        state_vector = server.get_state()
        protocol.get_text(server).insert(5, " world")
        delta = server.get_update(state_vector)

        client.apply_update(delta)
        self.assertEqual(protocol.doc_text(client), "hello world")

    def test_absent_state_vector_returns_full_document(self):
        server, _ = protocol.init_doc(None, "abc")
        update = protocol.update_for_state_vector(server, None)
        client = Doc()
        client.apply_update(protocol.b64decode(update))
        self.assertEqual(protocol.doc_text(client), "abc")

    def test_invalid_state_vector(self):
        server, _ = protocol.init_doc(None, "abc")
        with self.assertRaises(protocol.InvalidUpdate):
            protocol.update_for_state_vector(server, protocol.b64encode(b"garbage state"))

    def test_empty_state_vector_bytes_means_full(self):
        server, _ = protocol.init_doc(None, "abc")
        update = protocol.update_for_state_vector(server, "")
        client = Doc()
        client.apply_update(protocol.b64decode(update))
        self.assertEqual(protocol.doc_text(client), "abc")

    def test_apply_update_is_idempotent(self):
        server, _ = protocol.init_doc(None, "abc")
        update = server.get_update()

        # State vectors: applying the same full update twice must be a no-op.
        client = Doc()
        client.apply_update(update)
        client.apply_update(update)
        self.assertEqual(protocol.doc_text(client), "abc")

    def test_update_is_empty(self):
        self.assertTrue(protocol.update_is_empty(protocol.b64encode(protocol.EMPTY_UPDATE)))
        self.assertTrue(protocol.update_is_empty(""))
        server, _ = protocol.init_doc(None, "x")
        self.assertFalse(protocol.update_is_empty(protocol.full_update_b64(server)))


if __name__ == "__main__":
    unittest.main()
