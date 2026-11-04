"""Extension permissions: the manifest's "permissions" (maxxing/permissions.py), listed and checked."""
import json

import pytest

from _org_helpers import client, org  # noqa: F401
from maxxing import extcheck, permissions


def _ext(org, eid, manifest, api=None, **files):
    d = org.ws / "extensions" / eid
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(json.dumps(manifest))
    if api is not None:
        (d / "api.py").write_text(api)
    for name, text in files.items():
        (d / name.replace("_", ".", 1)).write_text(text)
    return d


CARD = "def card(ctx):\n    return {'blocks': [{'type': 'stat', 'label': 'x', 'value': 1}]}\n"


def test_parse_normalises_and_dedupes():
    assert permissions.parse(None) is None
    assert permissions.parse({}) == {"network": [], "secrets": [], "read": []}
    got = permissions.parse({"network": ["API.example.com", "api.example.com", "*.cdn.example.com:8443"],
                             "secrets": ["SHOP_TOKEN", "SHOP_TOKEN", "B2"],
                             "read": ["projects/shop/", "./tasks.json", "projects//shop", ".", "a/./b"]})
    assert got == {"network": ["api.example.com", "*.cdn.example.com:8443"], "secrets": ["SHOP_TOKEN", "B2"],
                   "read": ["projects/shop", "tasks.json", ".", "a/b"]}
    assert permissions.view(got) == {**got, "declared": True}
    assert permissions.view(None) == {"network": [], "secrets": [], "read": [], "declared": False}
    assert permissions.summary(got) == ("network: api.example.com, *.cdn.example.com:8443 · keys: SHOP_TOKEN, B2 · "
                                        "reads: projects/shop, tasks.json, ., a/b")
    assert permissions.summary({"network": [], "secrets": [], "read": []}) == "nothing"
    assert permissions.summary(None) == "not declared"


@pytest.mark.parametrize("raw, words", [
    (["network"], "must be an object"),
    ({"net": []}, "unsupported key(s) net"),
    ({"network": "api.example.com"}, "permissions.network must list"),
    ({"network": ["https://api.example.com"]}, "no https://"),
    ({"network": ["api.example.com/v1"]}, "no https://"),
    ({"network": ["localhost"]}, "host name"),
    ({"network": [f"h{i}.example.com" for i in range(9)]}, "at most 8"),
    ({"secrets": ["shop_token"]}, "Settings -> Keys"),
    ({"secrets": [1]}, "Settings -> Keys"),
    ({"read": ["/etc/passwd"]}, "relative to the workspace"),
    ({"read": ["~/.ssh"]}, "relative to the workspace"),
    ({"read": ["projects/../../etc"]}, "no .."),
    ({"read": ["a\\b"]}, "relative to the workspace"),
    ({"read": [""]}, "path of the workspace"),
    ({"read": ["x" * 301]}, "path of the workspace"),
])
def test_parse_refuses(raw, words):
    with pytest.raises(ValueError) as e:
        permissions.parse(raw)
    assert words in str(e.value)


def test_listed_and_a_bad_declaration_is_the_extension_error(client, org):
    _ext(org, "shop", {"type": "widget", "permissions": {"secrets": ["SHOP_TOKEN"], "network": ["api.example.com"]}},
         CARD)
    _ext(org, "plain", {"type": "widget"}, CARD)
    _ext(org, "bad", {"type": "widget", "permissions": {"network": ["https://x.example.com"]}}, CARD)
    blk = org.ws / "extensions" / "map"
    blk.mkdir()
    (blk / "block.json").write_text(json.dumps({"type": "block", "renders": ["map"],
                                                "permissions": {"network": ["tiles.example.com"]}}))
    (blk / "block.html").write_text("<div></div>")
    lst = {e["id"]: e for e in client.get("/api/extensions").json()}
    assert lst["shop"]["permissions"] == {"network": ["api.example.com"], "secrets": ["SHOP_TOKEN"], "read": []}
    assert lst["shop"]["error"] is None
    assert lst["plain"]["permissions"] is None and lst["plain"]["error"] is None
    assert "no https://" in lst["bad"]["error"] and lst["bad"]["permissions"] is None
    assert lst["map"]["permissions"] == {"network": ["tiles.example.com"], "secrets": [], "read": []}


def test_ext_check_reports_the_declaration(org):
    _ext(org, "shop", {"type": "widget", "permissions": {"secrets": ["SHOP_TOKEN"], "read": ["projects"]}}, CARD)
    _ext(org, "plain", {"type": "widget"}, CARD)
    r = extcheck.check("shop")
    assert r["status"] == "warn" and r["permissions"]["secrets"] == ["SHOP_TOKEN"]     # the key waits for the user
    assert {"step": "permissions", "status": "ok", "detail": "declares keys: SHOP_TOKEN · reads: projects"} in r["steps"]
    r = extcheck.check("plain")
    assert r["status"] == "warn" and r["permissions"] is None
    assert any(s["step"] == "permissions" and s["status"] == "warn" and "declares no" in s["detail"] for s in r["steps"])


# ---- keys: what ctx["secret"] answers ---------------------------------------------------------------------------------
SECRET_CARD = ("def card(ctx):\n"
               "    v = ctx['secret']('SHOP_TOKEN')\n"
               "    return {'blocks': [{'type': 'stat', 'label': 'token', 'value': v or 'none'}]}\n")
SECRET_API = ("def handle(ctx, method, path, query, body):\n"
              "    return {'token': ctx['secret']('SHOP_TOKEN')}\n")


def _fresh_baseline(org, *before):
    """As if this version first scanned now: the extensions passed exist before permissions (grandfathered)."""
    from maxxing import extensions
    (org.state / permissions.FILE).unlink(missing_ok=True)
    permissions._cache.update(key=None, data=None)
    for make in before:
        make()
    extensions.scan()


def _widget(client, wid):
    return next(w for w in client.get("/api/dashboard").json()["widgets"] if w["id"] == wid)


def test_grandfathered_extension_keeps_its_keys_and_they_are_recorded(client, org):
    from maxxing import exterrors, feed, vault
    vault.put("SHOP_TOKEN", "tok-123")
    vault.put("OTHER", "o")
    _fresh_baseline(org, lambda: _ext(org, "old", {"type": "widget"}, SECRET_CARD))
    w = _widget(client, "old")
    assert w["error"] is None and w["card"]["blocks"][0]["value"] == "tok-123"
    x = {e["id"]: e for e in client.get("/api/extensions").json()}["old"]
    assert x["access"]["state"] == "legacy" and x["access"]["pending"] is False
    assert [s["name"] for s in x["access"]["legacy"]["secrets"]] == ["SHOP_TOKEN"]
    assert x["access"]["secrets"][0]["status"] == "allowed" and x["access"]["secrets"][0]["how"] == "legacy"
    [ev] = feed.list_events(kind="extension.legacy_secrets")["events"]
    assert ev["params"]["secrets"] == "SHOP_TOKEN" and ev["source"] == "security"
    # another key later: recorded too, the notice lists both (folded into the same row)
    (org.ws / "extensions" / "old" / "api.py").write_text(
        SECRET_CARD.replace("v = ctx['secret']('SHOP_TOKEN')", "v = ctx['secret']('SHOP_TOKEN') + ctx['secret']('OTHER')"))
    assert client.get("/api/dashboard?force=1").status_code == 200
    evs = feed.list_events(kind="extension.legacy_secrets")["events"]
    assert len(evs) == 1 and evs[0]["params"]["secrets"] == "OTHER, SHOP_TOKEN"
    d = client.get("/api/extensions/old/permissions").json()
    assert d["suggested"] == {"network": [], "secrets": ["OTHER", "SHOP_TOKEN"], "read": []}
    assert d["permissions"] is None and d["access"]["denied"] == []
    assert exterrors.recent("old", org.ws / "extensions" / "old") == []
    # declaring them keeps them allowed without asking again
    _ext(org, "old", {"type": "widget", "permissions": {"secrets": ["SHOP_TOKEN", "OTHER"]}})
    x = {e["id"]: e for e in client.get("/api/extensions").json()}["old"]
    assert x["access"]["state"] == "declared" and not x["access"]["pending"]
    assert _widget(client, "old")["error"] is None


def test_new_extension_without_declaration_reads_no_key(client, org):
    from maxxing import exterrors, vault
    vault.put("SHOP_TOKEN", "tok-123")
    _fresh_baseline(org)
    _ext(org, "fresh", {"type": "widget"}, SECRET_CARD)
    w = _widget(client, "fresh")
    assert w["card"] is None and 'declares no "permissions"' in w["error"]
    assert w["permission"] == {"kind": "secret", "name": "SHOP_TOKEN", "reason": "undeclared"}
    x = {e["id"]: e for e in client.get("/api/extensions").json()}["fresh"]
    assert x["access"]["state"] == "undeclared"
    assert [(d["name"], d["reason"], d["count"]) for d in x["access"]["denied"]] == [("SHOP_TOKEN", "undeclared", 1)]
    [err] = exterrors.recent("fresh", org.ws / "extensions" / "fresh")
    assert err["where"] == "card" and err["message"].startswith("PermissionDenied: manifest.json declares no")
    assert client.post("/api/extensions/fresh/consent", json={"decision": "always"}).status_code == 400


def test_declared_keys_wait_for_the_user(client, org):
    from maxxing import vault
    vault.put("SHOP_TOKEN", "tok-123")
    _fresh_baseline(org)
    _ext(org, "shop", {"type": "widget", "permissions": {"secrets": ["SHOP_TOKEN"]}}, SECRET_CARD)
    w = _widget(client, "shop")
    assert w["permission"]["reason"] == "not_allowed" and "waits for your permission" in w["error"]
    x = {e["id"]: e for e in client.get("/api/extensions").json()}["shop"]
    assert x["access"]["pending"] is True and x["access"]["secrets"][0]["status"] == "pending"
    r = client.post("/api/extensions/shop/consent", json={"decision": "always"}).json()
    assert r["ok"] and r["access"]["secrets"][0] == {**r["access"]["secrets"][0], "status": "allowed", "how": "accepted"}
    assert _widget(client, "shop")["card"]["blocks"][0]["value"] == "tok-123"
    # refused: every key, not asked again; reset: asked again
    assert client.post("/api/extensions/shop/consent", json={"decision": "deny"}).json()["access"]["refused"] is True
    assert _widget(client, "shop")["permission"]["reason"] == "refused"
    r = client.post("/api/extensions/shop/consent", json={"decision": "reset"}).json()
    assert r["access"]["refused"] is False and r["access"]["pending"] is True
    # a key the manifest does not list is refused even when the others are allowed
    client.post("/api/extensions/shop/consent", json={"decision": "always"})
    (org.ws / "extensions" / "shop" / "api.py").write_text(SECRET_CARD.replace("'SHOP_TOKEN'", "'OTHER_KEY'"))
    w = _widget(client, "shop")
    assert w["permission"] == {"kind": "secret", "name": "OTHER_KEY", "reason": "undeclared"}
    assert "not in manifest.json" in w["error"]
    assert client.post("/api/extensions/nope/consent", json={"decision": "always"}).status_code == 404
    r = client.post("/api/extensions/shop/consent", json={"decision": "once"})          # once: sites only
    assert r.status_code == 400 and r.json()["error"] == "no_network"


def test_api_refusal_is_a_403_and_accept_is_the_atelier_hook(client, org):
    from maxxing import exterrors, vault
    vault.put("SHOP_TOKEN", "tok-123")
    _fresh_baseline(org)
    _ext(org, "page", {"type": "page", "permissions": {"secrets": ["SHOP_TOKEN"]}}, SECRET_API,
         page_js="export function mount(){}")
    r = client.get("/api/ext/page/x")
    assert r.status_code == 403
    d = r.json()
    assert d["error"] == "permission_required" and d["permission"]["reason"] == "not_allowed"
    [err] = exterrors.recent("page", org.ws / "extensions" / "page")
    assert err["where"] == "api" and "PermissionDenied" in err["message"]
    permissions.accept("page")
    assert client.get("/api/ext/page/x").json() == {"token": "tok-123"}
    allp = client.get("/api/extensions/permissions").json()
    assert allp["since"] and [i["id"] for i in allp["items"]] == ["page"]
    permissions.forget("page")
    assert client.get("/api/ext/page/x").status_code == 403


def test_a_caught_refusal_is_still_recorded_once_a_minute(client, org):
    _fresh_baseline(org)
    _ext(org, "quiet", {"type": "widget", "permissions": {}},
         "def card(ctx):\n    try:\n        ctx['secret']('NOPE')\n    except PermissionError:\n        pass\n"
         "    return {'blocks': [{'type': 'stat', 'label': 'x', 'value': 1}]}\n")
    for _ in range(3):
        assert client.get("/api/dashboard?force=1").status_code == 200
    x = {e["id"]: e for e in client.get("/api/extensions").json()}["quiet"]
    assert [(d["name"], d["count"]) for d in x["access"]["denied"]] == [("NOPE", 1)]


def test_ext_check_tells_what_the_keys_need(org):
    from maxxing import extensions
    _fresh_baseline(org)
    _ext(org, "wait", {"type": "widget", "permissions": {"secrets": ["SHOP_TOKEN"]}}, SECRET_CARD)
    _ext(org, "undecl", {"type": "widget", "permissions": {}}, SECRET_CARD)
    _ext(org, "newbie", {"type": "widget"}, SECRET_CARD)
    r = extcheck.check("wait")
    assert r["status"] == "warn" and r["permission"]["reason"] == "not_allowed"
    assert any("waits for the user's permission to read SHOP_TOKEN" in s["detail"] for s in r["steps"])
    r = extcheck.check("undecl")
    assert r["status"] == "error"
    assert any(s["detail"].startswith("api.py:2 reads the key SHOP_TOKEN, which manifest.json does not declare")
               for s in r["steps"])
    r = extcheck.check("newbie")
    assert r["status"] == "error" and any('"secrets": ["SHOP_TOKEN"]' in s["detail"] for s in r["steps"])
    # the check's own runs record nothing
    assert all(permissions.access(e)["denied"] == [] for e in extensions.all_extensions())


# ---- the HTML widget frame's network ----------------------------------------------------------------------------------
WIDGET_HTML = "<div id=a></div><script>fetch('https://api.example.com/x')</script>"


def _frame(client, eid, grant=""):
    import re
    r = client.get(f"/ext/{eid}/widget-frame" + (f"?grant={grant}" if grant else ""))
    assert r.status_code == 200, r.text
    m = re.search(r'<base href="(/ext/[a-z0-9-]+/f/[^/"]+/)">', r.text)
    return r, m.group(1)


def test_declared_widget_frame_reaches_only_allowed_sites(client, org):
    from fastapi.testclient import TestClient
    _fresh_baseline(org)
    d = _ext(org, "net", {"type": "widget", "permissions": {"network": ["api.example.com"]}}, widget_html=WIDGET_HTML)
    (d / "lib").mkdir()
    (d / "lib" / "chart.js").write_text("window.chart = 1\n")
    (d / ".env").write_text("SECRET=1\n")
    (d / "data.json").write_text('{"a": 1}')
    r, base = _frame(client, "net")
    csp = r.headers["content-security-policy"]
    assert csp.startswith("sandbox allow-scripts allow-pointer-lock; default-src 'none';")
    assert "connect-src 'self';" in csp and "api.example.com" not in csp and "frame-ancestors 'self'" in csp
    assert "content-security-policy-report-only" not in r.headers
    # the frame's own files, without a cookie (the sandboxed frame sends none), with the token only
    anon = TestClient(client.app)
    f = anon.get(base + "lib/chart.js")
    assert f.status_code == 200 and f.text == "window.chart = 1\n"
    assert f.headers["access-control-allow-origin"] == "*" and "sandbox" in f.headers["content-security-policy"]
    assert f.headers["content-type"].startswith("text/javascript")
    assert anon.get(base + "data.json").json() == {"a": 1}
    for bad in ("api.py", "manifest.json/../api.py", ".env", "widget.html"):
        assert anon.get(base + bad).status_code == 404, bad
    assert anon.get(base.replace("/f/", "/f/x") + "lib/chart.js").status_code == 404
    assert anon.get(base.replace("/ext/net/", "/ext/other/") + "lib/chart.js").status_code == 404
    # the dashboard asks; Allow lets the frame reach the declared site
    [w] = [w for w in client.get("/api/dashboard").json()["widgets"] if w["id"] == "net"]
    assert w["card"]["network"] == {"state": "ask", "hosts": ["api.example.com"]}
    x = {e["id"]: e for e in client.get("/api/extensions").json()}["net"]
    assert x["access"]["pending"] and x["access"]["network"][0]["host"] == "api.example.com"
    once = client.post("/api/extensions/net/consent", json={"decision": "once"}).json()
    assert once["grant"] and "connect-src 'self' https://api.example.com;" in _frame(
        client, "net", once["grant"])[0].headers["content-security-policy"]
    assert "api.example.com" not in _frame(client, "net")[0].headers["content-security-policy"]
    client.post("/api/extensions/net/consent", json={"decision": "always"})
    csp = _frame(client, "net")[0].headers["content-security-policy"]
    assert "connect-src 'self' https://api.example.com;" in csp and "img-src data: blob: 'self' https://api.example.com;" in csp
    assert "script-src 'unsafe-inline' 'unsafe-eval' 'self';" in csp            # scripts: never another site
    [w] = [w for w in client.get("/api/dashboard").json()["widgets"] if w["id"] == "net"]
    assert w["card"]["network"]["state"] == "granted"
    client.post("/api/extensions/net/consent", json={"decision": "deny"})
    assert "api.example.com" not in _frame(client, "net")[0].headers["content-security-policy"]


def test_grandfathered_widget_keeps_its_network_and_its_sites_are_recorded(client, org):
    from fastapi.testclient import TestClient
    from maxxing import feed
    from maxxing.api import extframes
    _fresh_baseline(org, lambda: _ext(org, "oldnet", {"type": "widget"}, widget_html=WIDGET_HTML))
    _ext(org, "newnet", {"type": "widget"}, widget_html=WIDGET_HTML)
    r, base = _frame(client, "oldnet")
    assert r.headers["content-security-policy"] == "sandbox allow-scripts allow-pointer-lock; frame-ancestors 'self'"
    ro = r.headers["content-security-policy-report-only"]
    assert ro.startswith("default-src 'none';") and ro.endswith(f"report-uri {base}@csp-report") and "sandbox" not in ro
    anon = TestClient(client.app)
    report = {"csp-report": {"document-uri": "http://t" + base, "blocked-uri": "https://API.example.com/v1/x?q=1",
                             "effective-directive": "connect-src"}}
    assert anon.post(base + "@csp-report", json=report,
                     headers={"Content-Type": "application/csp-report"}).status_code == 204
    anon.post(base + "@csp-report", content=json.dumps([{"type": "csp-violation", "body": {
        "blockedURL": "wss://live.example.com:8443/socket", "effectiveDirective": "connect-src"}}]))
    anon.post(base + "@csp-report", json={"csp-report": {"blocked-uri": "inline"}})
    x = {e["id"]: e for e in client.get("/api/extensions").json()}["oldnet"]
    assert [h["host"] for h in x["access"]["legacy"]["network"]] == ["api.example.com", "live.example.com:8443"]
    assert x["access"]["network_open"] is True and x["access"]["state"] == "legacy"
    [ev] = feed.list_events(kind="extension.legacy_network")["events"]
    assert ev["params"]["hosts"] == "api.example.com, live.example.com:8443"
    ro = _frame(client, "oldnet")[0].headers["content-security-policy-report-only"]
    assert "connect-src 'self' https://api.example.com https://live.example.com:8443;" in ro   # known: not reported again
    assert client.get("/api/extensions/oldnet/permissions").json()["suggested"]["network"] == [
        "api.example.com", "live.example.com:8443"]
    [w] = [w for w in client.get("/api/dashboard").json()["widgets"] if w["id"] == "oldnet"]
    assert w["card"]["network"]["state"] == "open"
    # a widget created after permissions: no network, nothing reported
    r, base2 = _frame(client, "newnet")
    assert "connect-src 'self';" in r.headers["content-security-policy"]
    assert "content-security-policy-report-only" not in r.headers
    anon.post(base2 + "@csp-report", json=report)
    assert {e["id"]: e for e in client.get("/api/extensions").json()}["newnet"]["access"]["legacy"]["network"] == []
    # declaring them keeps them allowed
    _ext(org, "oldnet", {"type": "widget", "permissions": {"network": ["api.example.com"]}})
    assert "connect-src 'self' https://api.example.com;" in _frame(client, "oldnet")[0].headers["content-security-policy"]
    assert extframes.report_hosts(b"not json") == []


def test_ext_check_html_widget_network(org):
    _fresh_baseline(org, lambda: _ext(org, "legacy", {"type": "widget"}, widget_html=(
        '<script src="https://cdn.example.com/chart.js"></script><script>fetch("https://api.example.com/x")</script>')))
    d = _ext(org, "strict", {"type": "widget", "permissions": {"network": ["api.example.com"]}}, widget_html=(
        '<script src="https://cdn.example.com/chart.js"></script><script src="lib/own.js"></script>'
        '<script>fetch("https://api.example.com/x"); fetch("https://other.example.org/y")</script>'))
    (d / "lib").mkdir()
    (d / "lib" / "own.js").write_text("var own = 1\n")
    r = extcheck.check("strict")
    errors, warns = _steps(r, "error"), _steps(r, "warn")
    assert any("https://cdn.example.com/chart.js - scripts and styles load only inline" in e for e in errors)
    assert not any("own.js" in e for e in errors) and "lib/own.js" in r["files"]
    assert any("names other.example.org" in w for w in warns) and not any("names api.example.com" in w for w in warns)
    assert any("waits for the user's permission to reach api.example.com" in w for w in warns)
    r = extcheck.check("legacy")
    assert r["status"] == "warn"
    assert any('"network": ["api.example.com", "cdn.example.com"]' in w for w in _steps(r, "warn"))


def _steps(r, status):
    return [s["detail"] for s in r["steps"] if s["status"] == status]


def test_runtime_error_stacks_of_frame_files_stay_short():
    from maxxing import exterrors
    stack = ("at draw (https://ui.example.com/ext/w/f/Ab_c-1/lib/chart.js:12:5)\n"
             "at https://ui.example.com/ext/w/widget-frame?grant=x-Y#%7B%7D:60:3")
    assert exterrors.trim_stack(stack, "w", 50) == "at draw (lib/chart.js:12:5)\nat widget.html:10:3"
