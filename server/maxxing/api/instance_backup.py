"""Full-instance snapshots, independent of selective GitHub memory backups."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, SecretStr

from .. import config, instance_backup as snapshots, uploads
from ..security import require_auth

log = logging.getLogger(__name__)
router = APIRouter(prefix='/api/backup/instance', tags=['backup'], dependencies=[Depends(require_auth)])


class ExportIn(BaseModel):
    passphrase: SecretStr = Field(min_length=12, max_length=1024)


class RestoreIn(BaseModel):
    id: str = Field(pattern=r'^[a-f0-9]{32}$')
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


_purger: asyncio.Task | None = None


async def startup() -> None:
    """Decrypted previews expire after PREVIEW_TTL: purge them at startup and again as soon as one expires."""
    global _purger

    async def purge_pass():
        while True:
            try:
                delay = await asyncio.to_thread(snapshots.purge_expired)
            except Exception:
                log.exception('Could not purge expired instance backup previews')
                delay = snapshots.PURGE_EVERY
            await asyncio.sleep(delay)

    if _purger is None or _purger.done():
        _purger = asyncio.create_task(purge_pass(), name='instance-backup-purge')


async def shutdown() -> None:
    global _purger
    if _purger is not None:
        _purger.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await _purger
        _purger = None


async def _call(function, *args):
    try:
        return await asyncio.to_thread(function, *args)
    except snapshots.SnapshotError as error:
        raise HTTPException(error.status, detail={'error': error.code, 'message': str(error)}) from None
    except OSError:
        raise HTTPException(400, detail={'error': 'snapshot_io', 'message':
            'Could not read or write all snapshot data. Check directory permissions and available disk space.'}) from None


@router.get('')
async def status(request: Request):
    return {**await _call(snapshots.status),
            'restore_hold': bool(config.load_config().get('restore_hold') or
                                 getattr(request.app.state, 'restore_activation_in_progress', False)),
            'service_resume_errors': getattr(request.app.state, 'snapshot_service_errors', [])}


@router.post('/export')
async def export(body: ExportIn, request: Request):
    try:
        return await request.app.state.export_instance_snapshot(body.passphrase.get_secret_value())
    except snapshots.SnapshotError as error:
        raise HTTPException(error.status, detail={'error': error.code, 'message': str(error)}) from None
    except OSError:
        raise HTTPException(400, detail={'error': 'snapshot_io', 'message':
            'Could not read or write all snapshot data. Check directory permissions and available disk space.'}) from None


@router.get('/exports')
async def exports():
    return await _call(snapshots.list_exports)


@router.delete('/exports/{ident}')
async def delete_export(ident: str):
    return await _call(snapshots.delete_export, ident)


@router.get('/download/{ident}')
async def download(ident: str):
    path = await _call(snapshots.exported, ident)
    return FileResponse(path, media_type='application/octet-stream', filename=f'pilot-{ident[:12]}.pilotbackup',
                        headers={'Cache-Control': 'no-store'})


def _save(file: UploadFile, path: Path):
    maximum, _ = uploads.limits()
    size = 0
    with path.open('xb') as target:
        path.chmod(0o600)
        while block := file.file.read(snapshots.CHUNK):
            size += len(block)
            if (maximum and size > maximum) or size > snapshots._archive_limit():
                raise snapshots.SnapshotError('too_large', 'The archive exceeds the configured backup/upload limit.', 413)
            uploads.check_room(path.parent, len(block))
            target.write(block)


@router.post('/preview')
async def preview(file: UploadFile = File(...), passphrase: str = Form(..., min_length=12, max_length=1024)):
    # UploadGuard authenticates and bounds the request before multipart parsing.
    with tempfile.TemporaryDirectory(prefix='upload-', dir=snapshots._base()) as temporary:
        source = Path(temporary) / 'archive.pilotbackup'
        await _call(_save, file, source)
        return await _call(snapshots.inspect, source, passphrase)


@router.post('/restore')
async def restore(body: RestoreIn):
    return await _call(snapshots.restore, body.id, body.sha256)


@router.post('/activate')
async def activate(request: Request):
    if not config.load_config().get('restore_hold'):
        return {'ok': True, 'already_active': True}
    await request.app.state.activate_restored_instance()
    return {'ok': True}


@router.post('/resume-integrations')
async def resume_integrations():
    """Telegram, scheduled jobs and the GitHub memory backup of a restored copy, once the original is stopped."""
    result = await _call(snapshots.resume_integrations)
    try:
        from ..telegram import gateway
        result['telegram'] = await gateway.start()
    except Exception:
        log.exception('Could not start Telegram after resuming integrations')
        result['telegram'] = False
    return result
