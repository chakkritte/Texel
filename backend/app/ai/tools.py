"""Tool schemas and defensive parsing for the AI side panel.

Edits are *never* applied server-side.  ``propose_edit`` produces a diff that
the browser shows to the user; after approval the browser calls the existing
``PUT /api/v1/files/{file_id}/content`` endpoint.
"""

from __future__ import annotations

import json
import re
from typing import Any

TOOL_NAMES = {"propose_edit", "jump_to_error"}

PROPOSE_EDIT_TOOL: dict[str, Any] = {
    "name": "propose_edit",
    "description": (
        "Propose replacing a character range in one project file. The edit is "
        "NOT applied automatically: the user reviews a diff and accepts or "
        "rejects it. range.from and range.to are 0-based character offsets into "
        "the complete current file content (to is exclusive)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "file_id": {
                "type": "string",
                "description": "UUID of the target file from the project context.",
            },
            "range": {
                "type": "object",
                "properties": {
                    "from": {"type": "integer", "minimum": 0},
                    "to": {"type": "integer", "minimum": 0},
                },
                "required": ["from", "to"],
                "additionalProperties": False,
            },
            "replacement": {
                "type": "string",
                "description": "Text that replaces the selected range.",
            },
            "rationale": {
                "type": "string",
                "description": "Short explanation shown to the user with the diff.",
            },
        },
        "required": ["file_id", "range", "replacement", "rationale"],
        "additionalProperties": False,
    },
    "strict": True,
}

JUMP_TO_ERROR_TOOL: dict[str, Any] = {
    "name": "jump_to_error",
    "description": (
        "Point the editor at a compile error so the user can jump to it. Use "
        "when discussing a specific error from the compile log."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "file": {
                "type": "string",
                "description": "Project-relative or plain file name.",
            },
            "line": {
                "type": "integer",
                "minimum": 1,
                "description": "1-based line number from the compile log.",
            },
            "message": {
                "type": "string",
                "description": "The compiler message.",
            },
            "job_id": {
                "type": "string",
                "description": "Optional compile job UUID.",
            },
        },
        "required": ["file", "line", "message"],
        "additionalProperties": False,
    },
    "strict": True,
}

TOOLS: list[dict[str, Any]] = [PROPOSE_EDIT_TOOL, JUMP_TO_ERROR_TOOL]

# Text convention used for providers without native tool calling (Ollama).
TEXT_TOOL_CONVENTION = """\
If you propose an edit, end your answer with a fenced json block in exactly
this shape (and make no claim that the edit was applied):

```json
{"tool": "propose_edit", "input": {"file_id": "<uuid>", "range": {"from": 0, "to": 0}, "replacement": "...", "rationale": "..."}}
```

To point at a compile error use:

```json
{"tool": "jump_to_error", "input": {"file": "main.tex", "line": 42, "message": "Undefined control sequence"}}
```
"""

_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)```", re.DOTALL)


class ToolValidationError(ValueError):
    pass


def _as_nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0:
        return None
    return value


def normalize_tool_call(name: str, payload: Any) -> dict[str, Any] | None:
    """Validate a tool call from either Anthropic or the JSON-block fallback.

    Returns ``{"name": ..., "input": ...}`` or ``None`` for unusable input.
    """
    if name not in TOOL_NAMES:
        return None
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return None
    if not isinstance(payload, dict):
        return None

    if name == "propose_edit":
        file_id = payload.get("file_id")
        if not isinstance(file_id, str) or not file_id.strip():
            return None
        range_obj = payload.get("range")
        if not isinstance(range_obj, dict):
            return None
        start = _as_nonnegative_int(range_obj.get("from", range_obj.get("start")))
        end = _as_nonnegative_int(range_obj.get("to", range_obj.get("end")))
        if start is None or end is None or end < start:
            return None
        replacement = payload.get("replacement")
        if not isinstance(replacement, str):
            return None
        rationale = payload.get("rationale")
        if not isinstance(rationale, str):
            rationale = ""
        return {
            "name": "propose_edit",
            "input": {
                "file_id": file_id.strip(),
                "range": {"from": start, "to": end},
                "replacement": replacement,
                "rationale": rationale,
            },
        }

    # jump_to_error
    file_name = payload.get("file")
    line = payload.get("line")
    if not isinstance(file_name, str) or not file_name.strip():
        return None
    if isinstance(line, bool) or not isinstance(line, int) or line < 1:
        return None
    message = payload.get("message")
    if not isinstance(message, str):
        message = ""
    result: dict[str, Any] = {
        "file": file_name.strip(),
        "line": line,
        "message": message,
    }
    job_id = payload.get("job_id")
    if isinstance(job_id, str) and job_id.strip():
        result["job_id"] = job_id.strip()
    return {"name": "jump_to_error", "input": result}


def _extract_tool_from_object(obj: dict[str, Any]) -> dict[str, Any] | None:
    # {"tool": "propose_edit", "input": {...}}
    # {"name": "propose_edit", "input": {...}}
    # {"tool": "propose_edit", "file_id": ...}  (inline payload)
    name = obj.get("tool") or obj.get("name") or obj.get("type")
    if not isinstance(name, str) or name not in TOOL_NAMES:
        # {"propose_edit": {...}}
        for candidate in TOOL_NAMES:
            if candidate in obj:
                return normalize_tool_call(candidate, obj[candidate])
        return None

    if "input" in obj:
        payload = obj["input"]
    elif "arguments" in obj:
        payload = obj["arguments"]
    elif "parameters" in obj:
        payload = obj["parameters"]
    else:
        payload = {k: v for k, v in obj.items() if k not in {"tool", "name", "type"}}
    return normalize_tool_call(name, payload)


def parse_text_tool_calls(text: str) -> list[dict[str, Any]]:
    """Extract tool calls from fenced ```json blocks (best effort, deduped)."""
    calls: list[dict[str, Any]] = []
    seen: set[str] = set()
    for match in _FENCE_RE.finditer(text or ""):
        raw = match.group(1).strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        candidates = obj if isinstance(obj, list) else [obj]
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            call = _extract_tool_from_object(candidate)
            if call is None:
                continue
            key = call["name"] + json.dumps(call["input"], sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            calls.append(call)
    return calls


def tool_definitions_for(provider_id: str) -> list[dict[str, Any]]:
    """Anthropic gets native tools; Ollama uses the JSON block convention."""
    return TOOLS if provider_id == "anthropic" else []
