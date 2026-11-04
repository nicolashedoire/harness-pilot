"""Owner-reviewed plans and bounded resident mission operation."""
import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from .. import missions
from ..security import require_auth
from ..sessions import service
from .sessions import _Text


async def _call(fn, *args, **kw):
    """Like the sessions helper, keeping an error's details: a too-long step says which step and by how much
    (`step`, `title`, `excess`)."""
    try:
        return await asyncio.to_thread(fn, *args, **kw)
    except service.SessionError as e:
        raise HTTPException(e.status, detail={'error': e.code, 'message': e.message, **getattr(e, 'details', {})}) from None


router = APIRouter(prefix='/api/missions', tags=['missions'], dependencies=[Depends(require_auth)])


class StepIn(_Text):
    id: str = Field(pattern=r'^[a-z0-9-]{1,40}$')
    title: str = Field(min_length=1, max_length=120)
    role: str = Field(max_length=100)
    instruction: str = Field(min_length=1, max_length=2000)
    after: list[str] = Field(default_factory=list, max_length=8)


class CreateIn(_Text):
    title: str = Field(min_length=1, max_length=120)
    path: str
    goal: str = Field(min_length=1, max_length=2000)
    steps: list[StepIn] = Field(default_factory=list, max_length=8)
    max_runs: int = Field(default=8, ge=1, le=32)
    max_minutes: int = Field(default=60, ge=1, le=1440)
    max_tokens: int = Field(default=1000000, ge=1, le=100000000)
    concurrent: int = Field(default=1, ge=1, le=2)
    interval_minutes: int = Field(default=0, ge=0, le=10080)
    max_cycles: int = Field(default=1, ge=1, le=32)


class PlanIn(_Text):
    steps: list[StepIn] = Field(min_length=1, max_length=8)


class ActionIn(_Text):
    action: Literal['start', 'pause', 'stop', 'plan']
    fingerprint: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


@router.get('')
async def listing():
    return await _call(missions.listing)


@router.post('')
async def create(body: CreateIn):
    values = body.model_dump()
    return await _call(missions.create, **values)


@router.get('/{ident}')
async def get(ident: str):
    return await _call(missions.get, ident)


@router.put('/{ident}/plan')
async def plan(ident: str, body: PlanIn):
    return await _call(missions.save_plan, ident, [s.model_dump() for s in body.steps])


@router.post('/{ident}/control')
async def control(ident: str, body: ActionIn):
    return await _call(missions.control, ident, body.action, body.fingerprint)


@router.post('/{ident}/steps/{step}/skip')
async def skip(ident: str, step: str):
    return await _call(missions.acknowledge, ident, step)


@router.post('/{ident}/steps/{step}/retry')
async def retry(ident: str, step: str):
    return await _call(missions.retry, ident, step)


async def startup():
    await missions.startup()


async def shutdown():
    await missions.shutdown()
