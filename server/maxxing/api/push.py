"""Web Push subscriptions of the notifications feed. See docs/dev/API.md#web-push and maxxing/push.py."""
from __future__ import annotations

import asyncio
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import push
from ..push import PushError
from ..security import require_auth

router = APIRouter(prefix="/api/push", tags=["push"], dependencies=[Depends(require_auth)])


async def _call(fn: Callable[..., Any], *a: Any, **kw: Any) -> Any:
    try:
        return await asyncio.to_thread(fn, *a, **kw)
    except PushError as e:
        raise HTTPException(e.status, detail={"error": e.code, "message": e.message, **e.extra}) from None


class SubscriptionIn(BaseModel):
    endpoint: Any = None
    keys: Any = None
    label: str | None = None
    prefs: Any = None
    expirationTime: Any = None                          # sent by PushSubscription.toJSON(): ignored


class SubscriptionPatch(BaseModel):
    label: str | None = None
    prefs: Any = None


def _overview() -> dict:
    ok = push.available()
    return {"available": ok, "public_key": push.public_key() if ok else None, "subscriptions": push.subscriptions()}


@router.get("")
async def overview():
    return await _call(_overview)


@router.post("/subscriptions")
async def subscribe(body: SubscriptionIn):
    return await _call(push.subscribe, body.endpoint, body.keys, body.label, body.prefs)


@router.patch("/subscriptions/{sid}")
async def update(sid: str, body: SubscriptionPatch):
    return await _call(push.update, sid, body.label, body.prefs)


@router.delete("/subscriptions/{sid}")
async def remove(sid: str):
    await _call(push.remove, sid)
    return {"ok": True}


@router.post("/subscriptions/{sid}/test")
async def test(sid: str):
    return await _call(push.test, sid)
