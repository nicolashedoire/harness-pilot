"""`pilot ext check`: an extension run through the server's own path (maxxing/extcheck.py, cmd_ext.py)."""
import json
import shutil
import time
from pathlib import Path

import pytest

from _org_helpers import org  # noqa: F401
from maxxing import cli, config, extcheck

EXAMPLES = Path(__file__).resolve().parents[2] / "examples" / "extensions"
TEMPLATE_EXT = Path(__file__).resolve().parents[2] / "templates" / "workspace" / "extensions"
node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")


def _ext(org, eid, manifest=None, **files):
    d = org.ws / "extensions" / eid
    d.mkdir(parents=True, exist_ok=True)
    if manifest is not None:
        (d / "manifest.json").write_text(json.dumps(manifest))
    for name, text in files.items():
        if text is None:
            (d / name).mkdir(exist_ok=True)
            continue
        (d / name.replace("_", ".", 1) if name in ("api_py", "page_js", "widget_html", "block_json", "block_html")
         else d / name).write_text(text)
    return d


def _steps(r, status):
    return [s["detail"] for s in r["steps"] if s["status"] == status]


def _run(capsys, *args):
    code = cli.main(["ext", "check", *args])
    out = capsys.readouterr()
    return code, out.out, out.err


def test_every_bundled_extension_passes(org):
    """The examples and the page a new workspace gets are what agents copy: they must pass."""
    for src in [*EXAMPLES.iterdir(), *(p for p in TEMPLATE_EXT.iterdir() if p.is_dir())]:
        shutil.copytree(src, org.ws / "extensions" / src.name)
    results = extcheck.check_all()
    assert len(results) >= 6
    assert [(r["id"], r["error"]) for r in results if r["status"] == "error"] == []
    kinds = {r["id"]: r["kind"] for r in results}
    assert kinds["hello-widget"] == "card" and kinds["snake-widget"] == "html" and kinds["notes-page"] == "page"
    assert kinds["kanban-block"] == "block"


def test_card_goes_through_clean_card(org, capsys):
    _ext(org, "disk", {"name": "Disk", "type": "widget"},
         api_py="def card(ctx):\n    return {'title': 'D', 'status': 'error', 'nope': 1, 'blocks': [\n"
                "        {'type': 'stat', 'label': 'Used', 'value': 3}, {'type': 'kpi'}, 'text']}\n")
    r = extcheck.check("disk")
    assert r["kind"] == "card" and r["status"] == "warn" and r["error"] is None
    assert r["card"]["blocks"] == [{"type": "stat", "label": "Used", "value": 3}] and "nope" not in r["card"]
    warns = " | ".join(_steps(r, "warn"))
    assert "2 block(s) of an unknown type dropped: kpi, str" in warns and 'status "error"' in warns
    assert r["files"] == ["manifest.json", "api.py"]
    code, out, _ = _run(capsys, "disk")
    assert code == 0 and "disk (card) - warn" in out


def test_card_errors_keep_the_extension_frames(org, capsys):
    _ext(org, "boom", {"type": "widget"},
         api_py="def helper(d):\n    return d['missing']\n\n\ndef card(ctx):\n    return helper({})\n")
    _ext(org, "listy", {"type": "widget"}, api_py="def card(ctx):\n    return [1]\n")
    _ext(org, "noblock", {"type": "widget"}, api_py="def card(ctx):\n    return {'blocks': []}\n")
    r = extcheck.check("boom")
    assert r["status"] == "error" and r["error"] == "KeyError: 'missing' (api.py:2 in helper)"
    assert r["trace"] == ["api.py:6 in card: return helper({})", "api.py:2 in helper: return d['missing']"]
    assert extcheck.check("listy")["error"] == "ValueError: card() must return a dict, got list"
    assert "no block" in _steps(extcheck.check("noblock"), "warn")[0]
    _ext(org, "said", {"type": "widget"},
         api_py="def card(ctx):\n    return {'status': 'error', 'error': 'SHOP_TOKEN is missing', 'blocks': []}\n")
    assert extcheck.check("said")["error"] == "card() reported an error: SHOP_TOKEN is missing"
    code, out, _ = _run(capsys, "boom")
    assert code == 1 and "at api.py:2 in helper" in out


def test_a_card_that_never_returns_times_out(org, monkeypatch):
    from maxxing.api import dashboard
    monkeypatch.setattr(dashboard, "TIMEOUT_S", 0.2)
    _ext(org, "slow", {"type": "widget"}, api_py="import time\n\ndef card(ctx):\n    time.sleep(1)\n    return {}\n")
    r = extcheck.check("slow")
    assert r["status"] == "error" and "did not return within 0 s" in r["error"] and extcheck.timed_out([r])
    time.sleep(1.2)                                   # the extension thread returns: nothing left behind


def test_load_errors_are_the_ones_the_ui_shows(org, capsys):
    _ext(org, "badjson").joinpath("manifest.json").write_text("{nope")
    _ext(org, "bad-import", {"type": "widget"}, api_py="import not_a_module_anywhere\n")
    assert "not valid JSON" in extcheck.check("badjson")["error"]
    r = extcheck.check("bad-import")
    assert r["steps"][0]["step"] == "load" and "ModuleNotFoundError" in r["error"]
    assert r["files"] == ["manifest.json", "api.py"]
    code, out, _ = _run(capsys)
    assert code == 1 and "2 extension(s), 2 broken" in out


def test_unknown_and_turned_off(org, capsys):
    _ext(org, "w", {"type": "widget"}, api_py="raise SystemExit('never imported while off')\n")
    config.update_config(extensions={"disabled": ["w"]})
    code, _, err = _run(capsys, "nope")
    assert code == 2 and "no extension with this id" in err
    code, out, _ = _run(capsys, "w", "--json")
    res = json.loads(out)
    assert code == 3 and res["ok"] is True and res["extensions"][0]["status"] == "skipped"
    assert "turned off" in res["extensions"][0]["steps"][0]["detail"]
    assert _run(capsys)[0] == 0                       # listed as skipped, not broken, without an id


@node
def test_page_syntax_mount_and_api(org):
    _ext(org, "pg", {"type": "page"}, page_js="export function mount(el, ctx) {\n  const x = ;\n  ctx.api('x')\n}\n")
    r = extcheck.check("pg")
    assert r["status"] == "error"
    assert _steps(r, "error")[0].startswith("SyntaxError: Unexpected token ';' (page.js:2)")
    assert any("no handle(" in e for e in _steps(r, "error"))
    _ext(org, "nomount", {"type": "page"}, page_js="export function start(el) {}\n// export function mount() {}\n")
    assert "does not export mount" in extcheck.check("nomount")["error"]
    _ext(org, "evil", {"type": "page"}, page_js="export default { mount(el) { eval('1') } }\n")
    r = extcheck.check("evil")
    assert r["status"] == "warn" and "eval" in _steps(r, "warn")[0]


@node
def test_page_modules_resolved_like_the_browser(org):
    _ext(org, "mods", {"type": "page"},
         page_js=("import { a } from './lib.js'\nimport x from 'lodash'\nimport 'https://cdn.example.com/m.js'\n"
                  "import './missing.js'\nimport './notes.txt'\nconst s = \"data from 'excel'\" // from './no.js'\n"
                  "export function mount(el) { el.textContent = a + s + x }\n"),
         **{"lib.js": "export const a = 1\n", "notes.txt": "plain text\n"})
    r = extcheck.check("mods")
    errors = " | ".join(_steps(r, "error"))
    assert '"lodash": a bare name' in errors and "https://cdn.example.com/m.js: the app only runs" in errors
    assert "./missing.js: no such file" in errors and "imports notes.txt" in errors
    assert "excel" not in errors and "no.js" not in errors          # strings and comments are not imports
    assert "imports lib.js" not in errors and "lib.js" in r["files"]          # served by the page module route
    assert "page.js imports notes.txt, but GET /ext/mods/@" in errors and "-> 404" in errors   # not a page module
    _ext(org, "nested", {"type": "page"}, page_js="import { b } from './lib/b.js'\nexport function mount(el) { b(el) }\n",
         **{"lib": None})
    (org.ws / "extensions" / "nested" / "lib" / "b.js").write_text("import { c } from '../c.mjs'\nexport const b = c\n")
    (org.ws / "extensions" / "nested" / "c.mjs").write_text("export const c = (el) => { el.textContent = 'x' ;\n")
    r = extcheck.check("nested")
    assert r["steps"][1]["detail"].startswith("/ext/nested/@") and r["files"][-2:] == ["lib/b.js", "c.mjs"]
    assert r["error"].startswith("SyntaxError") and "(c.mjs:2)" in r["error"]


@node
def test_html_widget_document(org):
    _ext(org, "game", {"type": "widget"}, widget_html=(
        "<div id=a>hi</div>\n<script>\n  maxxing.api('best').then(x => {\n  localStorage.x = 1\n</script>\n"
        "<script src=\"lib.js\"></script>\n<script src=\"https://cdn.example.com/x.js\"></script>\n"
        "<link rel=stylesheet href=\"style.css\">\n"))
    r = extcheck.check("game")
    errors = _steps(r, "error")
    assert r["kind"] == "html" and r["steps"][1] == {"step": "served", "status": "ok", "detail": "/ext/game/widget-frame"}
    assert errors[0].startswith("SyntaxError: Unexpected end of input (widget.html:")
    assert any('<script src="lib.js">' in e for e in errors) and not any("cdn.example.com" in e for e in errors)
    assert any("maxxing.api() but api.py has no handle(" in e for e in errors)
    assert any("localStorage" in w for w in _steps(r, "warn")) and any("style.css" in w for w in _steps(r, "warn"))
    _ext(org, "open", {"type": "widget"}, widget_html="<p>x</p><script>let a = 1")
    assert "never closed" in extcheck.check("open")["error"]
    _ext(org, "empty", {"type": "widget"}, widget_html="  \n")
    assert extcheck.check("empty")["error"] == "widget.html is empty"
    _ext(org, "ok", {"type": "widget", "permissions": {}}, widget_html="<p id=p></p><script>p.textContent = maxxing.theme</script>")
    assert extcheck.check("ok")["status"] == "ok"


def test_html_widget_not_served(org):
    d = _ext(org, "leak", {"type": "widget"})
    outside = org.tmp / "secret.html"
    outside.write_text("<p>secret</p>")
    (d / "widget.html").symlink_to(outside)
    r = extcheck.check("leak")
    assert r["status"] == "error" and "GET /ext/leak/widget-frame -> 404" in r["error"]


def test_block_plugin(org):
    shutil.copytree(EXAMPLES / "kanban-block", org.ws / "extensions" / "kanban-block")
    r = extcheck.check("kanban-block")
    assert r["status"] == "ok" and r["files"] == ["block.json", "block.html", "schema.json"]
    _ext(org, "mute", None, block_json=json.dumps({"type": "block", "renders": ["mute"]}),
         block_html="<div id=x></div><script>x.textContent = 'never gets data'</script>")
    r = extcheck.check("mute")
    assert r["kind"] == "block" and r["status"] == "warn" and "onData" in _steps(r, "warn")[0]
    _ext(org, "badblock", None, block_json=json.dumps({"type": "block", "renders": ["chart"]}), block_html="<p>x</p>")
    assert "built-in block type" in extcheck.check("badblock")["error"]
