"""Opt-in integration tests for the collab HTTP service.

These need a reachable Postgres and Redis (the same ones the docker stack uses)
and are skipped unless explicitly enabled::

    STUDIO_COLLAB_INTEGRATION=1 \\
        python -m unittest discover -s tests -p 'test_collab_integration.py' -v

(or run the backend image with ``DATABASE_URL`` / ``REDIS_URL`` pointing at the
stack).  They are intentionally *not* part of the default unit-test run because
they create rows and open Redis connections.

The test uses its own NullPool engine for fixture setup/teardown so it does not
share asyncpg connections across event loops (Starlette's TestClient runs the
app in a separate loop).
"""

from __future__ import annotations

import asyncio
import base64
import os
import unittest
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

ENABLED = os.environ.get("STUDIO_COLLAB_INTEGRATION") == "1"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.b64decode(value)


async def _db_call(fn):
    from app.core.config import settings

    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as db:
            return await fn(db)
    finally:
        await engine.dispose()


def _create_fixture():
    from app.models import Document, File, Project, User

    async def run(db):
        user = User(
            email=f"collab-test-{uuid.uuid4()}@example.com",
            password_hash="not-used",
            display_name="Collab Test",
        )
        db.add(user)
        await db.flush()

        project = Project(owner_id=user.id, name="Collab integration test", engine="pdflatex")
        db.add(project)
        await db.flush()

        file = File(project_id=project.id, name="main.tex", kind="doc", size=8)
        db.add(file)
        await db.flush()

        document = Document(file_id=file.id, content="initial ", seq=1)
        db.add(document)
        await db.commit()

        return {
            "user_id": user.id,
            "project_id": project.id,
            "file_id": file.id,
            "document_id": document.id,
        }

    return asyncio.run(_db_call(run))


def _delete_fixture(ids: dict) -> None:
    from app.models import Project, User

    async def run(db):
        project = await db.get(Project, ids["project_id"])
        if project is not None:
            await db.delete(project)
        user = await db.get(User, ids["user_id"])
        if user is not None:
            await db.delete(user)
        await db.commit()

    asyncio.run(_db_call(run))


def _read_document(document_id) -> tuple[str, bytes | None, int]:
    from app.models import Document

    async def run(db):
        row = await db.get(Document, document_id)
        return row.content, row.ydoc_state, row.seq

    return asyncio.run(_db_call(run))


@unittest.skipUnless(
    ENABLED,
    "set STUDIO_COLLAB_INTEGRATION=1 with Postgres+Redis available to run",
)
class CollabHttpIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from fastapi.testclient import TestClient

        from app.collab.main import app

        cls.ids = _create_fixture()
        cls.client = TestClient(app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.client.__exit__(None, None, None)
        finally:
            _delete_fixture(cls.ids)

    def _headers(self) -> dict[str, str]:
        from app.security import create_access_token

        token = create_access_token(self.ids["user_id"])
        return {"Authorization": f"Bearer {token}"}

    def test_sync_update_poll_flush(self) -> None:
        from pycrdt import Doc, Text

        doc_url = f"/collab/v1/doc/{self.ids['file_id']}"

        # --- initial sync from an empty client -----------------------------
        empty_sv = _b64(Doc().get_state())
        response = self.client.get(
            f"{doc_url}/sync", params={"sv": empty_sv}, headers=self._headers()
        )
        self.assertEqual(response.status_code, 200, response.text)
        synced = response.json()

        client_doc = Doc()
        client_doc.apply_update(_unb64(synced["update"]))
        self.assertEqual(client_doc.get("content", type=Text).to_py(), "initial ")

        # --- client edit -> POST /update -----------------------------------
        state_vector = client_doc.get_state()
        client_text = client_doc.get("content", type=Text)
        client_text.insert(len(client_text.to_py()), "world")
        delta = client_doc.get_update(state_vector)
        payload = {
            "client_id": "integration-client",
            "client_seq": 1,
            "update": _b64(delta),
        }

        first = self.client.post(f"{doc_url}/update", json=payload, headers=self._headers())
        self.assertEqual(first.status_code, 200, first.text)
        seq = first.json()["seq"]
        self.assertGreater(seq, synced["seq"])

        # --- idempotent retry ---------------------------------------------
        retry = self.client.post(f"{doc_url}/update", json=payload, headers=self._headers())
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json()["seq"], seq)

        # --- poll returns the update --------------------------------------
        poll = self.client.get(
            f"{doc_url}/poll",
            params={"after": synced["seq"], "timeout": 0.2},
            headers=self._headers(),
        )
        self.assertEqual(poll.status_code, 200, poll.text)
        polled = poll.json()
        self.assertTrue(any(u["seq"] == seq for u in polled["updates"]))

        second_doc = Doc()
        second_doc.apply_update(_unb64(synced["update"]))
        for item in polled["updates"]:
            second_doc.apply_update(_unb64(item["update"]))
        self.assertEqual(second_doc.get("content", type=Text).to_py(), "initial world")

        # --- awareness round-trip ------------------------------------------
        awareness = self.client.post(
            f"{doc_url}/awareness",
            json={"client_id": "integration-client", "update": _b64(b"awareness")},
            headers=self._headers(),
        )
        self.assertEqual(awareness.status_code, 204, awareness.text)

        # --- flush persists plain text + CRDT state ------------------------
        flushed = self.client.post(f"{doc_url}/flush", headers=self._headers())
        self.assertEqual(flushed.status_code, 200, flushed.text)

        content, ydoc_state, stored_seq = _read_document(self.ids["document_id"])
        self.assertEqual(content, "initial world")
        self.assertIsNotNone(ydoc_state)
        self.assertGreaterEqual(stored_seq, seq)

    def test_missing_token_is_rejected(self) -> None:
        response = self.client.get(f"/collab/v1/doc/{self.ids['file_id']}/sync")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
