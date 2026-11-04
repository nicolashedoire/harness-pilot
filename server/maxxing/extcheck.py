"""`pilot ext check`: run an extension through the server's own path and say what is broken, before the user sees it.

`check(eid) -> Result | None` (None: no such extension), `check_all() -> [Result]`. Every extension folder is loaded
as the server loads it (`extensions.scan()`: manifest or block.json, api.py imported apart with the same 10 s
deadline), then, by kind:

- card widget: `card(ctx)` on the extension threads with the dashboard's timeout, then `clean_card` and `strip_none`
  (what `extensions.compute_card` and the dashboard do); the frames of the extension's own files are kept on an
  exception. An "error" the card returns (`extensions.card_error`, as `pilot update --verify`) is an error;
  warnings: no block left, blocks of an unknown type dropped, a card whose status is "error".
- HTML widget: `GET /ext/<id>/widget-frame` through the real route, then widget.html is parsed: a document with
  content, every `<script>` closed, `node --check` of each inline script (line numbers of widget.html), a relative
  `src` must be a file its frame loads (api/extframes.py), `maxxing.api()` needs `handle()` in api.py, storage the
  sandbox lacks; then its network against `permissions.frame_network` (another site's script or style, a site it names
  that is not declared).
- page: `GET /ext/<id>/@<page_v>/page.js` (the URL the app imports) through the real route, `node --check` as an ES
  module, `mount` exported, and every module it imports, resolved as the browser does (`urljoin`): a file of the
  folder that the server serves with the type the import needs (a GET through the same routes, so the server's own
  rules for page modules apply), checked the same way in turn. Bare names and other origins are
  refused by the app's `script-src 'self'`; `eval` / `new Function` are flagged; `ctx.api()` needs `handle()`.
- block plugin: block.json (`blocks.parse_manifest`), `GET /ext/_blocks/<id>/frame`, the entry parsed like a widget.
- agent: the manifest (`agent_providers.parse`).
- widget and page: what the manifest declares in "permissions" (permissions.py), a warning when it declares nothing.

The routes run in-process (a FastAPI app with the extensions and blocks routers, the sign-in check waived): nothing
listens, no request leaves the machine. An extension that is turned off (or held after a restore) is "skipped":
none of its code runs.

Result = {id, name, type, kind: "card"|"html"|"page"|"block"|"agent"|"widget", dir, status: "ok"|"warn"|"error"|
"skipped", error: first error | None, steps: [{step, status, detail}], files: [names relative to dir], permissions:
the declaration | None, card?, trace?, runtime_errors: what broke while it ran since its files last changed
(exterrors.recent; not part of the status)}
"""
from __future__ import annotations

import asyncio
import json
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit

from . import config, exterrors, extensions, permissions

NODE_TIMEOUT_S = 20
MAX_MODULES = 40
OK, WARN, ERROR, SKIPPED = "ok", "warn", "error", "skipped"
_RANK = {OK: 0, WARN: 1, ERROR: 2}


class _Run:
    """The steps of one extension's check."""

    def __init__(self, ext: extensions.Extension, kind: str):
        self.ext, self.kind = ext, kind
        self.steps: list[dict] = []
        self.files: list[str] = []
        self.extra: dict[str, Any] = {}

    def add(self, step: str, status: str, detail: str = "") -> None:
        self.steps.append({"step": step, "status": status, "detail": detail.strip()})

    def file(self, name: str) -> None:
        if name not in self.files:
            self.files.append(name)

    def result(self) -> dict:
        worst = max((_RANK.get(s["status"], 0) for s in self.steps), default=0)
        status = next(k for k, v in _RANK.items() if v == worst)
        err = next((s["detail"] for s in self.steps if s["status"] == ERROR), None)
        return {"id": self.ext.id, "name": self.ext.label(), "type": self.ext.type, "kind": self.kind,
                "dir": str(self.ext.dir), "status": status, "error": err, "steps": self.steps, "files": self.files,
                "permissions": self.ext.permissions, **self.extra,
                "runtime_errors": exterrors.recent(self.ext.id, self.ext.dir)}


def _kind(ext: extensions.Extension) -> str:
    if ext.type == "widget":
        return "html" if ext.has_html else "card" if ext.has_api else "widget"
    return ext.type


# ---- the server's routes, in-process ------------------------------------------------------------------------------
_client_cache: list[Any] = []


def _client() -> Any:
    """A TestClient on the extensions and blocks routers (sign-in waived): GETs take the server's own path."""
    if not _client_cache:
        import warnings

        from fastapi import FastAPI
        with warnings.catch_warnings():                       # a deprecation notice of the test client's transport
            warnings.simplefilter("ignore")
            from fastapi.testclient import TestClient

        from . import security
        from .api import blocks as api_blocks
        from .api import extensions as api_ext
        from .api import extframes as api_frames
        app = FastAPI()
        app.include_router(api_frames.router)              # before the page modules' catch-all, as the server does
        app.include_router(api_ext.router)
        app.include_router(api_blocks.router)
        app.dependency_overrides[security.require_auth] = lambda: None
        _client_cache.append(TestClient(app, raise_server_exceptions=False))
    return _client_cache[0]


def _get(path: str) -> tuple[int, str, str]:
    """GET through the routes -> (status, content type, text or the error message)."""
    r = _client().get(path)
    ctype = r.headers.get("content-type", "")
    if r.status_code != 200:
        try:
            d = r.json().get("detail") or {}
            msg = f"{d.get('error')}: {d.get('message')}" if isinstance(d, dict) else str(d)
        except ValueError:
            msg = r.text[:200]
        return r.status_code, ctype, msg
    return 200, ctype, r.text


# ---- node --check ---------------------------------------------------------------------------------------------------
def _node() -> str | None:
    return shutil.which("node")


def _node_check(code: str, name: str, module: bool, line: int = 1, col: int = 0) -> str | None:
    """'' when the code parses, the error (positions in `name`) otherwise; None when Node.js is missing. `line` /
    `col`: where the code starts in `name` (an inline script), so the error points at the file's own line."""
    node = _node()
    if not node:
        return None
    with tempfile.TemporaryDirectory(prefix="mx-extcheck-") as tmp:
        f = Path(tmp) / ("check.mjs" if module else "check.js")
        f.write_text("\n" * max(0, line - 1) + " " * max(0, col) + code, "utf-8")
        try:
            r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True, timeout=NODE_TIMEOUT_S,
                               cwd=tmp)
        except subprocess.TimeoutExpired:
            return f"node --check did not finish in {NODE_TIMEOUT_S} s"
        except OSError as e:
            return f"node --check could not run ({e})"
    if r.returncode == 0:
        return ""
    out = r.stderr or r.stdout
    for tmp_name in sorted({os.path.realpath(f), str(f)}, key=len, reverse=True):   # macOS: /var is /private/var
        out = out.replace(tmp_name, name)
    lines = [x.rstrip() for x in out.splitlines() if not x.startswith("    at ") and not x.startswith("Node.js v")]
    while lines and not lines[-1]:
        lines.pop()
    msg = next((x for x in reversed(lines) if re.match(r"^\w*Error\b", x)), "")
    where = lines[0] if lines and lines[0].startswith(name + ":") else ""
    excerpt = [x for x in lines[1:4] if x and x != msg] if where else []
    head = f"{msg or 'syntax error'}" + (f" ({where})" if where else "")
    return "\n".join([head, *excerpt])


# ---- JavaScript: import specifiers, strings and comments left out --------------------------------------------------
_SPEC_BEFORE = re.compile(r"(?<![.\w$])(?:import\s*\(?|from)\s*$")


def _scan_js(src: str) -> tuple[list[str], str]:
    """(module specifiers of static imports, `export ... from` and `import("...")`, the code without its comments
    and with every string emptied). A light scanner, not a parser: enough to find what a module loads."""
    specs: list[str] = []
    out: list[str] = []
    tail = ""
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            if c != "`" and _SPEC_BEFORE.search(tail):
                specs.append(src[i + 1:j])
            out.append(c + c)
            tail = (tail + c + c)[-40:]
            i = j + 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
            continue
        out.append(c)
        tail = (tail + c)[-40:]
        i += 1
    return specs, "".join(out)


_MOUNT = re.compile(r"\bexport\s+(?:(?:async\s+)?function\s*\*?\s*mount\b|(?:const|let|var)\s+mount\b|default\b"
                    r"|\*\s*from\b)|\bexport\s*\{[^}]*\bmount\b")
_EVAL = re.compile(r"(?<![.\w$])eval\s*\(|\bnew\s+Function\s*\(")
_CTX_API = re.compile(r"\.api\s*\(")
_STORAGE = re.compile(r"\b(localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b")


def _has_handle(ext: extensions.Extension) -> bool:
    return bool(ext.has_api and ext.module is not None and callable(getattr(ext.module, "handle", None)))


# ---- HTML documents (widget.html, a block's entry) -----------------------------------------------------------------
class _Doc(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements = 0
        self.text = False
        self.scripts: list[dict] = []
        self.links: list[dict] = []
        self.open: dict | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        self.elements += 1
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "script":
            line, col = self.getpos()
            self.open = {"attrs": a, "line": line, "col": col, "code": "", "at": None}
        elif tag == "link":
            self.links.append(a)

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        self.handle_starttag(tag, attrs)
        if tag == "script" and self.open is not None:
            self.scripts.append(self.open)
            self.open = None

    def handle_data(self, data: str) -> None:
        if self.open is not None:
            if self.open["at"] is None:
                self.open["at"] = self.getpos()
            self.open["code"] += data
        elif data.strip():
            self.text = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self.open is not None:
            self.scripts.append(self.open)
            self.open = None


def _local(url: str) -> bool:
    """A URL relative to the frame's document (not https://, //host, data:...)."""
    s = urlsplit(url.strip())
    return not s.scheme and not s.netloc and bool(s.path)


def _check_document(run: _Run, name: str, raw: bytes, *, api_ok: bool, bridge: str) -> str:
    """Steps for an HTML file drawn in a sandboxed frame; returns its text."""
    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        html = raw.decode("utf-8", "replace")
        run.add("document", WARN, f"{name} is not UTF-8 text (byte {e.start}): some characters show as �")
    if not html.strip():
        run.add("document", ERROR, f"{name} is empty")
        return html
    doc = _Doc()
    try:
        doc.feed(html)
        doc.close()
    except Exception as e:  # noqa: BLE001 - html.parser rarely raises, a report is enough
        run.add("document", ERROR, f"{name} could not be read as HTML ({e})")
        return html
    if doc.open is not None:
        run.add("document", ERROR, f"{name}:{doc.open['line']}: a <script> is never closed (</script> missing): "
                                   "the rest of the file is not drawn")
        return html
    if not doc.elements and not doc.text:
        run.add("document", ERROR, f"{name} has no element and no text")
        return html
    run.add("document", OK, f"{name}: {doc.elements} element(s), {len(doc.scripts)} script(s)")
    code_all = []
    node_missing = False
    for s in doc.scripts:
        src, typ = s["attrs"].get("src", ""), s["attrs"].get("type", "").strip().lower()
        if src:
            if _local(src) and not _frame_file_ok(run, bridge, src):
                run.add("scripts", ERROR, f"{name}:{s['line']}: <script src=\"{src}\"> - " + (
                    f"not a file of the folder its frame can load (.js .mjs, a path inside the folder)" if bridge == "widget"
                    else f"only {name} is served to the frame: inline the code"))
            continue
        if typ not in ("", "text/javascript", "application/javascript", "module"):
            continue
        line, col = s["at"] or (s["line"], s["col"])
        err = _node_check(s["code"], name, typ == "module", line, col)
        if err is None:
            node_missing = True
        elif err:
            run.add("scripts", ERROR, err)
        code_all.append(_scan_js(s["code"])[1])
    for link in doc.links:
        href = link.get("href", "")
        if "stylesheet" in link.get("rel", "").lower() and href and _local(href) and not _frame_file_ok(run, bridge,
                                                                                                         href):
            run.add("scripts", WARN, f"{name}: <link href=\"{href}\"> - " + (
                "not a file of the folder its frame can load" if bridge == "widget"
                else f"only {name} is served to the frame: inline the styles in a <style>"))
    code = "\n".join(code_all)
    if node_missing and doc.scripts:
        run.add("scripts", WARN, "Node.js is not installed: the inline scripts were not checked")
    elif not any(st["step"] == "scripts" and st["status"] == ERROR for st in run.steps) and code_all:
        run.add("scripts", OK, f"{len(code_all)} inline script(s) parse")
    if bridge == "widget" and re.search(r"\bmaxxing\s*\.\s*api\s*\(", code) and not api_ok:
        run.add("api", ERROR, f"{name} calls maxxing.api() but api.py has no handle(ctx, method, path, query, body)")
    m = _STORAGE.search(code)
    if m:
        run.add("sandbox", WARN, f"{name} uses {m.group(0).replace(' ', '')}: the sandboxed frame has none (it "
                                 "throws)" + (" - save through api.py and ctx[\"state_dir\"]" if bridge == "widget"
                                              else ""))
    if bridge == "block" and code_all and not re.search(r"\bmaxxing\s*\.\s*onData\s*\(", code):
        run.add("data", WARN, f"{name} never calls maxxing.onData(fn): it does not receive the block's data")
    return html


def _frame_file_ok(run: _Run, bridge: str, url: str) -> bool:
    """A relative URL of widget.html that its frame loads from the folder (api/extframes.py serves it)."""
    if bridge != "widget":
        return False
    path = posixpath.normpath(unquote(urlsplit(url.strip()).path)).lstrip("/")
    if path.startswith("..") or not path or path == ".":
        return False
    ok = extensions.module_file(run.ext, path, extensions.FRAME_TYPES) is not None
    if ok:
        run.file(path)
    return ok


_URL = re.compile(r"""\b(?:https?|wss?)://([A-Za-z0-9.-]+(?::\d{1,5})?)""")


def _covered(host: str, allowed: list[str]) -> bool:
    for a in allowed:
        if a == host or (a.startswith("*.") and host.endswith(a[1:])):
            return True
    return False


def _check_widget_network(run: _Run, html: str) -> None:
    """What widget.html reaches against what its frame may reach (permissions.frame_network): scripts and styles from
    another site are blocked once it declares permissions; another site it names must be declared."""
    from . import permissions
    ext = run.ext
    net = permissions.frame_network(ext)
    doc = _Doc()
    try:
        doc.feed(html)
        doc.close()
    except Exception:  # noqa: BLE001 - _check_document reported it
        return
    outside = [(s["line"], s["attrs"]["src"]) for s in doc.scripts if s["attrs"].get("src") and not _local(s["attrs"]["src"])]
    outside += [(0, link["href"]) for link in doc.links
                if "stylesheet" in link.get("rel", "").lower() and link.get("href") and not _local(link["href"])]
    hosts = sorted({m.group(1).lower() for m in _URL.finditer(html)})
    if net["open"]:
        names = sorted(set(hosts) | set(net["known"]))
        if names:
            run.add("network", WARN, "no \"permissions\": it existed before permissions, so its frame still reaches any "
                                     f"site - declare the ones it uses: \"network\": [{', '.join(chr(34) + h + chr(34) for h in names)}]"
                                     + (" (scripts and styles from another site will then have to be copied into the folder)"
                                        if outside else ""))
        return
    for line, url in outside:
        run.add("network", ERROR, f"widget.html{':' + str(line) if line else ''}: {url} - scripts and styles load only "
                                  "inline or from the widget's own files: copy it into the folder and use a relative path")
    declared = (ext.permissions or {}).get("network") or []
    script_hosts = {(urlsplit(u).hostname or "").lower() for _, u in outside}
    for h in hosts:
        if h in script_hosts or _covered(h, declared):
            continue
        run.add("network", WARN, f"widget.html names {h}: its frame cannot reach a site that permissions.network does "
                                 "not declare")
    if declared and not outside and not any(st["step"] == "network" for st in run.steps):
        run.add("network", OK, f"its frame may reach {', '.join(net['hosts']) or 'no site yet (waiting for the user)'}")


# ---- per kind -------------------------------------------------------------------------------------------------------
def _check_card(run: _Run) -> None:
    from . import widgets
    from .api.dashboard import TIMEOUT_S
    ext = run.ext
    run.file("api.py")
    raw: list[Any] = []

    def compute() -> dict:                      # = extensions.compute_card, keeping card()'s own value
        raw.append(ext.module.card(extensions.make_ctx(ext, "card", record=False)))   # type: ignore[union-attr]
        card = extensions.clean_card(raw[0])
        card.setdefault("updated", time.time())
        return widgets.strip_none(card)
    try:
        card = asyncio.run(extensions.call(compute, timeout=TIMEOUT_S, key=f"card:{ext.id}"))
    except asyncio.TimeoutError:
        run.extra["timed_out"] = True
        run.add("card", ERROR, f"card() did not return within {TIMEOUT_S:.0f} s (the dashboard's limit): a network "
                               "call without a timeout?")
        return
    except permissions.PermissionDenied as e:
        run.extra["permission"] = e.detail()
        if e.needs_consent:                     # the code is right: the user has to allow the key
            run.add("card", WARN, f"card() stopped: {e} - ask the user to allow it, then check again")
        else:
            run.add("card", ERROR, f"card() stopped: {e}")
        return
    except Exception as e:  # noqa: BLE001 - the extension's error is the result
        frames = exterrors.ext_frames(e, ext.dir)
        if frames:
            run.extra["trace"] = frames
        run.add("card", ERROR, f"{type(e).__name__}: {e}" + (f" ({frames[-1].split(': ', 1)[0]})" if frames else ""))
        return
    run.extra["card"] = card
    blocks = card.get("blocks") or []
    given = raw[0].get("blocks") if isinstance(raw[0], dict) else None
    dropped = [b.get("type") if isinstance(b, dict) else type(b).__name__ for b in given or []
               if not (isinstance(b, dict) and b.get("type") in extensions.BLOCK_TYPES)]
    kinds = ", ".join(str(b.get("type")) for b in blocks) or "none"
    reported = extensions.card_error(raw[0])      # what `pilot update --verify` counts as broken too
    if reported:
        run.add("card", ERROR, f"card() reported an error: {reported}")
    else:
        run.add("card", OK, f"card() -> {len(blocks)} block(s): {kinds}")
    if dropped:
        run.add("card", WARN, f"{len(dropped)} block(s) of an unknown type dropped: "
                              f"{', '.join(map(str, dropped[:6]))} (types: {', '.join(sorted(extensions.BLOCK_TYPES))})")
    if not blocks:
        run.add("card", WARN, "the card has no block: the dashboard shows an empty card")
    if card.get("status") == "error":
        run.add("card", WARN, 'the card reports status "error"')


def _check_html_widget(run: _Run) -> None:
    ext = run.ext
    run.file("widget.html")
    if ext.has_api:
        run.file("api.py")
    status, ctype, body = _get(f"/ext/{ext.id}/widget-frame")
    if status != 200:
        run.add("served", ERROR, f"GET /ext/{ext.id}/widget-frame -> {status} ({body})")
        return
    if "text/html" not in ctype:
        run.add("served", ERROR, f"/ext/{ext.id}/widget-frame is served as {ctype or 'no type'}, not text/html")
        return
    run.add("served", OK, f"/ext/{ext.id}/widget-frame")
    raw = (ext.dir / "widget.html").read_bytes()
    html = _check_document(run, "widget.html", raw, api_ok=_has_handle(ext), bridge="widget")
    _check_widget_network(run, html)


def _check_block(run: _Run) -> None:
    ext = run.ext
    b = ext.block or {}
    entry = str(b.get("entry") or "block.html")
    run.file("block.json")
    run.file(entry)
    try:
        schema = json.loads((ext.dir / "block.json").read_text("utf-8")).get("schema")
    except (OSError, ValueError, AttributeError):
        schema = None
    if isinstance(schema, str):
        run.file(schema)
    status, ctype, body = _get(f"/ext/_blocks/{ext.id}/frame")
    if status != 200:
        run.add("served", ERROR, f"GET /ext/_blocks/{ext.id}/frame -> {status} ({body})")
        return
    run.add("served", OK, f"/ext/_blocks/{ext.id}/frame")
    _check_document(run, entry, (ext.dir / entry).read_bytes(), api_ok=False, bridge="block")


def _check_page(run: _Run) -> None:
    ext = run.ext
    run.file("page.js")
    if ext.has_api:
        run.file("api.py")
    prefix = f"/ext/{ext.id}/"
    entry = f"{prefix}@{extensions.page_version(ext) or 0}/page.js"    # the URL the app imports (pages/ext)
    if ext.page_runtime == "frame":
        status, _, doc = _get(f"{prefix}page-frame")
        base = re.search(r'<base href="([^"]+)"', doc)
        if status != 200 or base is None:
            run.add("served", ERROR, f"isolated page-frame -> {status}: {doc[:200]}")
            return
        prefix = urlsplit(base.group(1)).path
        entry = prefix + "page.js"
    status, ctype, body = _get(entry)
    if status != 200:
        run.add("served", ERROR, f"GET {entry} -> {status} ({body})")
        return
    run.add("served", OK, entry)
    root = ext.dir.resolve()
    seen: set[str] = set()
    todo = [(entry, root / "page.js", "")]
    calls_api = False
    node_missing = False
    while todo and len(seen) < MAX_MODULES:
        url, path, by = todo.pop(0)
        if url in seen:
            continue
        seen.add(url)
        rel = os.path.relpath(path, root)
        if by:                                   # a module imported by another one: served as the browser asks it
            st, ct, msg = _get(url)
            if st != 200:
                run.add("modules", ERROR, f"{by} imports {rel}, but GET {url} -> {st} ({msg})")
                continue
            want = "json" if rel.endswith(".json") else "css" if rel.endswith(".css") else "javascript"
            if want not in ct and not (want == "javascript" and "ecmascript" in ct):
                run.add("modules", ERROR, f"{by} imports {rel}, served as {ct or 'no type'}: the browser refuses a "
                                          f"module that is not {want}")
                continue
            run.file(rel)
            if want != "javascript":
                continue
        try:
            src = path.read_text("utf-8")
        except (OSError, UnicodeDecodeError) as e:
            run.add("modules", ERROR, f"{rel} cannot be read ({e})")
            continue
        err = _node_check(src, rel, module=True)
        if err is None:
            node_missing = True
        elif err:
            run.add("syntax", ERROR, err)
        specs, code = _scan_js(src)
        page_isolation_checks(run, src, rel)
        calls_api = calls_api or bool(_CTX_API.search(code))
        if not by and not _MOUNT.search(code):
            run.add("mount", ERROR, "page.js does not export mount(el, ctx) (export function mount(el, ctx) {...})")
        if _EVAL.search(code):
            run.add("csp", WARN, f"{rel} uses eval / new Function: the app's script policy refuses them (it throws)")
        for spec in specs:
            s = urlsplit(spec)
            if s.scheme or s.netloc:
                run.add("modules", ERROR, f"{rel} imports {spec}: the app only runs scripts it serves itself - copy "
                                          "the module into the extension folder and import it with ./")
                continue
            if not spec.startswith(("./", "../", "/")):
                run.add("modules", ERROR, f"{rel} imports \"{spec}\": a bare name the browser cannot resolve - import "
                                          "a file of the folder with ./name.js")
                continue
            target = urljoin(url, spec)
            tpath = urlsplit(target).path
            if not tpath.startswith(prefix):
                run.add("modules", ERROR, f"{rel} imports {spec} ({tpath}): outside the extension's own /ext/{ext.id}/")
                continue
            parts = unquote(tpath[len(prefix):]).split("/")
            if len(parts) > 1 and parts[0].startswith("@"):            # the version segment names the URL only
                parts = parts[1:]
            fpath = Path(posixpath.normpath(str(root.joinpath(*parts))))
            try:
                inside = fpath.resolve(strict=True)
                inside.relative_to(root)
            except (OSError, ValueError):
                run.add("modules", ERROR, f"{rel} imports {spec}: no such file in the extension folder")
                continue
            todo.append((target, inside, rel))
    if node_missing:
        run.add("syntax", WARN, "Node.js is not installed: the JavaScript syntax was not checked")
    elif not any(s["step"] == "syntax" and s["status"] == ERROR for s in run.steps):
        run.add("syntax", OK, f"{len(seen)} module(s) parse" if len(seen) > 1 else "page.js parses")
    if calls_api and not _has_handle(ext):
        run.add("api", ERROR, "the page calls ctx.api() but api.py has no handle(ctx, method, path, query, body)")


def page_isolation_checks(run: _Run, src: str, rel: str) -> None:
    if run.ext.page_runtime != "frame":
        return
    _, code = _scan_js(src)
    if _STORAGE.search(code) or re.search(r"\b(?:window\s*\.\s*(?:parent|top)|document\s*\.\s*cookie|history\s*\.)", code):
        run.add("isolation", WARN, f"{rel} uses app storage, parent access or history: use its own API or ctx.route / ctx.setRoute")
    if re.search(r"\bfetch\s*\(\s*['\"]/(?:api|ext)/", src):
        run.add("isolation", WARN, f"{rel} fetches an app route directly: the isolated page blocks it; use ctx.api for its own handler")


_SECRET_CALL = re.compile(r"""secret['"]?\s*\]?\s*\)?\s*\(\s*(['"])([A-Z][A-Z0-9_]{1,63})\1""")


def _secrets_read(ext: extensions.Extension) -> list[tuple[str, int]]:
    """(key name, line) of each literal ctx["secret"]("NAME") / secret("NAME") call in api.py, first line per name."""
    try:
        src = (ext.dir / "api.py").read_text("utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    seen: dict[str, int] = {}
    for m in _SECRET_CALL.finditer(src):
        seen.setdefault(m.group(2), src.count("\n", 0, m.start()) + 1)
    return list(seen.items())


def _check_permissions(run: _Run) -> None:
    """What a widget or page declares it uses (manifest "permissions"), against the keys api.py reads and what the
    user allowed."""
    ext = run.ext
    perms = ext.permissions
    access = permissions.access(ext)
    reads = _secrets_read(ext) if ext.has_api else []
    if perms is None:
        names = sorted({n for n, _ in reads} | {x["name"] for x in access["legacy"]["secrets"]})
        hint = ('{"network": [hosts], "secrets": [key names], "read": [workspace paths]} ({} = none of them)'
                if not names else '"secrets": [' + ", ".join(f'"{n}"' for n in names) + "]")
        if access["state"] == "legacy":
            run.add("permissions", WARN, 'manifest.json declares no "permissions": it existed before permissions, so it '
                                         f"still reads the keys it uses - declare what it uses beyond its own folder: {hint}")
        elif reads:
            for n, line in reads:
                run.add("permissions", ERROR, f'api.py:{line} reads the key {n}, but manifest.json declares no '
                                              f'"permissions": ctx["secret"] refuses it - add "permissions": {{{hint}}}')
        else:
            run.add("permissions", WARN, 'manifest.json declares no "permissions": add what it uses beyond its own '
                                         f"folder, {hint}")
        return
    run.add("permissions", OK, f"declares {permissions.summary(perms)}")
    for n, line in reads:
        if n not in perms["secrets"]:
            run.add("permissions", ERROR, f"api.py:{line} reads the key {n}, which manifest.json does not declare "
                                          f'(permissions.secrets): ctx["secret"] refuses it')
    if access["refused"]:
        run.add("permissions", WARN, "the user refused this extension's keys (Settings -> Extensions): ctx[\"secret\"] "
                                     "refuses them all")
    else:
        waiting = [x["name"] for x in access["secrets"] if x["status"] == "pending"]
        sites = [x["host"] for x in access["network"] if x["status"] == "pending"]
        if waiting or sites:
            what = " and ".join(x for x in (f"read {', '.join(waiting)}" if waiting else "",
                                             f"reach {', '.join(sites)}" if sites else "") if x)
            run.add("permissions", WARN, f"waits for the user's permission to {what}: ask them to allow it "
                                         "(Settings -> Extensions -> Allow)")


# ---- entry points ---------------------------------------------------------------------------------------------------
def _check_one(ext: extensions.Extension) -> dict:
    kind = _kind(ext)
    run = _Run(ext, kind)
    run.file("block.json" if ext.type == "block" else "manifest.json")
    if not ext.enabled:
        held = bool(config.load_config().get("restore_hold"))
        res = run.result()
        res["status"] = SKIPPED
        res["steps"] = [{"step": "enabled", "status": SKIPPED, "detail": (
            "extensions are held after a restore until it is reviewed (Settings -> Backup): nothing was run" if held
            else "turned off in Settings -> Extensions: nothing was run")}]
        return res
    if ext.error:
        if ext.has_api:
            run.file("api.py")
        run.add("load", ERROR, ext.error)
        return run.result()
    run.add("load", OK, {"block": "block.json is valid", "agent": "manifest.json is valid"}.get(
        ext.type, "manifest.json is valid" + (", api.py loads" if ext.has_api else "")))
    try:
        if kind == "card":
            _check_card(run)
        elif kind == "html":
            _check_html_widget(run)
        elif kind == "page":
            _check_page(run)
        elif kind == "block":
            _check_block(run)
        if ext.type in ("widget", "page"):
            _check_permissions(run)
    except Exception as e:  # noqa: BLE001 - a check that fails is a result, never a crash of the command
        run.add("check", ERROR, f"the check itself failed: {type(e).__name__}: {e}")
    return run.result()


def check(eid: str) -> dict | None:
    """One extension (the others are loaded too, as the server does). None when no folder has that id."""
    ext = next((e for e in extensions.scan() if e.id == eid), None)
    return _check_one(ext) if ext else None


def check_all() -> list[dict]:
    return [_check_one(e) for e in extensions.scan()]


def timed_out(results: list[dict]) -> bool:
    """A card() still running on an extension thread: the process must leave without waiting for it."""
    return any(r.get("timed_out") for r in results)
