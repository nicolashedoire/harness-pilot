"""Explicit user-assigned space labels; these are not claims of authorship."""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import bus, config, workspace
from ..security import require_auth

router = APIRouter(prefix='/api/space-labels', tags=['space-labels'], dependencies=[Depends(require_auth)])
VALUES = ('personal', 'agents', 'shared')


def _file() -> Path:
    return config.state_dir('space-labels') / 'labels.json'


def _read() -> dict:
    data = config.read_json(_file(), {})
    return data if isinstance(data, dict) else {}


def _path(raw: str) -> Path:
    if not raw or not Path(raw).is_absolute() or '\0' in raw:
        raise HTTPException(400, detail={'error': 'bad_path', 'message': 'An absolute path is required.'})
    path = Path(os.path.abspath(raw))
    try:
        target = path.resolve(strict=True)
        roots = (workspace.root().resolve(), config.files_root().resolve())
        if not any(target == root or root in target.parents for root in roots):
            raise HTTPException(403, detail={'error': 'forbidden', 'message': 'Path is outside the workspace and files root.'})
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(404, detail={'error': 'not_found', 'message': 'Item not found.'}) from None
    return path


def _identity(path: Path) -> list[int]:
    st = path.stat()
    return [st.st_dev, st.st_ino]


@router.get('')
def list_labels():
    result = {}
    for raw, entry in _read().items():
        try:
            p = _path(raw)
            if isinstance(entry, dict) and entry.get('label') in VALUES and entry.get('identity') == _identity(p):
                result[raw] = entry['label']
        except (HTTPException, OSError, TypeError):
            continue
    return result


class LabelIn(BaseModel):
    path: str
    label: Literal['personal', 'agents', 'shared', 'unclassified']


@router.put('')
def set_label(body: LabelIn):
    p = _path(body.path)
    with open(config.state_dir('space-labels') / 'labels.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        labels = _read()
        if body.label == 'unclassified':
            labels.pop(str(p), None)
        else:
            labels[str(p)] = {'label': body.label, 'identity': _identity(p)}
        config.write_json(_file(), labels, mode=0o600)
    bus.invalidate('space-labels')
    return {'path': str(p), 'label': body.label}


def remap(src: Path, dst: Path) -> None:
    """Follow moves made through this application, including labelled descendants."""
    a, b = str(src), str(dst)
    with open(config.state_dir('space-labels') / 'labels.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        labels = _read()
        for key in list(labels):
            if key == a or key.startswith(a + os.sep):
                labels[b + key[len(a):]] = labels.pop(key)
        config.write_json(_file(), labels, mode=0o600)
    bus.invalidate('space-labels')


def refreshed(path: Path, previous: list[int] | None) -> None:
    """Preserve a label when the app itself atomically saves the same file."""
    if previous is None:
        return
    with open(config.state_dir('space-labels') / 'labels.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        labels = _read()
        entry = labels.get(str(path))
        if isinstance(entry, dict) and entry.get('identity') == previous:
            entry['identity'] = _identity(path)
            config.write_json(_file(), labels, mode=0o600)
    bus.invalidate('space-labels')
