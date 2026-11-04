"""The Codex model pickers' list (maxxing/codex_models.py, GET /api/system/codex/models) against a fake `codex`:
the CLI's catalog (`codex debug models`, then `--bundled`), the built-in fallback, the cache. No network."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from maxxing import codex_models
from maxxing.sessions import service

# shaped like codex-cli 0.150.1's `codex debug models` (fields trimmed): hidden models, unsorted priorities, a repeat,
# an id a session would refuse, no display name
CATALOG = {"models": [
    {"slug": "gpt-test-mini", "display_name": "Test Mini", "description": "Small.", "visibility": "list", "priority": 9},
    {"slug": "gpt-test-pro", "display_name": "Test Pro", "description": "Frontier.", "visibility": "list", "priority": 1},
    {"slug": "gpt-internal", "display_name": "Internal", "visibility": "hide", "priority": 2},
    {"slug": "gpt-test-pro", "display_name": "Again", "visibility": "list", "priority": 3},
    {"slug": "bad id with spaces", "display_name": "Bad", "visibility": "list", "priority": 4},
    {"slug": "gpt-plain", "visibility": "list", "priority": 5},
]}
BUNDLED = {"models": [{"slug": "gpt-shipped", "display_name": "Shipped", "visibility": "list", "priority": 1}]}
FAKE = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ["FAKE_CODEX_DIR"]
args = [a for i, a in enumerate(sys.argv[1:]) if a != "-c" and (i == 0 or sys.argv[i] != "-c")]
with open(os.path.join(d, "calls.jsonl"), "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
mode = open(os.path.join(d, "mode")).read().strip()
if args[:2] != ["debug", "models"] or mode == "old":
    sys.stderr.write("error: unrecognized subcommand 'debug'\n"); sys.exit(2)
if "--bundled" in args:
    print(open(os.path.join(d, "bundled.json")).read()); sys.exit(0)
if mode == "offline":
    sys.stderr.write("failed to refresh models\n"); sys.exit(1)
print(open(os.path.join(d, "catalog.json")).read() if mode != "garbage" else "not json")
'''


@pytest.fixture
def fake(mx, monkeypatch) -> Path:
    d = mx["tmp"] / "fake-codex"
    d.mkdir()
    (d / "catalog.json").write_text(json.dumps(CATALOG))
    (d / "bundled.json").write_text(json.dumps(BUNDLED))
    (d / "mode").write_text("ok")
    binary = mx["tmp"] / "codex"
    binary.write_text(FAKE)
    binary.chmod(0o755)
    monkeypatch.setenv("MAXXING_CODEX_BIN", str(binary))
    monkeypatch.setenv("FAKE_CODEX_DIR", str(d))
    codex_models.invalidate()
    yield d
    codex_models.invalidate()


def _calls(d: Path) -> list[list[str]]:
    f = d / "calls.jsonl"
    return [json.loads(line) for line in f.read_text().splitlines()] if f.exists() else []


def test_the_cli_catalog_gives_the_models_of_its_own_picker_in_its_order(client, fake):
    r = client.get("/api/system/codex/models")
    assert r.status_code == 200, r.text
    assert r.json() == {"source": "cli", "models": [
        {"id": "gpt-test-pro", "label": "Test Pro", "description": "Frontier."},
        {"id": "gpt-plain", "label": "gpt-plain", "description": ""},
        {"id": "gpt-test-mini", "label": "Test Mini", "description": "Small."},
    ]}
    argv = _calls(fake)[0]
    assert argv[-2:] == ["debug", "models"] and "analytics.enabled=false" in argv
    # cached: no second run, until the binary changes
    assert client.get("/api/system/codex/models").json()["source"] == "cli" and len(_calls(fake)) == 1
    binary = Path(os.environ["MAXXING_CODEX_BIN"])
    st = binary.stat()
    os.utime(binary, (st.st_atime, st.st_mtime + 5))
    (fake / "catalog.json").write_text(json.dumps({"models": [{"slug": "gpt-next", "visibility": "list"}]}))
    assert [m["id"] for m in client.get("/api/system/codex/models").json()["models"]] == ["gpt-next"]


@pytest.mark.parametrize("mode", ["offline", "garbage"])
def test_without_the_refreshed_catalog_the_shipped_one(client, fake, mode):
    (fake / "mode").write_text(mode)
    assert client.get("/api/system/codex/models").json() == {
        "source": "bundled", "models": [{"id": "gpt-shipped", "label": "Shipped", "description": ""}]}
    assert _calls(fake)[-1][-3:] == ["debug", "models", "--bundled"]


def test_an_older_cli_or_none_at_all_gives_the_built_in_list(client, fake, monkeypatch):
    (fake / "mode").write_text("old")
    builtin = client.get("/api/system/codex/models").json()
    assert builtin["source"] == "builtin"
    assert [m["id"] for m in builtin["models"]] == [m[0] for m in codex_models.KNOWN_MODELS]
    codex_models.invalidate()
    monkeypatch.delenv("MAXXING_CODEX_BIN")
    monkeypatch.setattr(codex_models.shutil, "which", lambda name: None)
    before = len(_calls(fake))
    assert client.get("/api/system/codex/models").json() == builtin
    assert len(_calls(fake)) == before


def test_every_listed_id_is_one_a_session_accepts():
    assert codex_models.MODEL_ID_RE.pattern == service._MODEL_ID.pattern                    # noqa: SLF001
    assert all(service._MODEL_ID.fullmatch(m[0]) for m in codex_models.KNOWN_MODELS)       # noqa: SLF001
    for text in ("", "[]", '{"models": {}}', '{"models": [1, "x", {"slug": 3}]}'):
        assert codex_models.parse(text) == []


def test_the_list_needs_the_session(client, fake):
    from fastapi.testclient import TestClient
    from maxxing.app import create_app
    assert TestClient(create_app()).get("/api/system/codex/models").status_code == 401
    assert _calls(fake) == []
