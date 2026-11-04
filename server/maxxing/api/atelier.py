"""The Atelier: creations, drafts, approvals, versions. docs/dev/API.md#atelier, maxxing/atelier.py.

Every route needs the session cookie; writes the CSRF header, and the app's restore-hold / snapshot middleware refuses
them while a restored instance is held or a full snapshot runs. A preview runs the draft's code: only on the user's
request (`POST .../preview`, the preview frame's `maxxing.api()`).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from .. import atelier, atelier_kinds, bus, config, extensions, extfix
from ..security import require_auth

router = APIRouter(tags=["atelier"], dependencies=[Depends(require_auth)])
log = logging.getLogger("maxxing.atelier")
WATCH_S = 2.0
_task: asyncio.Task | None = None


def _err(status: int, code: str, msg: str, **extra: Any) -> HTTPException:
    return HTTPException(status, detail={"error": code, "message": msg, **extra})


async def _call(fn: Any, *args: Any, **kw: Any) -> Any:
    try:
        return await asyncio.to_thread(fn, *args, **kw)
    except atelier.AtelierError as e:
        raise _err(e.status, e.code, e.message, **e.extra) from None


def _changed(extensions_too: bool = False) -> None:
    bus.invalidate(*(("atelier", "extensions") if extensions_too else ("atelier",)))


# ---- list, settings -----------------------------------------------------------------------------------------------
@router.get("/api/atelier")
async def list_items(kind: Optional[str] = None, state: Optional[str] = None):
    return await _call(atelier.items, kind or None, state or None)


@router.get("/api/atelier/settings")
async def get_settings():
    return await _call(atelier.settings)


class SettingsIn(BaseModel):
    auto_activate_safe: Optional[bool] = None
    keep_days: Optional[int] = None
    keep_versions: Optional[int] = None


@router.put("/api/atelier/settings")
async def put_settings(body: SettingsIn):
    out = await _call(atelier.save_settings, **body.model_dump())
    _changed()
    return out


# ---- drafts -------------------------------------------------------------------------------------------------------
@router.get("/api/atelier/drafts")
async def list_drafts(status: str = "pending"):
    if status not in ("pending", "all"):
        raise _err(400, "bad_status", "status is pending or all")
    return {"drafts": await _call(atelier.list_drafts, status)}


@router.get("/api/atelier/drafts/{did}")
async def get_draft(did: str):
    return await _call(atelier.draft_detail, did)


@router.get("/api/atelier/drafts/{did}/file")
async def get_draft_file(did: str, path: str):
    return await _call(atelier.draft_file, did, path)


@router.post("/api/atelier/drafts/{did}/approve")
async def approve(did: str, request: Request):
    raw = await request.body()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        raise _err(400, "bad_request", "the body must be JSON") from None
    if not isinstance(data, dict) or ("base" in data and data["base"] is not None
                                      and (not isinstance(data["base"], int) or isinstance(data["base"], bool))):
        raise _err(400, "bad_request", "base must be a version number or null")
    res = await _call(atelier.approve, did, data["base"] if "base" in data else ...)
    atelier.forget_preview(did)
    try:
        await asyncio.to_thread(extensions.scan)
    except Exception:  # noqa: BLE001 - the version is installed; a broken one shows its error
        log.warning("extension scan after approval failed", exc_info=True)
    _changed(True)
    item = await _call(_item_of, res["item"]["id"])
    return {"ok": True, "item": item, "version": res["version"]}


def _item_of(eid: str) -> dict | None:
    return next((it for it in atelier.extension_items() if it["id"] == eid), None)


class RejectIn(BaseModel):
    reason: Optional[str] = None


@router.post("/api/atelier/drafts/{did}/reject")
async def reject(did: str, body: Optional[RejectIn] = None):
    reason = (body.reason if body else None) or None
    if reason is not None and len(reason) > atelier.REASON_MAX:
        raise _err(400, "bad_reason", f"the reason is {atelier.REASON_MAX} characters at most")
    res = await _call(atelier.reject, did, reason)
    atelier.forget_preview(did)
    _changed()
    bus.invalidate("trash")
    return {"ok": True, **res}


class ChangeIn(BaseModel):
    message: str = ""


@router.post("/api/atelier/drafts/{did}/request-change")
async def request_change(did: str, body: ChangeIn):
    from ..sessions import service
    msg = (body.message or "").strip()
    if not msg or len(body.message) > atelier.MESSAGE_MAX:
        raise _err(400, "bad_message", f"the message is 1 to {atelier.MESSAGE_MAX} characters")
    rec = await _call(atelier.load_draft, did)
    if rec is None:
        raise _err(404, "not_found", f"no proposal {did}")
    if rec.get("status") != "pending":
        raise _err(409, "not_pending", f"this proposal is already {rec.get('status')}")
    prompt = atelier.change_prompt(rec, msg)
    try:                                           # the origin session (queued while it runs), else the Harness topic
        res = await asyncio.to_thread(extfix.deliver, (rec.get("origin") or {}).get("session"), prompt,
                                      f"Change: {rec['name']}")
    except service.SessionError as e:
        raise _err(e.status, e.code, e.message) from None
    session = res["session"]
    await _call(atelier.add_change_request, did, msg, session.get("id") if session else None)
    _changed()
    bus.invalidate("sessions", "workspace")
    return {"ok": True, "session": session, "created": not res["reused"], "queued": res["queued"]}


# ---- preview (runs the draft: a user action) ---------------------------------------------------------------------
@router.post("/api/atelier/drafts/{did}/preview")
async def preview(did: str):
    from .. import widgets
    from .dashboard import TIMEOUT_S
    rec, ext = await _call(atelier.preview_ext, did)
    kind = atelier.preview_kind(rec)
    if kind == "html":                    # the user asked to see it work: its declared sites, for this preview only
        return {"kind": "html", "url": f"/ext/_drafts/{did}/widget-frame?grant={_issue_grant(did)}",
                "height": ext.height}
    if kind != "card":
        return {"kind": "none", "reason": rec.get("type") if rec.get("type") in ("page", "block", "agent") else "page"}
    ctx = atelier.preview_ctx(ext, rec)

    def compute() -> dict:
        card = extensions.clean_card(ext.module.card(ctx))       # type: ignore[union-attr]
        card.setdefault("updated", time.time())
        return widgets.strip_none(card)
    try:
        card = await extensions.call(compute, timeout=TIMEOUT_S, key=f"draft:{did}")
        return {"kind": "card", "card": card, "error": None, "trace": []}
    except asyncio.TimeoutError:
        return {"kind": "card", "card": None, "error": f"card() did not return within {TIMEOUT_S:.0f} s",
                "trace": []}
    except extensions.ExtensionBusy as e:
        raise _err(503, "extension_busy", str(e)) from None
    except Exception as e:  # noqa: BLE001 - the draft's error is the result
        from .. import exterrors
        return {"kind": "card", "card": None, "error": f"{type(e).__name__}: {e}",
                "trace": exterrors.ext_frames(e, ext.dir)}


@router.api_route("/api/atelier/drafts/{did}/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def preview_api(did: str, path: str, request: Request):
    from .extensions import HANDLE_TIMEOUT_S, MAX_BODY
    if any(part in (".", "..") for part in path.split("/")):
        raise _err(400, "bad_path", "'.' and '..' are not allowed in an extension path")
    try:
        rec, ext = await asyncio.to_thread(atelier.preview_ext, did)
    except atelier.AtelierError as e:
        raise _err(404 if e.status in (404, 409) else e.status, "not_found" if e.status in (404, 409) else e.code,
                   e.message) from None
    fn = getattr(ext.module, "handle", None) if ext.module else None
    if not callable(fn):
        raise _err(404, "not_found", "this proposal has no handle(ctx, method, path, query, body)")
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
        result = await extensions.call(fn, atelier.preview_ctx(ext, rec), request.method, path,
                                       dict(request.query_params), body, timeout=HANDLE_TIMEOUT_S,
                                       key=f"draft-handle:{did}")
    except extensions.ExtensionBusy as e:
        raise _err(503, "extension_busy", str(e)) from None
    except asyncio.TimeoutError:
        raise _err(504, "extension_timeout", f"handle() took more than {HANDLE_TIMEOUT_S:.0f} s") from None
    except ValueError as e:
        raise _err(400, "bad_request", str(e)) from None
    except LookupError as e:
        raise _err(404, "not_found", str(e)) from None
    except Exception as e:  # noqa: BLE001
        raise _err(500, "extension_error", f"{type(e).__name__}: {e}") from None
    status = 200
    if isinstance(result, tuple) and len(result) == 2 and isinstance(result[0], int):
        status, result = result
    try:
        return JSONResponse({"ok": True} if result is None else result, status_code=status)
    except (TypeError, ValueError) as e:
        raise _err(500, "extension_error", f"handle() returned a non-JSON value ({e})") from None


@router.api_route("/api/atelier/drafts/{did}/api", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def preview_api_root(did: str, request: Request):
    return await preview_api(did, "", request)


# ---- the preview frame of a draft HTML widget ---------------------------------------------------------------------
# The same document and policy as an installed widget's frame (api/extensions.py `widget_frame`): the bridge, the UI
# kit, a `<base>` on the frame's own token routes (api/extframes.py tokens, keyed `draft:<did>`) so the draft's own
# files load, and `widget_csp(hosts)`. `hosts` = the sites the draft declares, only with the one-off grant that
# `POST .../preview` (the user's action) put in the URL - an hour, that draft only; [] otherwise. A grant never reaches
# the installed extension (permissions.frame_network has its own).
PREVIEW_GRANT_S = 3600
_grants: dict[str, tuple[str, float]] = {}


def _issue_grant(did: str) -> str:
    import secrets as _s
    now = time.time()
    for k in [k for k, (_d, exp) in _grants.items() if exp < now]:
        _grants.pop(k, None)
    g = _s.token_urlsafe(18)
    _grants[g] = (did, now + PREVIEW_GRANT_S)
    return g


def _grant_ok(did: str, grant: str) -> bool:
    hit = _grants.get(grant or "")
    return bool(hit) and hit[0] == did and hit[1] >= time.time()


@router.get("/ext/_drafts/{did}/widget-frame", include_in_schema=False)
async def draft_widget_frame(did: str, grant: str = ""):
    from . import extframes
    from .extensions import WIDGET_BRIDGE, ui_kit_css, widget_csp

    def read() -> tuple[str, list[str]]:
        rec, ext = atelier.draft_widget(did)
        p = ext.dir / "widget.html"
        if p.is_symlink() or not p.is_file():
            raise atelier.AtelierError(404, "not_found", f"no HTML widget in proposal {did}")
        hosts = list((rec.get("permissions") or {}).get("network") or []) if _grant_ok(did, grant) else []
        return p.read_text("utf-8", "replace"), hosts
    html, hosts = await _call(read)
    kit = await asyncio.to_thread(ui_kit_css)
    token = extframes.issue(f"draft:{did}", report=False)
    base = f"/ext/_drafts/{did}/f/{token}/"
    doc = WIDGET_BRIDGE.replace('<meta charset="utf-8">', f'<meta charset="utf-8"><base href="{base}">', 1)
    return HTMLResponse(doc + f"<style>{kit}</style>\n" + html, headers={
        "Cache-Control": "no-store", "Content-Security-Policy": widget_csp(hosts), "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"})


# ---- one creation -------------------------------------------------------------------------------------------------
@router.get("/api/atelier/{kind}/{iid}")
async def get_item(kind: str, iid: str):
    return await _call(atelier.detail, kind, iid)


@router.get("/api/atelier/{kind}/{iid}/versions/{n}")
async def get_version(kind: str, iid: str, n: int, against: Optional[str] = None):
    return await _call(atelier.version_detail, kind, iid, n, against)


@router.post("/api/atelier/{kind}/{iid}/rollback")
async def rollback(kind: str, iid: str, request: Request):
    raw = await request.body()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        raise _err(400, "bad_request", "the body must be JSON") from None
    res = await _call(atelier.rollback, kind, iid, data.get("version") if isinstance(data, dict) else None)
    try:
        await asyncio.to_thread(extensions.scan)
    except Exception:  # noqa: BLE001 - the version is installed; a broken one shows its error
        log.warning("extension scan after rollback failed", exc_info=True)
    _changed(True)
    item = await _call(_item_of, iid)
    return {"ok": True, "item": item, "version": res["version"]}


@router.post("/api/atelier/{kind}/{iid}/accept")
async def accept(kind: str, iid: str):
    res = await _call(atelier.accept, kind, iid)
    _changed()
    item = await _call(_item_of, iid)
    return {"ok": True, "item": item, "version": res["version"]}


# ---- background: proposals left by Codex turns, changes made by other processes ---------------------------------
async def _on_turn_end(session: dict, _result: Any = None) -> None:
    ids = await asyncio.to_thread(atelier.ingest_session, session)
    if ids:
        _changed(True)


async def _watch() -> None:
    last = await asyncio.to_thread(atelier.rev)
    checked = mirrored = 0.0
    while True:
        await asyncio.sleep(WATCH_S)
        try:
            cur = await asyncio.to_thread(atelier.rev)
            if cur != last:
                last = cur
                _changed(True)
            if time.time() - mirrored > 300 and not config.load_config().get("restore_hold"):
                mirrored = time.time()                   # workspace skills for Codex too
                await asyncio.to_thread(atelier_kinds.mirror_skills)
            if time.time() - checked > 3600:            # retention: once a day (checked every hour)
                checked = time.time()
                if await asyncio.to_thread(atelier.prune_due):
                    await asyncio.to_thread(atelier.prune)
        except Exception:  # noqa: BLE001 - keep watching
            log.debug("atelier watcher pass failed", exc_info=True)


async def startup() -> None:
    global _task
    from ..sessions import service
    if _on_turn_end not in getattr(service, "_turn_cbs", []):
        service.on_turn_end(_on_turn_end)
    if not config.load_config().get("restore_hold"):
        with contextlib.suppress(Exception):
            await asyncio.to_thread(atelier.refresh, True)
        with contextlib.suppress(Exception):
            await asyncio.to_thread(atelier_kinds.mirror_skills)
    _task = asyncio.create_task(_watch())


async def shutdown() -> None:
    global _task
    if _task:
        _task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _task
        _task = None

