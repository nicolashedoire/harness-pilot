"""Resident companion profiles and reviewable source experiments."""
from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import Field

from .. import companions, companion_pr
from ..security import require_auth
from ..sessions import service
from .sessions import _call, _Text

router = APIRouter(prefix='/api/companions', tags=['companions'], dependencies=[Depends(require_auth)])


class RoleIn(_Text):
    name: str = Field(min_length=1, max_length=80)
    role: str = Field(min_length=1, max_length=4000)
    provider: str | None = Field(default=None, max_length=64)


class RunIn(_Text):
    path: str
    mission: str = Field(default='', max_length=6000)


class PullRequestIn(_Text):
    fingerprint: str = Field(min_length=64, max_length=64)
    title: str = Field(min_length=1, max_length=180)
    body: str = Field(default='', max_length=12000)


class DecisionIn(_Text):
    decision: Literal['approved', 'rejected']
    fingerprint: str = Field(min_length=64, max_length=64)


async def startup() -> None:
    service.on_session_stop(companions.on_stop)


@router.get('')
async def list_companions():
    return {'companions': await asyncio.to_thread(companions.roles), 'runs': await asyncio.to_thread(companions.runs)}


@router.post('')
async def create_role(body: RoleIn):
    return await _call(companions.save, body.name, body.role, None, body.provider)


@router.put('/{ident}')
async def update_role(ident: str, body: RoleIn):
    return await _call(companions.save, body.name, body.role, ident, body.provider)


@router.post('/{ident}/runs')
async def start_run(ident: str, body: RunIn):
    return await _call(companions.run, ident, body.path, body.mission)


@router.get('/runs/{sid}/review')
async def get_review(sid: str):
    return await _call(companions.review, sid)


@router.post('/runs/{sid}/decision')
async def decision(sid: str, body: DecisionIn):
    return await _call(companions.decide, sid, body.decision, body.fingerprint)


@router.post('/runs/{sid}/pull-request')
async def create_pull_request(sid: str, body: PullRequestIn):
    return await _call(companion_pr.publish, sid, body.fingerprint, body.title, body.body)
