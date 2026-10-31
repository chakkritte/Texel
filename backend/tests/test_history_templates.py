import pytest

from app.routers.templates import (
    BUILTIN_TEMPLATES,
    build_clone_payload,
    get_builtin_template,
    render_template_files,
)


def test_three_builtin_templates_are_available():
    assert len(BUILTIN_TEMPLATES) == 3
    ids = {template["id"] for template in BUILTIN_TEMPLATES}
    assert ids == {"blank-article", "article-sections", "ieee-two-column"}
    for template in BUILTIN_TEMPLATES:
        assert template["name"]
        assert template["description"]
        assert get_builtin_template(template["id"]) is template
    assert get_builtin_template("missing") is None


def test_ieee_template_uses_ieeetran():
    template = get_builtin_template("ieee-two-column")
    assert template is not None
    main = next(spec for spec in template["files"] if spec["name"] == template["main_file"])
    assert "\\documentclass[conference]{IEEEtran}" in main["content"]


def test_article_with_sections_references_extra_files():
    template = get_builtin_template("article-sections")
    assert template is not None
    names = {spec["name"] for spec in template["files"]}
    assert {"main.tex", "intro.tex", "conclusion.tex", "references.bib"} <= names
    main = next(spec for spec in template["files"] if spec["name"] == "main.tex")
    assert "\\input{intro}" in main["content"]
    assert "\\input{conclusion}" in main["content"]


def test_render_template_files_returns_copies():
    template = get_builtin_template("blank-article")
    assert template is not None
    rendered = render_template_files(template)
    rendered[0]["content"] = "changed"
    assert template["files"][0]["content"] != "changed"


def test_build_clone_payload_uses_requested_name():
    template = get_builtin_template("blank-article")
    assert template is not None
    payload = build_clone_payload(template, "  My Paper  ")
    assert payload["name"] == "My Paper"
    assert payload["engine"] == "pdflatex"
    assert payload["main_file"] == "main.tex"
    assert [spec["name"] for spec in payload["files"]] == ["main.tex"]


def test_build_clone_payload_falls_back_to_template_name():
    template = get_builtin_template("blank-article")
    assert template is not None
    payload = build_clone_payload(template, "   ")
    assert payload["name"] == template["name"]


def test_render_template_files_rejects_path_traversal():
    with pytest.raises(ValueError):
        render_template_files(
            {
                "main_file": "../evil.tex",
                "files": [
                    {"name": "../evil.tex", "content": "x", "kind": "doc", "mime": "text/x-tex"}
                ],
            }
        )


def test_render_template_files_requires_main_file():
    with pytest.raises(ValueError):
        render_template_files(
            {
                "main_file": "main.tex",
                "files": [{"name": "other.tex", "content": "x", "kind": "doc"}],
            }
        )
