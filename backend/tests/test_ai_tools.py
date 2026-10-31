from app.ai.tools import (
    JUMP_TO_ERROR_TOOL,
    PROPOSE_EDIT_TOOL,
    TOOLS,
    normalize_tool_call,
    parse_text_tool_calls,
    tool_definitions_for,
)


def test_anthropic_tool_definitions_are_strict():
    assert {tool["name"] for tool in TOOLS} == {"propose_edit", "jump_to_error"}
    for tool in TOOLS:
        assert tool["strict"] is True
        assert tool["input_schema"]["additionalProperties"] is False
        assert tool["input_schema"]["required"]
    assert PROPOSE_EDIT_TOOL["input_schema"]["properties"]["range"]["type"] == "object"
    assert JUMP_TO_ERROR_TOOL["input_schema"]["properties"]["line"]["minimum"] == 1


def test_tool_definitions_depend_on_provider():
    assert [tool["name"] for tool in tool_definitions_for("anthropic")] == [
        "propose_edit",
        "jump_to_error",
    ]
    assert tool_definitions_for("ollama") == []


def test_normalize_propose_edit():
    call = normalize_tool_call(
        "propose_edit",
        {
            "file_id": "11111111-1111-1111-1111-111111111111",
            "range": {"from": 10, "to": 20},
            "replacement": "new",
            "rationale": "typo",
        },
    )
    assert call == {
        "name": "propose_edit",
        "input": {
            "file_id": "11111111-1111-1111-1111-111111111111",
            "range": {"from": 10, "to": 20},
            "replacement": "new",
            "rationale": "typo",
        },
    }


def test_normalize_propose_edit_accepts_start_end_aliases():
    call = normalize_tool_call(
        "propose_edit",
        {
            "file_id": "f",
            "range": {"start": 0, "end": 0},
            "replacement": "",
        },
    )
    assert call is not None
    assert call["input"]["range"] == {"from": 0, "to": 0}
    assert call["input"]["rationale"] == ""


def test_normalize_rejects_invalid_ranges_and_types():
    bad = [
        {"file_id": "f", "range": {"from": 5, "to": 2}, "replacement": "x"},
        {"file_id": "f", "range": {"from": -1, "to": 2}, "replacement": "x"},
        {"file_id": "", "range": {"from": 0, "to": 2}, "replacement": "x"},
        {"file_id": "f", "range": {"from": True, "to": 2}, "replacement": "x"},
        {"file_id": "f", "range": {"from": 0, "to": 2}},
        "not-json",
    ]
    for payload in bad:
        assert normalize_tool_call("propose_edit", payload) is None


def test_normalize_jump_to_error():
    call = normalize_tool_call(
        "jump_to_error",
        {"file": "main.tex", "line": 12, "message": "Undefined control sequence"},
    )
    assert call == {
        "name": "jump_to_error",
        "input": {
            "file": "main.tex",
            "line": 12,
            "message": "Undefined control sequence",
        },
    }
    assert normalize_tool_call("jump_to_error", {"file": "main.tex", "line": 0}) is None
    assert normalize_tool_call("jump_to_error", {"file": "", "line": 1}) is None


def test_parse_text_tool_calls_from_fenced_json():
    text = (
        "Here is a fix.\n\n"
        "```json\n"
        '{"tool": "propose_edit", "input": {"file_id": "abc", '
        '"range": {"from": 0, "to": 3}, "replacement": "X", "rationale": "r"}}\n'
        "```\n\n"
        "And a jump:\n"
        "```json\n"
        '{"name": "jump_to_error", "input": {"file": "main.tex", "line": 7, '
        '"message": "error"}}\n'
        "```\n"
    )
    calls = parse_text_tool_calls(text)
    assert [call["name"] for call in calls] == ["propose_edit", "jump_to_error"]
    assert calls[0]["input"]["range"] == {"from": 0, "to": 3}


def test_parse_text_tool_calls_ignores_plain_text_and_duplicates():
    text = 'No tool here.\n```json\n{"hello": "world"}\n```'
    assert parse_text_tool_calls(text) == []

    duplicate = (
        '```json\n{"tool":"jump_to_error","input":{"file":"a.tex","line":1,"message":"e"}}\n```\n'
        '```json\n{"tool":"jump_to_error","input":{"file":"a.tex","line":1,"message":"e"}}\n```\n'
    )
    assert len(parse_text_tool_calls(duplicate)) == 1


def test_parse_text_tool_calls_inline_payload():
    text = '```json\n{"tool": "jump_to_error", "file": "a.tex", "line": 2, "message": "m"}\n```'
    calls = parse_text_tool_calls(text)
    assert calls == [
        {
            "name": "jump_to_error",
            "input": {"file": "a.tex", "line": 2, "message": "m"},
        }
    ]
