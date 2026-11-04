"""Owner review and dependency-aware pull request integration."""
from fastapi import APIRouter, Depends
from pydantic import Field

from .. import pr_queue
from ..security import require_auth
from .sessions import _Text, _call

router = APIRouter(prefix='/api/pr-queue', tags=['pull-requests'], dependencies=[Depends(require_auth)])


class AddIn(_Text):
    url: str = Field(min_length=1,max_length=1000)
    dependencies: list[str] = Field(default_factory=list,max_length=20)
    method: str = 'merge'


class ApproveIn(_Text):
    fingerprint: str = Field(pattern=r'^[a-f0-9]{64}$')


class PauseIn(_Text):
    paused: bool


@router.get('')
async def get_queue():
    return await _call(pr_queue.state)


@router.post('')
async def add(body:AddIn):
    return await _call(pr_queue.add,body.url,body.dependencies,body.method)


@router.put('/pause')
async def pause(body:PauseIn):
    return await _call(pr_queue.pause,body.paused)


@router.post('/refresh')
async def refresh():
    return await _call(pr_queue.tick,allow_merge=False,force=True)


@router.get('/{ident}/preview')
async def preview(ident:str):
    return await _call(pr_queue.preview,ident)


@router.post('/{ident}/approve')
async def approve(ident:str,body:ApproveIn):
    return await _call(pr_queue.approve,ident,body.fingerprint)


@router.post('/{ident}/cancel')
async def cancel(ident:str):
    return await _call(pr_queue.cancel,ident)


@router.post('/{ident}/retry')
async def retry(ident:str):
    return await _call(pr_queue.retry,ident)


async def startup():
    await pr_queue.startup()


async def shutdown():
    await pr_queue.shutdown()
