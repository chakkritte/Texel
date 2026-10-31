import uuid

from app.routers.history import prune_keep, read_snapshot, write_snapshot


def test_snapshot_manifest_round_trip(tmp_path):
    doc_id = uuid.uuid4()
    binary_id = uuid.uuid4()
    folder_id = uuid.uuid4()
    files = [
        {
            "file_id": doc_id,
            "name": "main.tex",
            "folder_id": None,
            "kind": "doc",
            "mime": "text/x-tex",
            "text": "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n",
        },
        {
            "file_id": binary_id,
            "name": "figure.png",
            "folder_id": folder_id,
            "kind": "binary",
            "mime": "image/png",
            "data": b"\x89PNG\r\n\x1a\n",
        },
    ]
    archive = tmp_path / "versions" / "project" / "version.tar.gz"

    manifest = write_snapshot(
        archive,
        {"id": "project", "name": "Demo", "main_file": "main.tex", "engine": "pdflatex"},
        files,
        created_at="2026-10-31T00:00:00+00:00",
    )

    assert archive.exists()
    assert manifest["format"] == 1
    assert manifest["created_at"] == "2026-10-31T00:00:00+00:00"
    assert manifest["project"]["name"] == "Demo"
    assert len(manifest["files"]) == 2

    text_entry = next(entry for entry in manifest["files"] if entry["kind"] == "doc")
    binary_entry = next(entry for entry in manifest["files"] if entry["kind"] == "binary")
    assert text_entry["archive_path"] == f"docs/{doc_id}.tex"
    assert text_entry["size"] == len(files[0]["text"].encode("utf-8"))
    assert binary_entry["archive_path"] == f"files/{binary_id}"
    assert binary_entry["folder_id"] == str(folder_id)
    assert binary_entry["size"] == 8

    restored_manifest, contents = read_snapshot(archive)
    assert restored_manifest == manifest
    assert contents[text_entry["archive_path"]] == files[0]["text"].encode("utf-8")
    assert contents[binary_entry["archive_path"]] == b"\x89PNG\r\n\x1a\n"


def test_snapshot_handles_empty_binary_and_unicode(tmp_path):
    files = [
        {
            "file_id": uuid.uuid4(),
            "name": "notes.tex",
            "folder_id": None,
            "kind": "doc",
            "mime": "text/x-tex",
            "text": "% ภาษาไทย\n",
        },
        {
            "file_id": uuid.uuid4(),
            "name": "empty.bin",
            "folder_id": None,
            "kind": "binary",
            "mime": "application/octet-stream",
        },
    ]
    archive = tmp_path / "v.tar.gz"
    manifest = write_snapshot(archive, {"id": "p"}, files)
    entries = {entry["kind"]: entry for entry in manifest["files"]}
    assert entries["binary"]["size"] == 0

    _, contents = read_snapshot(archive)
    assert contents[entries["doc"]["archive_path"]].decode("utf-8") == "% ภาษาไทย\n"
    assert contents[entries["binary"]["archive_path"]] == b""


def test_prune_keep_retains_newest_20():
    versions = list(range(25))  # newest first
    stale = prune_keep(versions, keep=20)
    assert stale == [20, 21, 22, 23, 24]
    assert prune_keep(versions[:20], keep=20) == []
