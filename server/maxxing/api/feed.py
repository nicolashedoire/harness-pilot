"""Notifications feed + its sources (webhooks) and Telegram rules. See docs/dev/API.md#feed."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import bus, feed, feedhooks, push, sessionfeed
from ..feed import FeedError
from ..security import require_auth

log = logging.getLogger("maxxing.feed")

router = APIRouter(prefix="/api/feed", tags=["feed"], dependencies=[Depends(require_auth)])
WATCH_S = 3.0
_task: asyncio.Task | None = None


async def _call(fn: Callable[..., Any], *a: Any, **kw: Any) -> Any:
    try:
        return await asyncio.to_thread(fn, *a, **kw)
    except FeedError as e:
        raise HTTPException(e.status, detail={"error": e.code, "message": e.message}) from None


class PostIn(BaseModel):
    title: str
    body: str = ""
    level: str = "info"
    source: str = "custom"
    url: str = ""
    dedupe: str | None = None
    group: str | None = None
    kind: str | None = None
    params: dict[str, Any] | None = None
    actions: list[Any] | None = None


class ReadIn(BaseModel):
    ids: list[int] | None = None
    source: str | None = None
    all: bool = False


class ResolveIn(BaseModel):
    ids: list[int]


class SettingsIn(BaseModel):
    telegram: bool | None = None
    rules: dict[str, str] | None = None
    kind_rules: dict[str, str] | None = None


class HookIn(BaseModel):
    name: str
    kind: str
    secret: str = ""


class HookPatch(BaseModel):
    secret: str | None = None
    regenerate: bool = False


@router.get("")
async def list_events(source: str | None = None, unread: bool = False, before: int | None = None,
                      limit: int = Query(50, ge=1, le=200), category: str | None = None, kind: str | None = None,
                      pending: bool = False):
    return await _call(feed.list_events, source, unread, before, limit, category=category, kind=kind,
                       pending=pending)


@router.get("/summary")
async def summary():
    return await _call(feed.counts)


@router.post("")
async def post_event(body: PostIn):
    ev = await _call(feed.post, body.title, body.body, body.level, body.source, body.url, body.dedupe, body.group,
                     kind=body.kind, params=body.params, actions=body.actions)
    return {"event": ev, "duplicate": ev is None}


def _read(ids: list[int] | None, source: str | None, everything: bool) -> dict:
    return {"unread": feed.mark_read(ids, source, everything), "pending": feed.pending_count()}


@router.post("/read")
async def mark_read(body: ReadIn):
    return await _call(_read, body.ids, body.source, body.all)


@router.post("/resolve")
async def resolve(body: ResolveIn):
    return {"pending": await _call(feed.resolve_ids, body.ids)}


def _settings_view() -> dict:
    s = feed.settings()
    seen = {x["source"] for x in feed.source_counts()}
    names = list(feed.BUILTIN) + [h["name"] for h in s["hooks"]]
    names += sorted(seen - set(names))
    sources = [{"source": n, "label": feed.BUILTIN.get(n, n), "builtin": n in feed.BUILTIN,
                "rule": s["rules"].get(n, "auto"), "own_thread": n in feed.OWN_THREAD} for n in names]
    return {"telegram": s["telegram"], "sources": sources, "hooks": feedhooks.list_hooks(),
            "kinds": list(feedhooks.KINDS), "rules": list(feed.RULES), "kind_rules": s["kind_rules"],
            "event_kinds": feed.event_kinds(s)}


@router.get("/settings")
async def get_settings():
    return await _call(_settings_view)


def _save(body: SettingsIn) -> None:
    current = feed.settings()                         # merged into the saved maps ("auto" removes an entry)
    rules = {**current["rules"], **body.rules} if body.rules is not None else None
    kind_rules = {**current["kind_rules"], **body.kind_rules} if body.kind_rules is not None else None
    feed.save_settings(body.telegram, rules, kind_rules=kind_rules)


@router.put("/settings")
async def put_settings(body: SettingsIn):
    await _call(_save, body)
    return await _call(_settings_view)


@router.post("/hooks")
async def create_hook(body: HookIn):
    return await _call(feedhooks.create, body.name, body.kind, body.secret)


@router.patch("/hooks/{hid}")
async def patch_hook(hid: str, body: HookPatch):
    return await _call(feedhooks.update, hid, body.secret, body.regenerate)


@router.delete("/hooks/{hid}")
async def delete_hook(hid: str):
    await _call(feedhooks.remove, hid)
    return {"ok": True}


@router.post("/hooks/{hid}/test")
async def test_hook(hid: str):
    return {"event": await _call(feedhooks.test, hid)}


# after the fixed paths ("/settings", "/summary"): an id is digits only
@router.get("/{event_id:int}")
async def get_event(event_id: int):
    ev = await _call(feed.get, event_id, True)
    if ev is None:
        raise HTTPException(404, detail={"error": "not_found", "message": "No such event"})
    return {"event": ev}


@router.delete("/{event_id:int}")
async def delete_event(event_id: int):
    await _call(feed.delete, event_id)
    return {"ok": True}


async def _watch() -> None:
    """Events written by other processes (cron runs, `maxxing feed post`): tell the UI. Any change (this process's
    posts too) also sends the new rows to the Web Push subscriptions (push.dispatch, in a thread)."""
    last = None
    try:
        await asyncio.to_thread(push.prime)            # rows already there are never pushed
    except Exception:  # noqa: BLE001
        log.warning("push: cannot read the feed", exc_info=True)
    while True:
        try:
            cur = await asyncio.to_thread(feed.watch_id)
            if last is not None and cur != last:
                bus.invalidate("feed")
                await asyncio.to_thread(push.dispatch)
            last = cur
        except Exception:  # noqa: BLE001 - keep watching
            log.debug("feed watcher pass failed", exc_info=True)
        await asyncio.sleep(WATCH_S)


async def startup() -> None:
    global _task
    from ..sessions import service
    service.on_session_stop(sessionfeed.on_stop)       # session.done / session.failed / discussion.paused
    _task = asyncio.create_task(_watch())


async def shutdown() -> None:
    if _task:
        _task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _task
