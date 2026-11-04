"""What an HTML widget's sandboxed frame loads by itself: its own files, and the reports of its report-only policy.
See docs/dev/API.md#dashboard--extensions (HTML widget frame) and maxxing/permissions.py.

The frame has an opaque origin, so the browser sends it no cookie: these routes take no session. Each frame document
(`/ext/<id>/widget-frame`, signed in) gets a frame token in its `<base href="/ext/<id>/f/<token>/">`; the token is the
permission, bound to that extension, kept in memory (FRAME_TTL_S, renewed while used):

- `GET /ext/{id}/f/{token}/{path}` - a file of the widget's folder (`extensions.FRAME_TYPES`: scripts, styles, JSON,
  images, fonts, sound, video, wasm; `extensions.module_file` rules: no hidden file, no link out of the folder, never
  api.py), with `Access-Control-Allow-Origin: *` (module scripts and fonts are CORS requests from the opaque origin)
  and a policy of its own (an SVG opened directly runs nothing).
- `POST /ext/{id}/f/{token}/@csp-report` - a grandfathered widget's frame reports the sites its strict report-only
  policy would block: each one is recorded as granted before permissions existed (`permissions.record_hosts`).

Declared before the extensions router (`maxxing.api.ROUTERS`), whose `/ext/{id}/{path}` catch-all serves page modules.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import threading
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import extensions, permissions
from . import extensions as _api_ext  # noqa: F401 - registers the `extid` path convertor

router = APIRouter(tags=["extensions"])
FRAME_TTL_S = 12 * 3600
FRAMES_MAX = 2000
REPORT_MAX = 16 * 1024
REPORTS_PER_FRAME = 200
ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"

_frames: dict[str, dict] = {}                  # token -> {eid, exp, report, reports}
_lock = threading.Lock()


def issue(eid: str, report: bool) -> str:
    """A frame token for one load of `eid`'s widget frame; `report`: its report-only policy may record sites."""
    token, now = secrets.token_urlsafe(18), time.time()
    with _lock:
        for k in [k for k, f in _frames.items() if f["exp"] < now]:
            _frames.pop(k, None)
        while len(_frames) >= FRAMES_MAX:
            _frames.pop(min(_frames, key=lambda k: _frames[k]["exp"]))
        _frames[token] = {"eid": eid, "exp": now + FRAME_TTL_S, "report": report, "reports": 0}
    return token


def _frame(eid: str, token: str) -> dict | None:
    now = time.time()
    with _lock:
        f = _frames.get(token)
        if not f or f["eid"] != eid or f["exp"] < now:
            return None
        f["exp"] = now + FRAME_TTL_S                   # renewed while the frame uses it
        return f


def _not_found() -> JSONResponse:
    return JSONResponse({"error": "not_found", "message": "no such file for this frame"}, status_code=404,
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})


def _widget(eid: str) -> extensions.Extension | None:
    ext = extensions.get(eid)
    return ext if ext is not None and ext.enabled and not ext.error and ext.has_html else None


@router.get("/ext/{eid:extid}/f/{token}/{rel:path}", include_in_schema=False)
async def frame_file(eid: str, token: str, rel: str):
    if _frame(eid, token) is None:
        return _not_found()

    def find():
        ext = _widget(eid)
        return extensions.module_file(ext, rel, extensions.FRAME_TYPES) if ext else None
    p = await asyncio.to_thread(find)
    if p is None:
        return _not_found()
    return FileResponse(p, media_type=extensions.FRAME_TYPES[p.suffix.lower()], headers={
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*",
        "Content-Security-Policy": ASSET_CSP, "Referrer-Policy": "no-referrer"})


def report_hosts(body: bytes) -> list[str]:
    """Sites of a CSP report body (`report-uri`: {"csp-report": {"blocked-uri"}}, Reporting API: [{"body":
    {"blockedURL"}}]): host[:port] of each http(s) / ws(s) address, lowercased."""
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return []
    items = data if isinstance(data, list) else [data]
    out: list[str] = []
    for it in items[:20]:
        if not isinstance(it, dict):
            continue
        r = it.get("csp-report") if isinstance(it.get("csp-report"), dict) else it.get("body")
        if not isinstance(r, dict):
            continue
        uri = r.get("blocked-uri") or r.get("blockedURL") or ""
        s = urlsplit(str(uri)[:2000])
        if s.scheme not in ("http", "https", "ws", "wss") or not s.hostname:
            continue
        port = s.port
        default = {"http": 80, "https": 443, "ws": 80, "wss": 443}[s.scheme]
        host = s.hostname.lower() + (f":{port}" if port and port != default else "")
        if permissions.host_ok(host) and host not in out:
            out.append(host)
    return out


@router.post("/ext/{eid:extid}/f/{token}/@csp-report", include_in_schema=False)
async def csp_report(eid: str, token: str, request: Request):
    f = _frame(eid, token)
    if f is None or not f["report"]:
        return Response(status_code=204)
    with _lock:
        f["reports"] += 1
        if f["reports"] > REPORTS_PER_FRAME:
            return Response(status_code=204)
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > REPORT_MAX:
            return Response(status_code=204)
    hosts = report_hosts(bytes(buf))
    if hosts:
        def record() -> list[str]:
            ext = _widget(eid)
            return permissions.record_hosts(ext, hosts) if ext else []
        if await asyncio.to_thread(record):
            from .. import bus
            bus.invalidate("extensions")
    return Response(status_code=204)
