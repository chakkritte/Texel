"""Pure helpers around pycrdt documents and base64 framing.

Nothing in this module talks to Redis or Postgres, which keeps it trivially
unit-testable.
"""

from __future__ import annotations

import base64
import binascii

from pycrdt import Doc, Text

#: Name of the root Y.Text used by the editor (``y-codemirror.next`` expects a
#: Y.Text; the frontend uses ``doc.getText("content")``).
CONTENT_KEY = "content"

#: Hard cap for a document's plain-text size (5 MiB).  Updates that would push a
#: document past this limit are rejected.
MAX_DOC_BYTES = 5 * 1024 * 1024

#: A Yjs update that contains no structs (empty document / no diff).
EMPTY_UPDATE = b"\x00\x00"


class InvalidUpdate(ValueError):
    """Raised when a base64 payload is not a valid Yjs update / state vector."""


class DocTooLarge(ValueError):
    """Raised when a document would exceed :data:`MAX_DOC_BYTES`."""


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode(value: str | bytes | None) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        value = value.decode("ascii")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:  # pragma: no cover - defensive
        raise InvalidUpdate("invalid base64 payload") from exc


def get_text(doc: Doc) -> Text:
    """Return (creating if needed) the root Y.Text used for document content."""

    return doc.get(CONTENT_KEY, type=Text)


def doc_text(doc: Doc) -> str:
    return get_text(doc).to_py()


def text_size(doc: Doc) -> int:
    """Size of the document's plain text in UTF-8 bytes."""

    return len(doc_text(doc).encode("utf-8"))


def new_empty_doc() -> Doc:
    return Doc()


def init_doc(
    ydoc_state: bytes | None,
    content: str | None,
    *,
    max_bytes: int = MAX_DOC_BYTES,
) -> tuple[Doc, bytes]:
    """Build a pycrdt document from persisted state.

    If ``ydoc_state`` exists it is authoritative.  Otherwise the Phase 1 plain
    text in ``documents.content`` is inserted into a fresh Y.Text so existing
    projects keep working.

    Returns ``(doc, base_update)`` where ``base_update`` is a full Yjs update
    that can be used to roll back an oversized incoming update.
    """

    doc = Doc()
    if ydoc_state:
        try:
            doc.apply_update(ydoc_state)
        except Exception:
            # Corrupt/legacy state: fall back to the plain-text copy rather than
            # failing every editor session.
            doc = Doc()
            if content:
                get_text(doc).insert(0, content)
    elif content:
        get_text(doc).insert(0, content)

    if text_size(doc) > max_bytes:
        raise DocTooLarge(f"document exceeds {max_bytes} bytes")

    return doc, doc.get_update()


def restore_doc(base_update: bytes | None) -> Doc:
    """Re-create a document from a previously captured full update."""

    doc = Doc()
    if base_update:
        try:
            doc.apply_update(base_update)
        except Exception:
            doc = Doc()
    return doc


def apply_update(doc: Doc, update: bytes) -> None:
    try:
        doc.apply_update(update)
    except Exception as exc:
        raise InvalidUpdate("invalid Yjs update") from exc


def state_vector_b64(doc: Doc) -> str:
    return b64encode(doc.get_state())


def full_update_b64(doc: Doc) -> str:
    return b64encode(doc.get_update())


def update_for_state_vector(doc: Doc, sv_b64: str | None) -> str:
    """Return a base64 Yjs update containing everything the client is missing.

    An absent/empty state vector means "send the full document".
    """

    if not sv_b64:
        return full_update_b64(doc)

    sv = b64decode(sv_b64)
    if not sv:
        return full_update_b64(doc)

    try:
        update = doc.get_update(sv)
    except Exception as exc:
        raise InvalidUpdate("invalid Yjs state vector") from exc
    return b64encode(update)


def update_is_empty(update_b64: str) -> bool:
    try:
        return b64decode(update_b64) in (b"", EMPTY_UPDATE)
    except InvalidUpdate:
        return False
