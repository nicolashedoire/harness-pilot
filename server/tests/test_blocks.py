"""Conversation blocks: built-in schemas, block plugin manifests, the /api/blocks endpoints, the sandboxed frames,
dashboard pins and the list of enabled types written for the agents (Claude Code and Codex)."""
import json
from pathlib import Path

import pytest

import _org_helpers
from _org_helpers import org  # noqa: F401
from maxxing import blocks, config, extensions
from maxxing.sessions import codex

GOOD = {"type": "block", "name": {"en": "Map", "fr": "Carte"}, "version": "1.2.0", "renders": ["map"],
        "schema": {"type": "object", "required": ["points"], "properties": {
            "points": {"type": "array", "items": {"type": "object", "required": ["lat", "lon"], "properties": {
                "label": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"}}}}}},
        "entry": "block.html", "permissions": {"network": ["tiles.example.com"]},
        "hint": "Places, addresses and routes.", "icon": "map", "category": "data"}


@pytest.fixture
def client(org, monkeypatch):  # noqa: F811
    from fastapi.testclient import TestClient
    from maxxing import app as app_module, security
    monkeypatch.setattr(app_module, "ROUTERS", _org_helpers.ORG_ROUTERS + ["blocks"])
    security.set_password(_org_helpers.PASSWORD)
    with TestClient(app_module.create_app()) as c:
        assert c.post("/api/auth/login", json={"password": _org_helpers.PASSWORD},
                      headers={"X-Maxxing": "1"}).status_code == 200
        c.headers["X-Maxxing"] = "1"
        yield c


def _plugin(org, eid, manifest=None, html="<div id=app></div><script>maxxing.onData(function(d){})</script>",
            **files):
    d = org.ws / "extensions" / eid
    d.mkdir(parents=True, exist_ok=True)
    m = GOOD if manifest is None else manifest
    (d / "block.json").write_text(m if isinstance(m, str) else json.dumps(m))
    if html is not None:
        (d / "block.html").write_text(html)
    for name, text in files.items():
        (d / name.replace("_", ".")).write_text(text)
    return d


# ---- schemas -----------------------------------------------------------------------------------------------------
EXAMPLES = {
    "chart": {"kind": "line", "series": [{"name": "Oct", "points": [["1", 320], ["2", 410]]}], "unit": "EUR"},
    "table": {"columns": ["Product", {"label": "Revenue", "type": "number"}], "rows": [["Mug", 3120], ["Bag", None]]},
    "stats": {"items": [{"label": "Revenue", "value": "12 480 EUR", "delta": "+18 %"}, {"label": "Orders", "value": 312}]},
    "list": {"items": [{"title": "Deploy", "status": "ok", "href": "/crons"}]},
    "timeline": {"lanes": [{"name": "Backup", "events": [{"at": "2026-11-01T04:40:00Z", "state": "ok"},
                                                         {"at": 1793000000, "state": "planned"}]}]},
    "progress": {"label": "Disk", "value": 66, "max": 80, "unit": "GB"},
    "terminal": {"command": "npm test", "output": "24 passed", "exit_code": 0},
    "diff": {"path": "a.ts", "diff": "@@ -1 +1 @@\n-a\n+b\n"},
    "file": {"path": "/root/maxxing/cover.png", "caption": "Cover"},
    "link": {"url": "https://ui.example.com/products/mug", "title": "Mug"},
    "form": {"title": "Campaign", "fields": [{"id": "aud", "label": "Audience", "type": "choice",
                                               "options": ["Existing", {"label": "New", "value": "new"}]},
                                              {"id": "budget", "label": "Budget", "type": "range", "min": 0,
                                               "max": 1000, "default": 200}]},
    "checklist": {"items": ["Pick the visual", {"label": "Proofread", "checked": True}]},
    "app": {"title": "Price simulator", "html": "<input type=range><script>1</script>", "height": 300},
    "created": {"items": [{"kind": "task", "title": "Proofread the email", "id": "t_1234"}]},
    "proposal": {"draft": "d_1a2b3c4d5e6f", "title": "Weather board"},
}


def test_builtin_schemas_are_valid_and_accept_their_examples():
    assert [b["type"] for b in blocks.BUILTINS] == list(EXAMPLES)
    for b in blocks.BUILTINS:
        blocks.check_schema(b["schema"])
        assert blocks.validate(b["schema"], EXAMPLES[b["type"]]) == [], b["type"]
        assert b["hint"] and b["fields"] and b["category"] in blocks.CATEGORIES


def test_validation_errors_are_readable():
    chart = blocks.BUILTINS[0]["schema"]
    assert blocks.validate(chart, {}) == ["series: missing"]
    assert blocks.validate(chart, {"series": [{"name": "a", "points": [["x", "y"]]}]}) == \
        ["series[0].points[0][1]: expected number"]
    assert blocks.validate(chart, {"kind": "pie", "series": []}) == \
        ['kind: must be one of "line", "bar"', "series: needs at least 1 item(s)"]
    assert blocks.validate(chart, []) == ["(root): expected object"]
    progress = next(b for b in blocks.BUILTINS if b["type"] == "progress")["schema"]
    assert blocks.validate(progress, {"title": "x"}) == ["items: missing"]
    many = {"series": [{"name": "a", "points": [["x", "y"]] * 50}]}
    assert len(blocks.validate(chart, many)) == 20                          # capped


def test_check_schema_refuses_what_the_browser_would_ignore():
    for bad, why in [({"type": "object", "pattern": "a+"}, "pattern"), ({"type": "date"}, "bad schema type"),
                     ({"enum": []}, "enum"), ({"required": "x"}, "required"), ({"minItems": -1}, "minItems"),
                     ("string", "must be an object")]:
        with pytest.raises(ValueError, match=why):
            blocks.check_schema(bad)
    deep: dict = {"type": "object"}
    for _ in range(14):
        deep = {"type": "array", "items": deep}
    with pytest.raises(ValueError, match="deeper"):
        blocks.check_schema(deep)


# ---- manifests ---------------------------------------------------------------------------------------------------
def test_block_extension_is_listed_with_its_renders(client, org):
    _plugin(org, "map")
    ext = {e["id"]: e for e in client.get("/api/extensions").json()}["map"]
    assert ext["type"] == "block" and ext["renders"] == ["map"] and ext["error"] is None
    assert ext["name"] == "Map" and ext["version"] == "1.2.0" and ext["icon"] == "map"
    # never a dashboard widget
    assert "map" not in [w["id"] for w in client.get("/api/dashboard").json()["widgets"]]


@pytest.mark.parametrize("change, why", [
    ({"type": "widget"}, '"type": "block"'),
    ({"renders": []}, "renders"),
    ({"renders": ["Map!"]}, "lowercase slug"),
    ({"renders": ["chart"]}, "built-in block type"),
    ({"renders": ["json"]}, "reserved"),
    ({"permissions": {"network": ["https://tiles.example.com/x"]}}, "host name"),
    ({"permissions": {"files": True}}, "only network"),
    ({"permissions": {"network": [f"h{i}.example.com" for i in range(9)]}}, "at most 8"),
    ({"schema": {"type": "object", "pattern": "x"}}, "unsupported schema keyword"),
    ({"schema": "../secret.json"}, "schema"),
    ({"schema": "schema.json"}, "schema"),
    ({"entry": "../../etc/passwd"}, "entry"),
    ({"entry": "other.html"}, "entry"),
    ({"category": "games"}, "category"),
])
def test_bad_manifests_only_break_their_own_plugin(client, org, change, why):
    _plugin(org, "good")
    _plugin(org, "bad", {**GOOD, "renders": ["other"], **change})
    lst = {e["id"]: e for e in client.get("/api/extensions").json()}
    assert lst["good"]["error"] is None
    assert lst["bad"]["type"] == "block" and why in lst["bad"]["error"], lst["bad"]["error"]


def test_manifest_files_and_limits(client, org):
    _plugin(org, "with-schema", {**GOOD, "schema": "schema.json"}, schema_json=json.dumps({"type": "object"}))
    _plugin(org, "huge", {**GOOD, "renders": ["huge"]}, html="x" * (blocks.ENTRY_MAX + 1))
    _plugin(org, "notjson", "{nope")
    _plugin(org, "chart", {**GOOD, "renders": ["chart-x"]})                # folder named like a built-in
    lst = {e["id"]: e for e in client.get("/api/extensions").json()}
    assert lst["with-schema"]["error"] is None
    assert "larger than 512 KB" in lst["huge"]["error"]
    assert "not valid JSON" in lst["notjson"]["error"]
    assert "built-in block" in lst["chart"]["error"]
    d = _plugin(org, "big", {**GOOD, "renders": ["big"]})
    (d / "block.json").write_text(json.dumps({**GOOD, "renders": ["big"], "description": "x" * blocks.MANIFEST_MAX}))
    assert "larger than 64 KB" in {e["id"]: e for e in client.get("/api/extensions").json()}["big"]["error"]


def test_files_outside_the_folder_are_never_read(client, org):
    secret = org.tmp / "secret.json"
    secret.write_text(json.dumps({**GOOD, "renders": ["leak"]}))
    d = org.ws / "extensions" / "linked"
    d.mkdir(parents=True)
    (d / "block.json").symlink_to(secret)
    (d / "block.html").write_text("<p>x</p>")
    _plugin(org, "linked-html", {**GOOD, "renders": ["leak2"]}, html=None)
    (org.ws / "extensions" / "linked-html" / "block.html").symlink_to(secret)
    lst = {e["id"]: e for e in client.get("/api/extensions").json()}
    assert "outside the extension folder" in lst["linked"]["error"]
    assert "outside the extension folder" in lst["linked-html"]["error"]
    assert client.get("/ext/_blocks/linked-html/frame").status_code == 404


def test_manifest_json_cannot_declare_a_block(client, org):
    d = org.ws / "extensions" / "sneaky"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"type": "block"}))
    assert "block.json" in client.get("/api/extensions").json()[0]["error"]


# ---- /api/blocks -------------------------------------------------------------------------------------------------
def test_list_toggle_builtin_and_plugin(client, org):
    _plugin(org, "map")
    r = client.get("/api/blocks").json()
    ids = [p["id"] for p in r["plugins"]]
    assert ids[:len(blocks.BUILTINS)] == [b["type"] for b in blocks.BUILTINS] and ids[-1] == "map"
    chart = r["plugins"][0]
    assert chart["kind"] == "builtin" and chart["enabled"] and chart["schema"]["required"] == ["series"]
    assert chart["pin"] is True and chart["consent"] is None
    mp = r["plugins"][-1]
    assert mp["kind"] == "extension" and mp["network"] == ["tiles.example.com"] and mp["consent"] == "ask"
    assert mp["names"] == {"en": "Map", "fr": "Carte"} and mp["entry_v"]
    assert "map" in r["agents"]["types"] and r["agents"]["count"] == len(blocks.BUILTINS) + 1

    out = client.patch("/api/blocks/table", json={"enabled": False}).json()
    assert out["ok"] and out["plugin"]["enabled"] is False
    assert config.load_config()["blocks"]["disabled"] == ["table"]
    assert "table" not in client.get("/api/blocks").json()["agents"]["types"]
    assert client.patch("/api/blocks/table", json={"enabled": True}).json()["plugin"]["enabled"] is True
    assert config.load_config()["blocks"]["disabled"] == []

    assert client.patch("/api/blocks/map", json={"enabled": False}).json()["plugin"]["enabled"] is False
    assert config.load_config()["extensions"]["disabled"] == ["map"]
    assert client.patch("/api/blocks/nope", json={"enabled": False}).status_code == 404
    assert client.patch("/api/blocks/chart", json={}).status_code == 422


def test_two_plugins_cannot_draw_the_same_type(client, org):
    _plugin(org, "a-map")
    _plugin(org, "b-map")
    ps = {p["id"]: p for p in client.get("/api/blocks").json()["plugins"]}
    assert ps["a-map"]["error"] is None
    assert "already drawn by the extension 'a-map'" in ps["b-map"]["error"]


def test_consent_and_frame_policy(client, org):
    _plugin(org, "map")
    _plugin(org, "offline", {**GOOD, "renders": ["offline"], "permissions": {}})
    csp = client.get("/ext/_blocks/map/frame").headers["content-security-policy"]
    assert csp.startswith("sandbox allow-scripts;") and "connect-src 'none'" in csp
    assert "tiles.example.com" not in csp and "allow-same-origin" not in csp

    once = client.post("/api/blocks/map/consent", json={"decision": "once"}).json()
    assert once["ok"] and once["grant"] and once["consent"] == "ask"
    csp = client.get(f"/ext/_blocks/map/frame?grant={once['grant']}").headers["content-security-policy"]
    assert "connect-src https://tiles.example.com" in csp
    assert "tiles" not in client.get("/ext/_blocks/map/frame?grant=forged").headers["content-security-policy"]

    assert client.post("/api/blocks/map/consent", json={"decision": "always"}).json()["consent"] == "granted"
    assert config.load_config()["blocks"]["consent"]["map"]["hosts"] == ["tiles.example.com"]
    assert "connect-src https://tiles.example.com" in client.get("/ext/_blocks/map/frame").headers[
        "content-security-policy"]

    assert client.post("/api/blocks/map/consent", json={"decision": "deny"}).json()["consent"] == "denied"
    assert "tiles" not in client.get(f"/ext/_blocks/map/frame?grant={once['grant']}").headers[
        "content-security-policy"]
    assert client.post("/api/blocks/map/consent", json={"decision": "reset"}).json()["consent"] == "ask"

    # a new host in the manifest asks again
    client.post("/api/blocks/map/consent", json={"decision": "always"})
    d = org.ws / "extensions" / "map"
    (d / "block.json").write_text(json.dumps({**GOOD, "permissions": {"network": ["tiles.example.com",
                                                                                 "api.example.com"]}}))
    assert {p["id"]: p for p in client.get("/api/blocks").json()["plugins"]}["map"]["consent"] == "ask"

    assert client.post("/api/blocks/offline/consent", json={"decision": "always"}).json()["error"] == "no_network"
    assert client.post("/api/blocks/chart/consent", json={"decision": "always"}).status_code == 404
    assert client.post("/api/blocks/map/consent", json={"decision": "maybe"}).status_code == 422


def test_frames(client, org):
    _plugin(org, "map", html="<p class=x>Map</p></script><script>maxxing.onData(function(d){})</script>")
    r = client.get("/ext/_blocks/map/frame")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert r.headers["cache-control"] == "no-store" and r.headers["referrer-policy"] == "no-referrer"
    body = r.text
    assert body.index("window.maxxing=") < body.index("<p class=x>Map</p>")        # bridge first, then the entry
    assert "ui-btn" in body                                                         # the UI kit is inlined
    app = client.get("/ext/_blocks/app-frame")
    assert app.status_code == 200 and "document.write" in app.text and "connect-src 'none'" in app.headers[
        "content-security-policy"]
    client.patch("/api/blocks/app", json={"enabled": False})
    assert client.get("/ext/_blocks/app-frame").status_code == 404
    client.patch("/api/blocks/map", json={"enabled": False})
    assert client.get("/ext/_blocks/map/frame").status_code == 404
    assert client.get("/ext/_blocks/chart/frame").status_code == 404
    assert client.get("/ext/_blocks/nope/frame").status_code == 404
    client.cookies.clear()
    assert client.get("/ext/_blocks/app-frame").status_code == 401
    assert client.get("/api/blocks").status_code == 401


def test_pin_to_dashboard(client, org):
    r = client.post("/api/blocks/pin", json={"type": "chart", "data": {**EXAMPLES["chart"], "title": "Revenue"}})
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    assert eid.startswith("pin-revenue-")
    widgets = {w["id"]: w for w in client.get("/api/dashboard").json()["widgets"]}
    card = widgets[eid]["card"]
    assert widgets[eid]["title"] == "Revenue" and card["blocks"][0]["type"] == "chart"
    assert card["blocks"][0]["series"] == EXAMPLES["chart"]["series"]
    tl = client.post("/api/blocks/pin", json={"type": "timeline", "data": EXAMPLES["timeline"], "title": "Jobs"})
    lanes = {w["id"]: w for w in client.get("/api/dashboard").json()["widgets"]}[tl.json()["id"]]["card"]["blocks"][0]
    assert lanes["start"] == 1793000000 and lanes["start"] < lanes["end"]
    assert all(isinstance(e["at"], float) for e in lanes["lanes"][0]["events"])
    # figures given as numbers keep their unit: the dashboard writes them in the user's language
    figures = {"items": [{"label": "Revenue", "value": 12480, "unit": "€", "delta": 18}]}
    st = client.post("/api/blocks/pin", json={"type": "stats", "data": figures, "title": "Sales"})
    stats = {w["id"]: w for w in client.get("/api/dashboard").json()["widgets"]}[st.json()["id"]]["card"]["blocks"][0]
    assert stats["items"] == figures["items"]
    table = next(b for b in blocks.BUILTINS if b["type"] == "table")
    unit_col = {"columns": ["Product", {"label": "Revenue", "type": "number", "unit": "€"}], "rows": [["Mug", 3120]]}
    assert blocks.validate(table["schema"], unit_col) == []
    assert client.post("/api/blocks/pin", json={"type": "form", "data": EXAMPLES["form"]}).json()["error"] == \
        "not_pinnable"
    bad = client.post("/api/blocks/pin", json={"type": "chart", "data": {"series": "x"}})
    assert bad.status_code == 400 and "series" in bad.json()["message"]


# ---- what the agents read ----------------------------------------------------------------------------------------
def _install_skill():
    from maxxing import cmd_core
    cmd_core.install_skills()
    return config.claude_dir() / "skills" / "pilot-blocks" / "SKILL.md"


def test_agent_files_follow_the_enabled_types(client, org):
    md = org.ws / "CLAUDE.md"
    md.write_text("# Workspace\n\nMy own rules.\n")
    _plugin(org, "map")
    skill = _install_skill()
    assert "{{" not in skill.read_text() and "| `map` | Places, addresses and routes. |" in skill.read_text()
    client.get("/api/blocks")
    agents = blocks.agents_path().read_text()
    assert "| `chart` |" in agents and "| `map` | Places, addresses and routes. |" in agents
    ref = blocks.reference_path().read_text()
    assert "## `map` (extension `map`)" in ref and '"required":["points"]' in ref
    head = skill.read_text().split("\n---\n", 1)[0]
    assert "Enabled on this server: chart, table, stats" in head and ", map." in head

    client.patch("/api/blocks/chart", json={"enabled": False})
    client.patch("/api/blocks/map", json={"enabled": False})
    for text in (blocks.agents_path().read_text(), skill.read_text()):
        assert "| `chart` |" not in text and "| `map` |" not in text and "| `table` |" in text
    assert "## `chart`" not in blocks.reference_path().read_text()
    assert md.read_text() == "# Workspace\n\nMy own rules.\n"                  # never the user's CLAUDE.md

    # every type off: the agents are told not to use blocks at all
    for b in blocks.BUILTINS:
        blocks.set_enabled(b["type"], False)
    blocks.sync_agent_files()
    assert "turned off on this server" in blocks.agents_path().read_text()
    assert "Enabled on this server: none (blocks are turned off" in skill.read_text()


def test_codex_gets_the_enabled_types(org):
    (org.ws / "CLAUDE.md").write_text("# Workspace\n")
    topic = org.ws / "projects" / "acme" / "topics" / "blog"
    topic.mkdir(parents=True)
    blocks.sync_agent_files()
    ctx = codex.workspace_context(org.ws, topic)
    assert ctx.startswith("--- CLAUDE.md ---\n# Workspace") and "--- conversation blocks ---" in ctx
    assert "| `form` |" in ctx
    blocks.set_enabled("form", False)
    blocks.sync_agent_files()
    assert "| `form` |" not in codex.workspace_context(org.ws, topic)


def test_light_list_matches_the_registry(client, org):
    _plugin(org, "map")
    _plugin(org, "broken", {**GOOD, "renders": ["x!"]})
    full = {p["id"]: (p["enabled"], p["renders"], bool(p["error"])) for p in blocks.plugins()}
    light = {p["id"]: (p["enabled"], p["renders"], bool(p["error"])) for p in blocks.plugins(light=True)}
    assert full == light


def test_scan_keeps_the_agents_in_step(client, org):
    extensions.on_change(blocks.sync_agent_files)
    try:
        _plugin(org, "map")
        extensions.scan()
        assert "| `map` |" in blocks.agents_path().read_text()
        import shutil
        shutil.rmtree(org.ws / "extensions" / "map")
        extensions.scan()
        assert "| `map` |" not in blocks.agents_path().read_text()
    finally:
        extensions._listeners.clear()


def test_pilot_blocks_skill_is_a_product_skill(org):
    from maxxing import cmd_core
    assert "pilot-blocks" in cmd_core.product_skill_names()
    text = (config.SKILLS_DIR / "pilot-blocks" / "SKILL.md").read_text()
    assert text.startswith("---\nname: pilot-blocks\n")
    for b in blocks.BUILTINS:
        assert f"```{b['type']}" in text, b["type"]
    installed = _install_skill().read_text()
    assert "{{" not in installed and str(org.ws) in installed
    assert {s["name"]: s["state"] for s in cmd_core.skills_status()}["pilot-blocks"] == "ok"


def test_example_block_plugin_loads(org):
    src = Path(__file__).resolve().parents[2] / "examples" / "extensions" / "kanban-block"
    import shutil
    shutil.copytree(src, org.ws / "extensions" / "kanban-block")
    p = blocks.get("kanban-block")
    assert p and p["error"] is None and p["renders"] == ["kanban"] and p["network"] == []
    sample = json.loads((src / "sample.json").read_text())
    assert blocks.validate(p["schema"], sample) == []


def test_the_mock_knows_the_builtins():
    """web/mock/blocks-builtins.json (the dev mock's copy) follows BUILTINS. To refresh it:
    uv run python -c "import json; from maxxing import blocks; print(json.dumps(blocks.BUILTINS, ensure_ascii=False,
    indent=1))" > ../web/mock/blocks-builtins.json"""
    mock = Path(__file__).resolve().parents[2] / "web" / "mock" / "blocks-builtins.json"
    assert json.loads(mock.read_text()) == json.loads(json.dumps(blocks.BUILTINS))


def test_the_web_knows_the_builtin_types():
    """features/blocks/fence.tsx decides which fences are blocks before the list is loaded: same types."""
    import re
    fence = (Path(__file__).resolve().parents[2] / "web" / "src" / "features" / "blocks" / "fence.tsx").read_text()
    web = set(re.findall(r"'([a-z]+)'", re.search(r"BUILTIN_BLOCK_TYPES = new Set\(\[(.*?)\]\)", fence).group(1)))
    raw = set(re.findall(r"'([a-z]+)'", re.search(r"RAW_BLOCK_TYPES = new Set\(\[(.*?)\]\)", fence).group(1)))
    assert web == blocks.BUILTIN_TYPES
    assert raw == {b["type"] for b in blocks.BUILTINS if b.get("raw")}
    reserved = set(re.findall(r"'([a-z0-9]+)'", re.search(r"NOT_PLUGIN = new Set\(\[(.*?)\]\)", fence).group(1)))
    assert reserved == blocks.RESERVED_TYPES
