import uuid

from app.ai.context import (
    FileEntry,
    estimate_tokens,
    find_tex_includes,
    match_include,
    normalize_include,
    render_project_block,
    slice_selection,
    truncate_to_tokens,
)


def test_estimate_tokens_is_conservative():
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcde") == 2
    assert estimate_tokens("x" * 40_000) == 10_000


def test_truncate_to_tokens_adds_marker():
    text = "a" * 400
    out = truncate_to_tokens(text, 10)
    assert out.endswith("…[truncated]")
    assert len(out) <= 10 * 4
    assert truncate_to_tokens("short", 10) == "short"


def test_find_tex_includes_normalizes_and_dedupes():
    source = r"""
\documentclass{article}
% \input{commented-out}
\input{sections/intro}
\include{appendix.tex}
\input{plain}
\input{plain}
"""
    assert find_tex_includes(source) == [
        "sections/intro.tex",
        "appendix.tex",
        "plain.tex",
    ]


def test_normalize_include():
    assert normalize_include(" ./a/b ") == "a/b.tex"
    assert normalize_include("a/b.tex") == "a/b.tex"
    assert normalize_include("\\foo") == "foo.tex"


def test_slice_selection_uses_absolute_char_offsets():
    content = "".join(f"line{i}\n" for i in range(100))
    result = slice_selection(content, 50, 52, radius=40)
    assert result.start_line == 10
    assert result.end_line == 92
    assert result.text.startswith("line10\n")
    assert result.text.endswith("line91\n")
    assert result.selected_text == "line50\nline51\n"
    assert result.char_from == sum(len(f"line{i}\n") for i in range(50))
    assert result.char_to == sum(len(f"line{i}\n") for i in range(52))


def test_slice_selection_clamps_at_file_end():
    content = "a\nb\n"
    result = slice_selection(content, 10, 20)
    assert result.start_line == 0
    assert result.end_line == 2
    assert result.text == content
    assert result.selected_text == ""
    assert result.char_from == len(content)
    assert result.char_to == len(content)


def _entries():
    return [
        FileEntry(uuid.uuid4(), "main.tex", "main.tex", "doc", 10),
        FileEntry(uuid.uuid4(), "sections/intro.tex", "intro.tex", "doc", 20),
        FileEntry(uuid.uuid4(), "figure.png", "figure.png", "binary", 30),
    ]


def test_match_include_by_path_name_and_suffix():
    entries = _entries()
    assert match_include("sections/intro", entries).path == "sections/intro.tex"
    assert match_include("intro.tex", entries).path == "sections/intro.tex"
    assert match_include("missing.tex", entries) is None


def test_render_project_block_is_stable_and_caps_content():
    main_id = uuid.uuid4()
    big_id = uuid.uuid4()
    entries = [
        FileEntry(main_id, "main.tex", "main.tex", "doc", 100),
        FileEntry(big_id, "big.tex", "big.tex", "doc", 100_000),
    ]
    contents = {
        main_id: ("main.tex", "\\documentclass{article}\n"),
        big_id: ("big.tex", "x" * 100_000),
    }
    block, included, truncated = render_project_block(
        project_name="Test",
        main_file="main.tex",
        engine="pdflatex",
        file_entries=entries,
        content_order=[main_id, big_id],
        contents=contents,
        max_tokens=500,
    )
    assert "# PROJECT CONTEXT" in block
    assert "main.tex (id=" in block
    assert "\\documentclass{article}" in block
    assert included[0] == "main.tex"
    assert truncated is True
    assert estimate_tokens(block) <= 520

    again, _, _ = render_project_block(
        project_name="Test",
        main_file="main.tex",
        engine="pdflatex",
        file_entries=entries,
        content_order=[main_id, big_id],
        contents=contents,
        max_tokens=500,
    )
    assert again == block
