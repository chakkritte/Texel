"""Redis key / channel naming helpers (pure, easy to unit-test)."""

from __future__ import annotations

PREFIX = "collab"

#: Maximum number of updates retained per document stream (plan section 5).
STREAM_MAXLEN = 5000

#: Dedupe key lifetime, as specified in the plan (10 minutes).
DEDUPE_TTL_SECONDS = 600

#: Awareness entries expire after 30 seconds without a heartbeat.
AWARENESS_TTL_SECONDS = 30


def seq(doc_id: str) -> str:
    return f"{PREFIX}:seq:{doc_id}"


def init_state(doc_id: str) -> str:
    """Shared bootstrap CRDT snapshot derived from Phase 1 plain text.

    Two service instances that initialise the same document from
    ``documents.content`` independently would create divergent CRDT histories
    (different item ids), so the first instance publishes the bootstrap state
    here and everyone else adopts it.  Once ``documents.ydoc_state`` is flushed
    the database is authoritative and this key is ignored.
    """

    return f"{PREFIX}:init:{doc_id}"


def stream(doc_id: str) -> str:
    return f"{PREFIX}:stream:{doc_id}"


def dedupe(doc_id: str, client_id: str, client_seq: int) -> str:
    return f"{PREFIX}:dedupe:{doc_id}:{client_id}:{client_seq}"


def awareness(doc_id: str, client_id: str) -> str:
    return f"{PREFIX}:aw:{doc_id}:{client_id}"


def awareness_pattern(doc_id: str) -> str:
    return f"{PREFIX}:aw:{doc_id}:*"


def awareness_version(doc_id: str) -> str:
    return f"{PREFIX}:awver:{doc_id}"


def events_channel(doc_id: str) -> str:
    return f"{PREFIX}:events:{doc_id}"
