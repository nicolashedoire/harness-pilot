"""Runtime errors of extensions (maxxing/exterrors.py, POST/DELETE /api/extensions/{id}/errors, recorded handle()
and card() failures, `runtime_errors` in GET /api/extensions)."""
import json
import os
import time

from _org_helpers import client, org  # noqa: F401
from maxxing import exterrors
from maxxing.api import extensions as api_ext


def _ext(org, eid, manifest, **files):
    d = org.ws / "extensions" / eid
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(json.dumps(manifest))
    for name, text in files.items():
        (d / name.replace("_", ".", 1)).write_text(text)
    return d


def _errors(client, eid):
    return next(e for e in client.get("/api/extensions").json() if e["id"] == eid)["runtime_errors"]


def _post(client, eid, **body):
    return client.post(f"/api/extensions/{eid}/errors", json=body)


def test_report_trim_and_count(client, org):
    _ext(org, "notes", {"type": "page"}, page_js="export function mount() {}\n")
    assert _errors(client, "notes") == []
    stack = "\n".join(["TypeError: x.map is not a function",
                       "    at render (https://ui.example.com/ext/notes/@1712/lib/list.js?v=3:12:5)",
                       "    at mount (https://ui.example.com/ext/notes/@1712/page.js:40:3)",
                       "    at https://ui.example.com/assets/index-abc.js:1:200", "", *[f"    at f{i}" for i in range(9)]])
    r = _post(client, "notes", where="page", message="TypeError: x.map is not a function", stack=stack)
    assert r.status_code == 200, r.text
    item = r.json()["error"]
    assert item["count"] == 1 and item["where"] == "page"
    assert item["stack"].splitlines() == ["TypeError: x.map is not a function", "at render (lib/list.js:12:5)",
                                          "at mount (page.js:40:3)", "at /assets/index-abc.js:1:200", "at f0", "at f1"]
    assert _post(client, "notes", where="page", message="TypeError: x.map is not a function").json()["error"]["count"] == 2
    _post(client, "notes", where="page", message="x" * 3000)
    errs = _errors(client, "notes")
    assert [e["count"] for e in errs] == [1, 2] and len(errs[0]["message"]) == exterrors.MESSAGE_MAX
    assert set(errs[0]) == {"where", "message", "stack", "at", "count"}


def test_widget_frame_lines_become_widget_html_lines(client, org):
    _ext(org, "game", {"type": "widget"}, widget_html="<canvas></canvas>\n<script>\nboom()\n</script>\n")
    frame = client.get("/ext/game/widget-frame").text
    line = frame.splitlines().index("boom()") + 1                 # where the browser reports it in the frame
    r = _post(client, "game", where="widget", message="ReferenceError: boom is not defined",
              stack=f"ReferenceError: boom is not defined\n    at https://ui.example.com/ext/game/widget-frame:{line}:1")
    assert r.json()["error"]["stack"].splitlines()[1] == "at widget.html:3:1"


def test_errors_since_the_last_change_and_clear(client, org):
    d = _ext(org, "w", {"type": "widget"}, widget_html="<p>x</p>")
    _post(client, "w", where="widget", message="first")
    assert [e["message"] for e in _errors(client, "w")] == ["first"]
    later = time.time() + 5
    os.utime(d / "widget.html", (later, later))                 # an agent fixed the widget
    assert _errors(client, "w") == []
    _post(client, "w", where="widget", message="second")
    assert [e["message"] for e in _errors(client, "w")] == ["second"]
    assert client.delete("/api/extensions/w/errors").json() == {"ok": True}
    assert _errors(client, "w") == []
    assert client.delete("/api/extensions/nope/errors").status_code == 404


def test_keeps_the_last_ten(client, org):
    _ext(org, "w", {"type": "widget"}, widget_html="<p>x</p>")
    for i in range(14):
        assert _post(client, "w", where="widget", message=f"e{i}").status_code == 200
    assert [e["message"] for e in _errors(client, "w")] == [f"e{i}" for i in range(13, 3, -1)]


def test_refused_reports(client, org, monkeypatch):
    _ext(org, "w", {"type": "widget"}, widget_html="<p>x</p>")
    assert _post(client, "nope", where="page", message="x").status_code == 404
    assert _post(client, "w", where="api", message="x").status_code == 422            # the server's own kinds
    assert _post(client, "w", where="page", message="").status_code == 422
    assert _post(client, "w", where="page", message="x" * 4001).status_code == 422
    r = client.post("/api/extensions/w/errors", json={"where": "page", "message": "x"}, headers={"X-Maxxing": ""})
    assert r.status_code == 403
    monkeypatch.setattr(exterrors, "_hits", {})
    monkeypatch.setattr(exterrors, "RATE_PER_EXT", 3)
    codes = [_post(client, "w", where="page", message=f"m{i}").status_code for i in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    assert len(_errors(client, "w")) == 3
    assert exterrors.allow("w", now=time.time() + exterrors.RATE_WINDOW_S + 1)       # the window slides


def test_failing_handle_is_recorded(client, org):
    _ext(org, "api-boom", {"type": "page"}, page_js="export function mount() {}\n",
         api_py="def helper(q):\n    return len(q) / 0\n\n\ndef handle(ctx, method, path, query, body):\n"
                "    if path == 'ok':\n        return {'ok': True}\n    return helper(query)\n")
    assert client.get("/api/ext/api-boom/ok").status_code == 200
    assert client.get("/api/ext/api-boom/list").status_code == 500
    [err] = _errors(client, "api-boom")
    assert err["where"] == "api" and err["message"] == "ZeroDivisionError: division by zero"
    assert err["stack"].splitlines() == ["api.py:8 in handle: return helper(query)", "api.py:2 in helper: return len(q) / 0"]


def test_failing_card_is_recorded(client, org):
    _ext(org, "boom", {"type": "widget"}, api_py="def card(ctx):\n    return 1 / 0\n")
    _ext(org, "broken", {"type": "widget"}, api_py="def card(ctx)\n")                    # does not load: not recorded
    w = {x["id"]: x for x in client.get("/api/dashboard").json()["widgets"]}
    assert w["boom"]["error"] == "ZeroDivisionError: division by zero"
    assert w["broken"]["error"]
    [err] = _errors(client, "boom")
    assert err["where"] == "card" and err["stack"] == "api.py:2 in card: return 1 / 0"
    assert _errors(client, "broken") == []
    client.get("/api/dashboard/widgets/boom?force=1")
    assert _errors(client, "boom")[0]["count"] == 2


def test_the_bridge_reports_frame_errors(client, org):
    _ext(org, "w", {"type": "widget"}, widget_html="<p>x</p>")
    frame = client.get("/ext/w/widget-frame").text
    assert "addEventListener('unhandledrejection'" in frame and "mx:'error'" in frame
    assert api_ext._frame_offset() == frame.split("<p>x</p>")[0].count("\n")


def test_ext_check_shows_what_broke_while_it_ran(client, org, capsys):
    from maxxing import cli
    _ext(org, "game", {"type": "widget", "permissions": {}}, widget_html="<p id=p></p><script>p.textContent = 'ok'</script>")
    _post(client, "game", where="widget", message="ReferenceError: boom is not defined", stack="at /ext/game/widget-frame:9:1")
    assert cli.main(["ext", "check", "game", "--json"]) == 0                # the check itself passes
    [r] = json.loads(capsys.readouterr().out)["extensions"]
    assert r["status"] == "ok" and [e["message"] for e in r["runtime_errors"]] == ["ReferenceError: boom is not defined"]
    assert cli.main(["ext", "check", "game"]) == 0
    out = capsys.readouterr().out
    assert "recorded while it ran (since its files last changed): 1" in out and "boom is not defined" in out
