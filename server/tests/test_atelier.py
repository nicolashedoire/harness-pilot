"""The Atelier: drafts, proposals, approval, versions (maxxing/atelier.py, api/atelier.py, `pilot ext draft|propose`).
docs/dev/API.md#atelier, docs/dev/INTERNALS.md `maxxing.atelier`."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from conftest import wait_idle
from maxxing import atelier, cli, config, extensions, feed

node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")

CARD = "def card(ctx):\n    return {'title': 'Hi', 'blocks': [{'type': 'stat', 'label': 'N', 'value': %d}]}\n"


def _write(d: Path, eid: str, value: int = 1, manifest: dict | None = None, api: str | None = None) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(json.dumps(manifest or {"id": eid, "name": eid.title(), "type": "widget",
                                                             "icon": "star", "version": "1.0"}))
    (d / "api.py").write_text(api if api is not None else CARD % value)
    return d


def _cli(capsys, monkeypatch, *args, session: str | None = None, agent: str | None = None):
    if session:
        monkeypatch.setenv("MAXXING_SESSION", session)
    else:
        monkeypatch.delenv("MAXXING_SESSION", raising=False)
    if agent:
        monkeypatch.setenv("MAXXING_AGENT", agent)
    else:
        monkeypatch.delenv("MAXXING_AGENT", raising=False)
    code = cli.main(["ext", *args])
    out = capsys.readouterr()
    return code, out.out, out.err


def _draft_id(out: str) -> str:
    return next(w for w in out.split() if w.startswith("d_")).rstrip(":")


def _reset():
    atelier._last_refresh.update(at=0.0, root="")


def _premigration(mx) -> None:
    """The app's startup already migrated an empty workspace: start again as a server whose extensions existed
    before the Atelier."""
    (mx["state"] / "atelier" / "state.json").unlink(missing_ok=True)
    _reset()


@pytest.fixture(autouse=True)
def _fresh():
    _reset()
    yield
    _reset()


def test_existing_extensions_become_approved_v1(client, mx):
    _write(mx["ws"] / "extensions" / "hello", "hello")
    _premigration(mx)
    r = client.get("/api/atelier").json()
    it = next(i for i in r["items"] if i["id"] == "hello")
    assert it["kind"] == "extension" and it["type"] == "widget" and it["state"] == "active"
    assert it["version"] == 1 and it["version_label"] == "1.0" and it["origin"] is None
    assert it["approval"]["by"] == "migration" and not it["unreviewed"] and it["pending"] is None
    assert it["href"] == "/?widget=hello"
    d = client.get("/api/atelier/extension/hello").json()
    assert [v["n"] for v in d["versions"]] == [1] and d["versions"][0]["restorable"]
    assert d["history"][0]["action"] == "migrate" and {f["path"] for f in d["files"]} == {"manifest.json", "api.py"}
    assert client.get("/api/atelier/extension/nope").status_code == 404
    assert client.get("/api/atelier/bogus/hello").status_code == 404


def test_propose_then_approve_a_new_widget(client, mx, capsys, monkeypatch):
    client.get("/api/atelier")                                     # migration done (nothing there)
    code, out, err = _cli(capsys, monkeypatch, "draft", "weather")
    assert code == 0 and out.strip() == str(mx["ws"] / ".atelier" / "weather")
    folder = Path(out.strip())
    assert folder.is_dir() and not any(folder.iterdir())           # a new creation: empty
    _write(folder, "weather", 7)
    code, out, err = _cli(capsys, monkeypatch, "propose", "weather", "--summary", "Shows the weather")
    assert code == 0, err
    did = _draft_id(out)
    assert "waiting for the user's approval" in out and "waiting for them in the Atelier" in out
    assert not (folder / atelier.REQUEST).exists()                 # registered in this process
    # nothing installed, nothing on the dashboard
    assert not (mx["ws"] / "extensions" / "weather").exists()
    assert all(e["id"] != "weather" for e in client.get("/api/extensions").json())
    it = next(i for i in client.get("/api/atelier").json()["items"] if i["id"] == "weather")
    assert it["state"] == "pending" and it["pending"]["draft"] == did and it["version"] is None
    assert it["pending"]["change"] == "new" and it["origin"]["agent"] == "user"
    assert set(it["actions"]) >= {"approve", "reject", "request_change"}
    ev = feed.list_events(kind="atelier.proposed")["events"][0]
    assert ev["params"]["draft_id"] == did and ev["pending"] and ev["url"] == f"/atelier/drafts/{did}"
    d = client.get(f"/api/atelier/drafts/{did}").json()
    assert d["draft"]["status"] == "pending" and d["active_version"] is None and not d["stale"]
    assert d["draft"]["summary"] == "Shows the weather" and d["draft"]["check"]["status"] in ("ok", "warn")
    assert d["preview"] == "card" and d["draft"]["files"]["added"] == 2
    api = next(f for f in d["files"] if f["path"] == "api.py")
    assert api["status"] == "added" and "+def card(ctx):" in api["diff"]
    assert client.get(f"/api/atelier/drafts/{did}/file", params={"path": "api.py"}).json()["content"] == CARD % 7
    assert [x["id"] for x in client.get("/api/atelier/drafts").json()["drafts"]] == [did]
    # the user approves it
    r = client.post(f"/api/atelier/drafts/{did}/approve", json={"base": None})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1 and r.json()["item"]["state"] == "active"
    assert (mx["ws"] / "extensions" / "weather" / "api.py").read_text() == CARD % 7
    ext = next(e for e in client.get("/api/extensions").json() if e["id"] == "weather")
    assert ext["error"] is None and ext["enabled"]
    assert not feed.list_events(kind="atelier.proposed")["events"][0]["pending"]     # resolved
    v = client.get("/api/atelier/extension/weather").json()["versions"][0]
    assert v["approval"]["by"] == "user" and v["origin"]["summary"] == "Shows the weather" and v["active"]
    assert client.post(f"/api/atelier/drafts/{did}/approve", json={}).json()["error"] == "not_pending"
    assert client.get("/api/atelier/drafts").json()["drafts"] == []
    assert client.get("/api/atelier/drafts", params={"status": "all"}).json()["drafts"][0]["status"] == "approved"


def test_a_change_shows_its_diff_and_a_stale_review_is_refused(client, mx, capsys, monkeypatch):
    _write(mx["ws"] / "extensions" / "count", "count", 1)
    _premigration(mx)
    client.get("/api/atelier")
    code, out, _ = _cli(capsys, monkeypatch, "draft", "count")
    folder = Path(out.strip())
    assert (folder / "api.py").read_text() == CARD % 1           # starts from what runs
    (folder / "api.py").write_text(CARD % 2)
    code, out, _ = _cli(capsys, monkeypatch, "propose", "count")
    did = _draft_id(out)
    d = client.get(f"/api/atelier/drafts/{did}").json()
    assert d["draft"]["change"] == "update" and d["draft"]["base"] == 1 and d["active_version"] == 1
    row = next(f for f in d["files"] if f["path"] == "api.py")
    assert row["status"] == "changed" and "-def card" not in row["diff"] and "+    return {'title': 'Hi', 'blocks': [{'type': 'stat', 'label': 'N', 'value': 2}]}" in row["diff"]
    assert next(f for f in d["files"] if f["path"] == "manifest.json")["status"] == "same"
    it = next(i for i in client.get("/api/atelier").json()["items"] if i["id"] == "count")
    assert it["state"] == "active" and it["version"] == 1 and it["pending"]["draft"] == did
    r = client.post(f"/api/atelier/drafts/{did}/approve", json={"base": 7})
    assert r.status_code == 409 and r.json()["error"] == "stale" and r.json()["active"] == 1
    assert (mx["ws"] / "extensions" / "count" / "api.py").read_text() == CARD % 1
    r = client.post(f"/api/atelier/drafts/{did}/approve", json={"base": 1})
    assert r.json()["version"] == 2
    assert (mx["ws"] / "extensions" / "count" / "api.py").read_text() == CARD % 2
    vs = client.get("/api/atelier/extension/count").json()["versions"]
    assert [(v["n"], v["active"], v["base"]) for v in vs] == [(2, True, 1), (1, False, None)]
    assert vs[1]["health"] == "ok"                                # ran without error while it was active


def test_a_broken_draft_is_never_submitted_nor_run(client, mx, capsys, monkeypatch):
    folder = mx["ws"] / ".atelier" / "bad"
    marker = mx["tmp"] / "ran"
    _write(folder, "bad", api=f"open({str(marker)!r}, 'w').write('x')\ndef card(ctx)\n    return {{}}\n")
    code, out, _ = _cli(capsys, monkeypatch, "propose", "bad")
    assert code == 1 and "api.py:2" in out and "Nothing was submitted" in out
    assert not marker.exists() and atelier.all_drafts() == []
    (folder / "api.py").write_text(f"open({str(marker)!r}, 'w').write('x')\ndef nope(ctx):\n    return {{}}\n")
    code, out, _ = _cli(capsys, monkeypatch, "propose", "bad")
    assert code == 1 and "must define card(ctx)" in out and not marker.exists()
    code, _, err = _cli(capsys, monkeypatch, "propose", "missing")
    assert code == 2 and "pilot ext draft missing" in err


def test_reject_sends_the_files_to_the_trash(client, mx, capsys, monkeypatch):
    folder = _write(mx["ws"] / ".atelier" / "nope", "nope")
    _, out, _ = _cli(capsys, monkeypatch, "propose", "nope")
    did = _draft_id(out)
    r = client.post(f"/api/atelier/drafts/{did}/reject", json={"reason": "not now"})
    assert r.status_code == 200 and r.json()["draft"]["status"] == "rejected"
    tid = r.json()["trash_id"]
    items = client.get("/api/trash").json()["items"]
    assert any(i["id"] == tid and i["kind"] == "folder" for i in items)
    assert not (mx["ws"] / "extensions" / "nope").exists()
    assert client.post(f"/api/atelier/drafts/{did}/approve").json()["error"] == "not_pending"
    shutil.rmtree(folder)
    assert client.post(f"/api/trash/{tid}/restore").status_code == 200
    assert (folder / "api.py").is_file()                          # back where the agent wrote it


def test_changes_outside_the_atelier_are_flagged_and_kept(client, mx, capsys, monkeypatch):
    d = _write(mx["ws"] / "extensions" / "clock", "clock", 1)
    _premigration(mx)
    client.get("/api/atelier")
    (d / "api.py").write_text(CARD % 5)                           # Claude in bypass mode, or a hand edit
    _reset()
    it = next(i for i in client.get("/api/atelier").json()["items"] if i["id"] == "clock")
    assert it["unreviewed"] and it["state"] == "active" and "accept" in it["actions"]
    # an approval first keeps those files as a version of their own
    _, out, _ = _cli(capsys, monkeypatch, "draft", "clock", "--reset")
    folder = Path(out.strip())
    (folder / "api.py").write_text(CARD % 9)
    _, out, _ = _cli(capsys, monkeypatch, "propose", "clock")
    assert client.post(f"/api/atelier/drafts/{_draft_id(out)}/approve").status_code == 200
    vs = client.get("/api/atelier/extension/clock").json()["versions"]
    assert [(v["n"], v["approval"]["by"]) for v in vs] == [(3, "user"), (2, None), (1, "migration")]
    assert vs[1]["note"] == "changed outside the Atelier" and vs[1]["active"] is False
    # accept: files changed by hand become a version
    (mx["ws"] / "extensions" / "clock" / "api.py").write_text(CARD % 11)
    _reset()
    assert client.post("/api/atelier/extension/clock/accept").json()["version"] == 4
    assert client.post("/api/atelier/extension/clock/accept").json()["error"] == "nothing_to_accept"
    _reset()
    assert not next(i for i in client.get("/api/atelier").json()["items"] if i["id"] == "clock")["unreviewed"]
    # a folder created outside the Atelier after the migration is unreviewed, not approved
    _write(mx["ws"] / "extensions" / "sneaky", "sneaky")
    _reset()
    it = next(i for i in client.get("/api/atelier").json()["items"] if i["id"] == "sneaky")
    assert it["unreviewed"] and it["approval"]["by"] is None and it["version"] == 1


def test_codex_proposals_are_registered_when_the_turn_ends(client, mx, topic, capsys, monkeypatch):
    s = client.post("/api/sessions", json={"path": topic, "message": "hi NOTOOL"}).json()
    wait_idle(client, s["id"])
    folder = mx["ws"] / topic / ".atelier" / "codexy"
    _write(folder, "codexy")

    def no_state(*_a, **_k):                                    # Codex's sandbox: <state> is read-only
        raise PermissionError("read-only file system")
    real = atelier.register
    monkeypatch.setattr(atelier, "register", no_state)
    code, out, _ = _cli(capsys, monkeypatch, "propose", "codexy", session=s["id"], agent="codex")
    assert code == 0 and "reaches the Atelier when this turn ends" in out
    did = _draft_id(out)
    assert (folder / atelier.REQUEST).is_file() and atelier.load_draft(did) is None
    assert client.get(f"/api/atelier/drafts/{did}").status_code == 404
    monkeypatch.setattr(atelier, "register", real)
    client.post(f"/api/sessions/{s['id']}/messages", json={"text": "again NOTOOL"})
    wait_idle(client, s["id"])
    from conftest import wait_for
    rec = wait_for(lambda: atelier.load_draft(did))
    assert rec["origin"]["agent"] == "codex" and rec["origin"]["session"] == s["id"]
    assert rec["origin"]["session_path"] == topic and not (folder / atelier.REQUEST).exists()


def test_request_change_continues_the_origin_session(client, mx, topic, capsys, monkeypatch):
    s = client.post("/api/sessions", json={"path": topic, "message": "hi NOTOOL"}).json()
    wait_idle(client, s["id"])
    folder = atelier.draft_folder("tide", s["id"])
    assert folder == mx["ws"] / topic / ".atelier" / "tide"
    _write(folder, "tide")
    _, out, _ = _cli(capsys, monkeypatch, "propose", "tide", session=s["id"], agent="claude")
    did = _draft_id(out)
    assert atelier.load_draft(did)["origin"]["session"] == s["id"]
    r = client.post(f"/api/atelier/drafts/{did}/request-change", json={"message": "Bigger numbers please"})
    assert r.status_code == 200, r.text
    assert r.json()["created"] is False and r.json()["session"]["id"] == s["id"]
    wait_idle(client, s["id"])
    log = (mx["state"] / "sessions" / f"{s['id']}.log").read_text()
    assert "Bigger numbers please" in log and f"pilot ext propose tide" in log
    d = client.get(f"/api/atelier/drafts/{did}").json()["draft"]
    assert d["status"] == "pending" and d["change_requests"][0]["message"] == "Bigger numbers please"
    assert client.post(f"/api/atelier/drafts/{did}/request-change", json={"message": " "}).json()["error"] == \
        "bad_message"
    # proposing again replaces it
    _, out, _ = _cli(capsys, monkeypatch, "propose", "tide", session=s["id"], agent="claude")
    again = _draft_id(out)
    old = atelier.load_draft(did)
    assert old["status"] == "superseded" and old["superseded_by"] == again
    assert not [e for e in feed.list_events(kind="atelier.proposed")["events"]
                if e["params"]["draft_id"] == did and e["pending"]]
    # once approved, "Ask for a fix" goes back to the session that proposed it (extfix reads the provenance)
    assert client.post(f"/api/atelier/drafts/{again}/approve").status_code == 200
    from maxxing import extfix
    assert extfix.origin("tide")["id"] == s["id"]
    assert "pilot ext draft tide" in extfix.prompt(extensions.get("tide"))


def test_auto_activation_of_safe_proposals(client, mx, capsys, monkeypatch):
    assert client.get("/api/atelier/settings").json() == {"auto_activate_safe": False, "keep_days": 90,
                                                           "keep_versions": 10}
    assert client.put("/api/atelier/settings", json={"keep_days": 0}).json()["error"] == "bad_settings"
    assert client.put("/api/atelier/settings", json={"auto_activate_safe": True}).json()["auto_activate_safe"]
    _write(mx["ws"] / ".atelier" / "safe", "safe")
    _, out, _ = _cli(capsys, monkeypatch, "propose", "safe")
    assert "activated at once" in out
    assert (mx["ws"] / "extensions" / "safe" / "api.py").is_file()
    ev = feed.list_events(kind="atelier.activated")["events"][0]
    assert ev["params"]["id"] == "safe" and ev["params"]["version"] == 1
    _write(mx["ws"] / ".atelier" / "netty", "netty",
           manifest={"id": "netty", "name": "Net", "type": "widget", "permissions": {"network": ["api.example.com"]}})
    _, out, _ = _cli(capsys, monkeypatch, "propose", "netty")
    assert "waiting for the user's approval" in out and "api.example.com" in out
    assert not (mx["ws"] / "extensions" / "netty").exists()


def test_preview_runs_the_draft_only_when_asked(client, mx, capsys, monkeypatch):
    marker = mx["tmp"] / "previewed"
    api = (f"import os\nopen({str(marker)!r}, 'w').write('x')\n"
           "def card(ctx):\n    return {'title': str(ctx['secret']('SHOP')), 'blocks': [{'type': 'stat', 'label': 'a', "
           "'value': str(ctx['secret']('OTHER'))}]}\n")
    config.set_secret("vault", {"SHOP": {"value": "s1"}, "OTHER": {"value": "s2"}})
    _write(mx["ws"] / ".atelier" / "shop", "shop", api=api,
           manifest={"id": "shop", "name": "Shop", "type": "widget", "permissions": {"secrets": ["SHOP"]}})
    _, out, _ = _cli(capsys, monkeypatch, "propose", "shop")
    did = _draft_id(out)
    client.get(f"/api/atelier/drafts/{did}")
    assert not marker.exists()                                    # listing and detail never run it
    r = client.post(f"/api/atelier/drafts/{did}/preview").json()
    assert marker.exists() and r["kind"] == "card" and r["error"] is None
    assert r["card"]["title"] == "s1" and r["card"]["blocks"][0]["value"] == "None"   # undeclared secret: None
    assert not (mx["ws"] / "extensions" / "shop").exists() and extensions.get("shop") is None


def test_html_widget_preview_frame(client, mx, capsys, monkeypatch):
    d = mx["ws"] / ".atelier" / "game"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"id": "game", "name": "Game", "type": "widget"}))
    (d / "widget.html").write_text("<div id=x>hi</div>")
    (d / "api.py").write_text("def handle(ctx, method, path, query, body):\n    return {'path': path}\n")
    _, out, _ = _cli(capsys, monkeypatch, "propose", "game")
    did = _draft_id(out)
    assert client.post(f"/api/atelier/drafts/{did}/preview").json() == {
        "kind": "html", "url": f"/ext/_drafts/{did}/widget-frame", "height": 260}
    r = client.get(f"/ext/_drafts/{did}/widget-frame")
    assert r.status_code == 200 and "<div id=x>hi</div>" in r.text
    assert r.headers["content-security-policy"].startswith("sandbox allow-scripts")
    assert client.get(f"/api/atelier/drafts/{did}/api/scores").json() == {"path": "scores"}
    client.post(f"/api/atelier/drafts/{did}/reject")
    assert client.get(f"/ext/_drafts/{did}/widget-frame").status_code == 404
    assert client.get(f"/api/atelier/drafts/{did}/api/scores").status_code == 404


def test_writes_need_the_csrf_header_and_stop_during_a_restore_hold(client, mx, capsys, monkeypatch):
    _write(mx["ws"] / ".atelier" / "held", "held")
    _, out, _ = _cli(capsys, monkeypatch, "propose", "held")
    did = _draft_id(out)
    r = client.post(f"/api/atelier/drafts/{did}/approve", headers={"X-Maxxing": ""})
    assert r.status_code == 403
    config.update_config(restore_hold=True)
    try:
        assert client.post(f"/api/atelier/drafts/{did}/approve").json()["error"] == "restore_hold"
        code, _, err = _cli(capsys, monkeypatch, "propose", "held")
        assert code == 3 and "review mode" in err
    finally:
        config.update_config(restore_hold=False)


@node
def test_page_drafts_are_checked_statically(client, mx, capsys, monkeypatch):
    d = mx["ws"] / ".atelier" / "notes"
    (d / "lib").mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"id": "notes", "name": "Notes", "type": "page"}))
    (d / "page.js").write_text("import { x } from './lib/x.js'\nimport './missing.js'\n"
                               "export function mount(el, ctx) { el.textContent = x }\n")
    (d / "lib" / "x.js").write_text("export const x = 1\n")
    code, out, _ = _cli(capsys, monkeypatch, "propose", "notes")
    assert code == 1 and "missing.js" in out
    (d / "page.js").write_text("import { x } from './lib/x.js'\nexport function mount(el, ctx) { el.textContent = x }\n")
    code, out, _ = _cli(capsys, monkeypatch, "propose", "notes")
    assert code == 0
    did = _draft_id(out)
    assert client.post(f"/api/atelier/drafts/{did}/preview").json() == {"kind": "none", "reason": "page"}
    assert client.post(f"/api/atelier/drafts/{did}/approve").status_code == 200
    it = next(i for i in client.get("/api/atelier").json()["items"] if i["id"] == "notes")
    assert it["type"] == "page" and it["href"] == "/x/notes"


def test_check_dir_runs_the_draft_in_this_process(client, mx, capsys, monkeypatch):
    folder = _write(mx["ws"] / ".atelier" / "probe", "probe",
                    api="def card(ctx):\n    raise RuntimeError('boom')\n")
    code, out, _ = _cli(capsys, monkeypatch, "check", "probe", "--dir", str(folder))
    assert code == 1 and "boom" in out
    (folder / "api.py").write_text(CARD % 3)
    code, out, _ = _cli(capsys, monkeypatch, "check", "probe", "--dir", str(folder))
    assert code == 0 and "1 block(s)" in out
    assert not (mx["ws"] / "extensions" / "probe").exists()
    assert extensions._root_override is None and extensions.disabled_ids() == set()


def test_pins_are_recorded_as_approved_by_the_user(client, mx):
    client.get("/api/atelier")
    r = client.post("/api/blocks/pin", json={"type": "stats", "data": {"items": [{"label": "a", "value": 1}]}})
    eid = r.json()["id"]
    it = next(i for i in client.get("/api/atelier").json()["items"] if i["id"] == eid)
    assert it["type"] == "pin" and it["approval"]["by"] == "user" and not it["unreviewed"]


def _version_of(client, eid, value, capsys, monkeypatch):
    _, out, _ = _cli(capsys, monkeypatch, "draft", eid)
    folder = Path(out.strip())
    (folder / "api.py").write_text(CARD % value)
    _, out, _ = _cli(capsys, monkeypatch, "propose", eid)
    r = client.post(f"/api/atelier/drafts/{_draft_id(out)}/approve")
    assert r.status_code == 200, r.text
    return r.json()["version"]


def test_rollback_restores_a_kept_version(client, mx, capsys, monkeypatch):
    d = _write(mx["ws"] / "extensions" / "meter", "meter", 1)
    _premigration(mx)
    client.get("/api/atelier")
    assert _version_of(client, "meter", 2, capsys, monkeypatch) == 2
    assert _version_of(client, "meter", 3, capsys, monkeypatch) == 3
    r = client.post("/api/atelier/extension/meter/rollback", json={"version": 1})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1 and r.json()["item"]["version"] == 1
    assert (d / "api.py").read_text() == CARD % 1 and extensions.get("meter").error is None
    det = client.get("/api/atelier/extension/meter").json()
    assert [(v["n"], v["active"]) for v in det["versions"]] == [(3, False), (2, False), (1, True)]
    assert det["history"][0]["action"] == "rollback" and det["history"][0]["note"] == "from v3"
    assert not det["item"]["unreviewed"]
    # the same version again: nothing to do
    assert client.post("/api/atelier/extension/meter/rollback", json={"version": 1}).json()["version"] == 1
    # files changed by hand are kept as a version before a rollback replaces them
    (d / "api.py").write_text(CARD % 42)
    _reset()
    assert client.post("/api/atelier/extension/meter/rollback", json={"version": 3}).json()["version"] == 3
    vs = client.get("/api/atelier/extension/meter").json()["versions"]
    assert vs[0]["n"] == 4 and vs[0]["note"] == "changed outside the Atelier" and not vs[0]["active"]
    assert (d / "api.py").read_text() == CARD % 3
    # diffs between versions
    v = client.get("/api/atelier/extension/meter/versions/3").json()
    assert v["against"] == 2 and "+    return {'title': 'Hi', 'blocks': [{'type': 'stat', 'label': 'N', 'value': 3}]}" \
        in next(f for f in v["files"] if f["path"] == "api.py")["diff"]
    assert client.get("/api/atelier/extension/meter/versions/1", params={"against": "active"}).json()["against"] == 3
    assert client.get("/api/atelier/extension/meter/versions/99").status_code == 404
    assert client.post("/api/atelier/extension/meter/rollback", json={"version": 99}).json()["error"] == "not_found"
    assert client.post("/api/atelier/extension/meter/rollback", json={"version": "x"}).json()["error"] == "bad_version"
    assert client.post("/api/atelier/theme/x/rollback", json={"version": 1}).json()["error"] == "not_versioned"


def test_retention_keeps_recent_or_newest_versions(client, mx, capsys, monkeypatch):
    _write(mx["ws"] / "extensions" / "keep", "keep", 0)
    _premigration(mx)
    client.get("/api/atelier")
    for i in range(1, 5):
        _version_of(client, "keep", i, capsys, monkeypatch)        # v2..v5, v5 active
    client.put("/api/atelier/settings", json={"keep_days": 1, "keep_versions": 2})
    later = __import__("time").time() + 3 * 86400
    res = atelier.prune(now=later)
    assert res["versions"] == 3 and res["objects"] >= 1
    assert [v["n"] for v in client.get("/api/atelier/extension/keep").json()["versions"]] == [5, 4]
    assert client.post("/api/atelier/extension/keep/rollback", json={"version": 4}).status_code == 200
    assert (mx["ws"] / "extensions" / "keep" / "api.py").read_text() == CARD % 3
    assert not atelier.prune_due(now=later + 10) and atelier.prune_due(now=later + 2 * 86400)


def test_memory_backup_keeps_the_provenance(client, mx, capsys, monkeypatch):
    _write(mx["ws"] / "extensions" / "prov", "prov", 1)
    _premigration(mx)
    client.get("/api/atelier")
    _version_of(client, "prov", 2, capsys, monkeypatch)
    meta = atelier.export_meta()
    assert set(meta["items"]) == {"extension:prov"}
    blob = json.dumps(meta)
    assert len(blob) < 8000 and "def card" not in blob                 # no file contents
    from maxxing import backup
    assert json.loads(backup.snapshot()["_maxxing/atelier.json"]) == meta
    # a new server: the files come back with the workspace, the provenance with _maxxing/atelier.json
    shutil.rmtree(mx["state"] / "atelier")
    _reset()
    assert atelier.import_meta(meta) == 1
    _reset()
    det = client.get("/api/atelier/extension/prov").json()
    assert [(v["n"], v["approval"]["by"]) for v in det["versions"]] == [(2, "user"), (1, "migration")]
    assert det["versions"][0]["restorable"] and not det["versions"][1]["restorable"]   # its files are on disk again
    assert not det["item"]["unreviewed"]
    assert client.post("/api/atelier/extension/prov/rollback", json={"version": 1}).json()["error"] == "not_restorable"
    assert atelier.import_meta(meta) == 0                              # approved here: this server's record wins
