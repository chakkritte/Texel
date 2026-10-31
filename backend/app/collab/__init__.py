"""Real-time collaboration service (Phase 2).

This package is a *separate* ASGI application from ``app.main``.  It is meant to
be served with::

    uvicorn app.collab.main:app --host 0.0.0.0 --port 8000

and mounted behind the edge proxy at ``/studio/collab/`` -> ``/collab/``.
"""

from app.collab.protocol import (  # noqa: F401
    CONTENT_KEY,
    MAX_DOC_BYTES,
    DocTooLarge,
    InvalidUpdate,
    b64decode,
    b64encode,
    doc_text,
    init_doc,
    text_size,
)

__all__ = [
    "CONTENT_KEY",
    "MAX_DOC_BYTES",
    "DocTooLarge",
    "InvalidUpdate",
    "b64decode",
    "b64encode",
    "doc_text",
    "init_doc",
    "text_size",
]
