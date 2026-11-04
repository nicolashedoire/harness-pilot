"""Extensions: list / enable / reload, API forwarding and page modules.
See docs/dev/API.md#dashboard--extensions and maxxing/extensions.py.

`ANY /api/ext/{id}/{path}` calls the extension's `handle(ctx, method, path, query, body)` in a
worker thread. The return value is sent as JSON; a `(status, body)` tuple sets the status code;
`ValueError` -> 400, `LookupError` -> 404, anything else -> 500 `extension_error`.
`GET /ext/{id}/page.js` serves the page module, `GET /ext/{id}/<path>` the other modules of the folder it imports
(.js .mjs .css .json, `extensions.module_file`), and `GET /ext/{id}/@<version>/<path>` the same files (the version
segment is ignored: the UI imports `@<page_v>/page.js` so relative imports carry the version too). Auth required, an
enabled page extension without error, never cached.
`POST /api/extensions/{id}/errors` records a runtime error the browser saw (maxxing/exterrors.py); a failing `handle()`
is recorded the same way (`where: "api"`).
`GET /ext/ui-kit.css` serves the shared UI kit (`ui-*` classes, maxxing/assets/ui-kit.css), loaded by the app for
page extensions and inlined in every HTML widget frame.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from starlette.convertors import Convertor, register_url_convertor

from .. import bus, exterrors, extensions, extfix, permissions
from ..security import require_auth


class _ExtId(Convertor):
    regex = "[a-z0-9][a-z0-9-]{0,47}"                  # extensions.ID_RE

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("extid", _ExtId())

router = APIRouter(tags=["extensions"], dependencies=[Depends(require_auth)])
log = logging.getLogger("maxxing.extensions")
HANDLE_TIMEOUT_S = 30.0
MAX_BODY = 5 * 1024 * 1024


def _err(status: int, code: str, msg: str, **extra: Any) -> HTTPException:
    return HTTPException(status, detail={"error": code, "message": msg, **extra})


def _infos(exts: list[extensions.Extension]) -> list[dict]:
    errs = exterrors.all_recent(exts)                  # page_v and the errors' signature walk folders: in a thread
    made = extfix.origins([e.id for e in exts])
    return [{**e.info(), "runtime_errors": errs.get(e.id, []), "origin": made.get(e.id)} for e in exts]


@router.get("/api/extensions")
async def list_extensions():
    return await asyncio.to_thread(lambda: _infos(extensions.all_extensions()))


class PatchIn(BaseModel):
    enabled: Optional[bool] = None
    pinned: Optional[bool] = None             # page extensions: own entry in the sidebar


@router.patch("/api/extensions/{eid}")
async def patch_extension(eid: str, body: PatchIn):
    if extensions.get(eid) is None:
        raise _err(404, "not_found", f"no extension {eid}")
    if body.pinned is not None and not await asyncio.to_thread(extensions.set_pinned, eid, body.pinned):
        raise _err(400, "not_a_page", f"{eid} is not a page extension")
    if body.enabled is not None and not await asyncio.to_thread(extensions.set_enabled, eid, body.enabled):
        raise _err(404, "not_found", f"no extension {eid}")
    bus.invalidate("extensions")
    return {"ok": True}


def _perm_target(eid: str) -> extensions.Extension:
    ext = extensions.get(eid)
    if ext is None or ext.type not in ("widget", "page"):
        raise _err(404, "not_found", f"no widget or page extension {eid}")
    return ext


@router.get("/api/extensions/permissions")
async def all_permissions():
    def build() -> dict:
        exts = [e for e in extensions.all_extensions() if e.type in ("widget", "page")]
        return {"since": permissions.since(), "items": [permissions.detail(e) for e in sorted(exts, key=lambda e: e.id)]}
    return await asyncio.to_thread(build)


@router.get("/api/extensions/{eid}/permissions")
async def extension_permissions(eid: str):
    return await asyncio.to_thread(lambda: permissions.detail(_perm_target(eid)))


class ConsentIn(BaseModel):
    decision: Literal["always", "once", "deny", "reset"]


@router.post("/api/extensions/{eid}/consent")
async def consent(eid: str, body: ConsentIn):
    def run() -> dict:
        ext = _perm_target(eid)
        try:
            return permissions.set_consent(ext, body.decision)
        except ValueError as e:
            raise _err(400, "no_network" if "site" in str(e) else "not_declared", str(e)) from None
    access = await asyncio.to_thread(run)
    grant = access.pop("grant", None)
    if body.decision != "once":
        extensions.forget_card(eid)
        bus.invalidate("extensions")
    return {"ok": True, "access": access, **({"grant": grant} if grant else {})}


@router.post("/api/extensions/reload")
async def reload_extensions():
    out = await asyncio.to_thread(lambda: _infos(extensions.scan()))
    bus.invalidate("extensions")
    return out


class ErrorIn(BaseModel):
    where: Literal["widget", "page"]
    message: str = Field(min_length=1, max_length=4000)
    stack: str = Field("", max_length=8000)


def _frame_offset() -> int:
    """Lines the widget frame serves before widget.html (the bridge, the UI kit): frame line - offset = file line."""
    return (WIDGET_BRIDGE + f"<style>{ui_kit_css()}</style>\n").count("\n")


@router.post("/api/extensions/{eid}/errors")
async def report_error(eid: str, body: ErrorIn):
    ext = await asyncio.to_thread(extensions.get, eid)
    if ext is None:
        raise _err(404, "not_found", f"no extension {eid}")
    if not exterrors.allow(eid):
        raise _err(429, "rate_limited", "too many error reports, try again in a minute")

    def save() -> dict:
        offset = _frame_offset() if body.where == "widget" else 0
        stack = exterrors.trim_stack(body.stack, eid, offset)
        item = exterrors.record(eid, ext.dir, body.where, body.message, stack)
        return {k: item.get(k) for k in ("where", "message", "stack", "at", "count")}
    item = await asyncio.to_thread(save)
    bus.invalidate("extensions")
    return {"ok": True, "error": item}


@router.delete("/api/extensions/{eid}/errors")
async def clear_errors(eid: str):
    if await asyncio.to_thread(extensions.get, eid) is None:
        raise _err(404, "not_found", f"no extension {eid}")
    await asyncio.to_thread(exterrors.clear, eid)
    bus.invalidate("extensions")
    return {"ok": True}


class SeenIn(BaseModel):
    message: str = Field("", max_length=4000)
    stack: str = Field("", max_length=8000)


class FixIn(BaseModel):
    error: Optional[SeenIn] = None            # the error the user is looking at (a card, a page that did not load)
    dry_run: bool = False                     # only build the message and say where it would go


@router.post("/api/extensions/{eid}/fix")
async def ask_fix(eid: str, body: FixIn):
    """"Ask for a fix": the error, the extension and its files, sent to the session that made it (or a new one in
    the Harness topic) -> {session, reused}; `dry_run` -> {prompt, target} and nothing is sent (maxxing/extfix.py)."""
    from ..sessions.service import SessionError
    ext = await asyncio.to_thread(extensions.get, eid)
    if ext is None:
        raise _err(404, "not_found", f"no extension {eid}")
    seen = body.error.model_dump() if body.error else None
    if body.dry_run:
        return await asyncio.to_thread(lambda: {"prompt": extfix.prompt(ext, seen), "target": extfix.target(eid)})
    try:
        out = await asyncio.to_thread(extfix.ask, ext, seen)
    except SessionError as e:
        raise _err(e.status, e.code, e.message) from None
    bus.invalidate("extensions")
    return out


async def _record_api_error(ext: extensions.Extension, message: str, exc: BaseException | None = None) -> None:
    """A failing handle() as a runtime error of the extension (never fails the request)."""
    try:
        stack = "\n".join(exterrors.ext_frames(exc, ext.dir)) if exc is not None else ""
        await asyncio.to_thread(exterrors.record, ext.id, ext.dir, "api", message, stack)
        bus.invalidate("extensions")
    except Exception:  # noqa: BLE001
        log.warning("could not record the error of extension %s", ext.id, exc_info=True)


def _usable(eid: str) -> extensions.Extension:
    ext = extensions.get(eid)
    if ext is None:
        raise _err(404, "not_found", f"no extension {eid}")
    if not ext.enabled:
        raise _err(404, "extension_disabled", f"extension {eid} is disabled")
    if ext.error:
        raise _err(500, "extension_error", ext.error)
    return ext


@router.api_route("/api/ext/{eid}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def forward(eid: str, path: str, request: Request):
    if any(part in (".", "..") for part in path.split("/")):   # never a path that climbs out of /api/ext/<id>/
        raise _err(400, "bad_path", "'.' and '..' are not allowed in an extension path")
    ext = await asyncio.to_thread(_usable, eid)
    body: Any = None
    if request.method != "GET":
        raw = await request.body()
        if len(raw) > MAX_BODY:
            raise _err(413, "too_large", "request body over 5 MB")
        if raw:
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw.decode("utf-8", "replace")
    try:
        fn = extensions.handler(ext)
    except LookupError as e:
        raise _err(404, "no_handler", str(e)) from None
    ctx = extensions.make_ctx(ext)
    query = dict(request.query_params)
    try:
        result = await extensions.call(fn, ctx, request.method, path, query, body, timeout=HANDLE_TIMEOUT_S,
                                       key=f"handle:{eid}")    # a stuck handle() takes one thread, not all
    except extensions.ExtensionBusy as e:
        raise _err(503, "extension_busy", str(e)) from None
    except asyncio.TimeoutError:
        await _record_api_error(ext, f"handle() took more than {HANDLE_TIMEOUT_S:.0f} s ({request.method} {path})")
        raise _err(504, "extension_timeout", f"handle() took more than {HANDLE_TIMEOUT_S:.0f} s") from None
    except ValueError as e:
        raise _err(400, "bad_request", str(e)) from None
    except LookupError as e:
        raise _err(404, "not_found", str(e)) from None
    except permissions.PermissionDenied as e:       # recorded by the refusal itself (permissions.secret_reader)
        raise _err(403, "permission_required" if e.needs_consent else "permission_denied", str(e),
                   permission=e.detail()) from None
    except Exception as e:
        log.warning("extension %s handle failed: %s", eid, e, exc_info=True)
        await _record_api_error(ext, f"{type(e).__name__}: {e}", e)
        raise _err(500, "extension_error", f"{type(e).__name__}: {e}") from None
    status = 200
    if isinstance(result, tuple) and len(result) == 2 and isinstance(result[0], int):
        status, result = result
    if result is None:
        result = {"ok": True}
    try:
        return JSONResponse(result, status_code=status)
    except (TypeError, ValueError) as e:
        await _record_api_error(ext, f"handle() returned a non-JSON value ({e}) for {request.method} {path}")
        raise _err(500, "extension_error", f"handle() returned a non-JSON value ({e})") from None


@router.api_route("/api/ext/{eid}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def forward_root(eid: str, request: Request):
    return await forward(eid, "", request)


UI_KIT = Path(__file__).resolve().parent.parent / "assets" / "ui-kit.css"


_KIT: dict = {"key": None, "css": "", "etag": ""}


def _kit() -> dict:
    """The UI kit, read again only when the file changes (it is inlined in every widget frame)."""
    try:
        st = UI_KIT.stat()
        key = (st.st_mtime_ns, st.st_size)
        if _KIT["key"] != key:
            css = UI_KIT.read_text("utf-8")
            _KIT.update(key=key, css=css, etag='"' + hashlib.sha256(css.encode()).hexdigest()[:16] + '"')
    except OSError:
        _KIT.update(key=None, css="", etag="")
    return _KIT


def ui_kit_css() -> str:
    return _kit()["css"]


@router.get("/ext/ui-kit.css", include_in_schema=False)
async def ui_kit(request: Request):
    kit = await asyncio.to_thread(_kit)
    headers = {"Cache-Control": "no-cache", **({"ETag": kit["etag"]} if kit["etag"] else {})}
    if kit["etag"] and request.headers.get("if-none-match") == kit["etag"]:
        return Response(status_code=304, headers=headers)
    return Response(kit["css"], media_type="text/css; charset=utf-8", headers=headers)


def _own_file(ext: extensions.Extension, name: str) -> Path:
    """`name` inside the extension's folder, resolved: a link to a file outside it (~/.claude/.credentials.json...) is
    never served."""
    try:
        p = (ext.dir / name).resolve(strict=True)
        p.relative_to(ext.dir.resolve())
    except (OSError, ValueError):
        raise _err(404, "not_found", f"{name} of extension {ext.id} is outside its folder") from None
    return p


def _page_module(eid: str, rel: str) -> tuple[Path, str]:
    ext = extensions.get(eid)
    if ext is None or not ext.enabled or ext.error or not ext.has_page:
        raise _err(404, "not_found", f"no page for extension {eid}")
    p = extensions.module_file(ext, rel)
    if p is None:
        raise _err(404, "not_found", f"{rel} is not a module of extension {eid} (.js .mjs .css .json in its folder)")
    return p, extensions.MODULE_TYPES[p.suffix.lower()]


async def _serve_module(eid: str, rel: str) -> FileResponse:
    p, media = await asyncio.to_thread(_page_module, eid, rel)
    return FileResponse(p, media_type=media, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/ext/{eid}/page.js", include_in_schema=False)
async def page_js(eid: str):
    return await _serve_module(eid, "page.js")


# The HTML widget's frame: the bridge (maxxing.api / resize / theme, and the frame's uncaught errors and rejected
# promises sent to the app as {mx:'error'}, see web/src/pages/dashboard/HtmlWidget.tsx; a rejection of maxxing.api()
# the server already recorded - a 5xx - or a network failure is left out)
# then the extension's widget.html. Served as a document of its own (not an iframe srcdoc, which would inherit the
# app's strict script policy): sandboxed by the iframe AND by its own CSP, so even opened directly it has no access to
# the app, its cookies or its API. The theme comes in the URL fragment (#{"theme":..,"vars":{..}}); the UI kit
# (`ui-*` classes) is inlined after the bridge and <html> gets the `data-mx-kit` attribute it is scoped to (an attribute,
# not a class: the parser drops the attributes of the widget's own <html> that the bridge already set).
WIDGET_BRIDGE = """<!doctype html><meta charset="utf-8"><script>(function(){
var init={};try{init=JSON.parse(decodeURIComponent(location.hash.slice(1))||'{}')}catch(_){}
var seq=0,pending={},cbs=[],root=document.documentElement;
root.setAttribute('data-mx-kit','');
function apply(v){for(var k in v||{})root.style.setProperty(k,v[k]);root.dataset.theme=window.maxxing.theme;root.style.colorScheme=window.maxxing.theme}
window.maxxing={theme:init.theme||'dark',
 api:function(path,o){o=o||{};return new Promise(function(res,rej){var s=++seq;pending[s]=[res,rej];parent.postMessage({mx:'api',seq:s,path:String(path||''),method:o.method||'GET',body:o.body,query:o.query},'*')})},
 resize:function(h){parent.postMessage({mx:'resize',height:Number(h)||0},'*')},
 onTheme:function(f){cbs.push(f)}};
addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data||{};
 if(m.mx==='reply'){var p=pending[m.seq];if(p){delete pending[m.seq];if(m.ok)p[0](m.data);else{var x=new Error(m.error||'request failed');x.status=m.status|0;p[1](x)}}}
 if(m.mx==='theme'){window.maxxing.theme=m.theme;apply(m.vars);cbs.forEach(function(f){try{f(m.theme)}catch(_){}})}});
function rep(m,s){try{parent.postMessage({mx:'error',message:String(m==null?'':m).slice(0,4000)||'Error',stack:String(s||'').slice(0,8000)},'*')}catch(_){}}
function txt(x){return x&&x.message?(x.name&&x.name!=='Error'?x.name+': ':'')+x.message:String(x)}
addEventListener('error',function(e){if(!e.lineno&&e.message==='Script error.')return;var x=e.error;
 rep(x&&x.message?txt(x):e.message,x&&x.stack||(e.lineno?'at '+location.pathname+':'+e.lineno+':'+(e.colno|0):''))});
addEventListener('unhandledrejection',function(e){var r=e.reason;if(r&&(r.status===0||r.status>=500))return;
 rep('Unhandled rejection: '+txt(r),r&&r.stack)});
apply(init.vars);})();</script>
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--mx-fg);font:13px/1.45 Inter,system-ui,sans-serif}</style>
"""
WIDGET_FRAME_CSP = "sandbox allow-scripts allow-pointer-lock; frame-ancestors 'self'"     # a grandfathered widget


def widget_csp(hosts: list[str], report_uri: str | None = None) -> str:
    """The policy of an HTML widget frame limited to `hosts` (https): scripts and styles inline or from its own files
    ('self' = the frame's token routes, api/extframes.py: the frame sends no cookie), images, sound, video and fonts
    from its own files, data:, blob: and `hosts`, connections to its own files and `hosts` only. `report_uri`: the
    same rules as a report-only policy (no sandbox / frame-ancestors, which a report-only policy cannot carry)."""
    src = "".join(f" https://{h}" for h in hosts)
    rules = (f"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'self'; style-src 'unsafe-inline' 'self'; "
             f"img-src data: blob: 'self'{src}; media-src data: blob: 'self'{src}; font-src data: 'self'{src}; "
             f"connect-src 'self'{src}; worker-src blob: 'self'; form-action 'none'")
    if report_uri:
        return f"{rules}; report-uri {report_uri}"
    return f"sandbox allow-scripts allow-pointer-lock; {rules}; frame-ancestors 'self'"


@router.get("/ext/{eid}/widget-frame", include_in_schema=False)
async def widget_frame(eid: str, grant: str = ""):
    from . import extframes
    ext = await asyncio.to_thread(extensions.get, eid)
    if ext is None or not ext.enabled or ext.error or not ext.has_html:
        raise _err(404, "not_found", f"no HTML widget for extension {eid}")
    html = await asyncio.to_thread(_own_file(ext, "widget.html").read_text, "utf-8", "replace")
    kit = await asyncio.to_thread(ui_kit_css)
    net = await asyncio.to_thread(permissions.frame_network, ext, grant)
    token = extframes.issue(eid, report=net["open"])
    base = f"/ext/{eid}/f/{token}/"
    headers = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"}
    if net["open"]:              # before permissions: as before, and every other site it reaches is reported, recorded
        headers["Content-Security-Policy"] = WIDGET_FRAME_CSP
        headers["Content-Security-Policy-Report-Only"] = widget_csp(net["known"], base + "@csp-report")
    else:
        headers["Content-Security-Policy"] = widget_csp(net["hosts"])
    doc = WIDGET_BRIDGE.replace('<meta charset="utf-8">', f'<meta charset="utf-8"><base href="{base}">', 1)
    return HTMLResponse(doc + f"<style>{kit}</style>\n" + html, headers=headers)


@router.get("/ext/{eid}/widget.html", include_in_schema=False)
async def widget_html(eid: str):
    """Raw widget.html; the UI loads it into a sandboxed iframe (srcdoc, no access to the app)."""
    ext = await asyncio.to_thread(extensions.get, eid)
    if ext is None or not ext.enabled or ext.error or not ext.has_html:
        raise _err(404, "not_found", f"no HTML widget for extension {eid}")
    return FileResponse(_own_file(ext, "widget.html"), media_type="text/plain; charset=utf-8",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


# Declared after the fixed /ext/{id}/... routes above; `extid` (an extension id: never "_blocks") keeps
# /ext/_blocks/... for api/blocks.py, whose router is included after this one.
@router.get("/ext/{eid:extid}/{rel:path}", include_in_schema=False)
async def page_module(eid: str, rel: str):
    parts = rel.split("/")
    if len(parts) > 1 and parts[0].startswith("@"):   # /ext/<id>/@<version>/<path>: the version only names the URL
        rel = "/".join(parts[1:])
    return await _serve_module(eid, rel)


async def startup() -> None:
    try:
        await asyncio.to_thread(extensions.scan)
    except Exception:
        log.exception("extension scan failed")
