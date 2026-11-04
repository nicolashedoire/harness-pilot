""""Ask for a fix" on a broken extension (maxxing/extfix.py, POST /api/extensions/{id}/fix, the origin session recorded
by `pilot ext check` run from a turn)."""
import json

from conftest import wait_idle
from maxxing import cli, config, exterrors, extfix, extensions

HARNESS = "projects/system/topics/harness"


def _ext(mx, eid, manifest, **files):
    d = mx["ws"] / "extensions" / eid
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(json.dumps(manifest))
    for name, text in files.items():
        (d / name.replace("_", ".", 1)).write_text(text)
    return d


def _harness(mx):
    (mx["ws"] / HARNESS).mkdir(parents=True, exist_ok=True)


def _session(client, path=HARNESS, title="Build the notes page"):
    r = client.post("/api/sessions", json={"path": path, "title": title})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _origin(client, eid):
    return next(e for e in client.get("/api/extensions").json() if e["id"] == eid)["origin"]


def test_the_prompt(client, mx):
    d = _ext(mx, "notes", {"name": "Notes", "type": "page"}, page_js="export function mount() {}\n",
             api_py="def handle(ctx, method, path, query, body):\n    return {}\n")
    (d / "lib").mkdir()
    (d / "lib" / "list.js").write_text("export const x = 1\n")
    exterrors.record("notes", d, "page", "TypeError: rows is undefined", "at draw (lib/list.js:7:11)\nat x (../../etc/passwd:1:1)")
    exterrors.record("notes", d, "api", "ZeroDivisionError: division by zero", "api.py:2 in handle: return 1 / 0")
    ext = extensions.get("notes")
    text = extfix.prompt(ext, {"message": "This extension failed to load (Unexpected token ';')"})
    assert text.startswith(f"My page extension `notes` (\"Notes\", folder {d}) is broken. Fix it.")
    assert "- the error I see: This extension failed to load (Unexpected token ';')" in text
    assert "- in the page (" in text and "TypeError: rows is undefined\n    at draw (lib/list.js:7:11)" in text
    assert "- handle() of its API (" in text
    for f in ("manifest.json", "page.js", "api.py", "lib/list.js"):
        assert f"- {d / f}" in text
    assert "passwd" not in text.split("Files:")[1]
    assert "Use the skill pilot-widgets-pages. Run `pilot ext check notes --json` first" in text
    # the error on screen is one of the recorded ones: listed once, with its stack
    again = extfix.prompt(ext, {"message": "TypeError: rows is undefined"})
    assert again.count("rows is undefined") == 1 and "the error I see" not in again
    config.update_config(language="fr")
    assert extfix.prompt(ext).endswith("Answer me in French.")


def test_load_error_and_block_skill(client, mx):
    _ext(mx, "boom", {"type": "widget"}, api_py="raise RuntimeError('no token')\n")
    bd = mx["ws"] / "extensions" / "kan"
    bd.mkdir(parents=True)
    (bd / "block.json").write_text(json.dumps({"type": "block", "renders": ["kan"]}))
    (bd / "block.html").write_text("<p>x</p>")
    text = extfix.prompt(extensions.get("boom"))
    assert "- does not load: RuntimeError: no token" in text and "dashboard widget" in text
    blk = extfix.prompt(extensions.get("kan"))
    assert "conversation block plugin" in blk and "Use the skill pilot-blocks." in blk and f"- {bd / 'block.html'}" in blk


def test_without_origin_a_harness_session(client, mx):
    _harness(mx)
    _ext(mx, "w", {"type": "widget"}, api_py="def card(ctx):\n    return 1 / 0\n")
    assert _origin(client, "w") is None
    dry = client.post("/api/extensions/w/fix", json={"dry_run": True, "error": {"message": "ZeroDivisionError"}}).json()
    assert dry["target"] == {"topic": HARNESS} and "`w`" in dry["prompt"]
    assert client.get("/api/sessions").json() == []                       # nothing sent
    r = client.post("/api/extensions/w/fix", json={"error": {"message": "ZeroDivisionError: division by zero"}})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["reused"] is False and out["session"]["path"] == HARNESS and out["session"]["title"] == "Fix the extension w"
    wait_idle(client, out["session"]["id"])
    assert client.post("/api/extensions/nope/fix", json={}).status_code == 404
    assert client.post("/api/extensions/w/fix", json={}, headers={"X-Maxxing": ""}).status_code == 403


def test_the_session_that_made_it(client, mx, monkeypatch, capsys):
    _harness(mx)
    _ext(mx, "notes", {"type": "page"}, page_js="export function mount() {}\n")
    maker = _session(client)
    monkeypatch.setenv("MAXXING_SESSION", maker)
    assert cli.main(["ext", "check", "notes"]) == 0                        # the agent's test step records it
    capsys.readouterr()
    assert _origin(client, "notes") == {"id": maker, "title": "Build the notes page", "path": HARNESS}
    other = _session(client, title="Another one")
    monkeypatch.setenv("MAXXING_SESSION", other)
    cli.main(["ext", "check", "notes"])                                    # the first live one is kept
    assert _origin(client, "notes")["id"] == maker
    assert client.post("/api/extensions/notes/fix", json={"dry_run": True}).json()["target"]["session"]["id"] == maker
    out = client.post("/api/extensions/notes/fix", json={"error": {"message": "mount failed"}}).json()
    assert out["reused"] is True and out["session"]["id"] == maker
    wait_idle(client, maker)
    sent = [e for e in client.get(f"/api/sessions/{maker}/events").json()["events"] if e.get("type") == "user"]
    assert any("`notes`" in (e.get("text") or "") and "mount failed" in (e.get("text") or "") for e in sent)
    # archived: no longer where the fix goes; the next agent that checks it takes its place
    assert client.patch(f"/api/sessions/{maker}", json={"archived": True}).status_code == 200
    assert _origin(client, "notes") is None
    cli.main(["ext", "check", "notes"])
    capsys.readouterr()
    assert _origin(client, "notes")["id"] == other
    monkeypatch.setenv("MAXXING_SESSION", "../../not-a-session")
    assert extfix.record_origin("notes", "../../not-a-session") is False
