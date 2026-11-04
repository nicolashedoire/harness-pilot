"""Persistent companion roles and reviewable source experiments."""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from . import bus, config, feed, workspace
from .sessions import service, store

DEFAULT = {'id': 'observer', 'name': 'Platform observer', 'provider': 'codex',
           'role': 'Inspect the platform, identify a small useful improvement, implement it in the isolated copy, '
                   'run relevant tests and explain the change, evidence and limitations.'}
MAX_PATCH = 2 * 1024 * 1024


def _dir() -> Path:
    path = config.state_dir('companions')
    os.chmod(path, 0o700)
    return path


def _read() -> list[dict]:
    items = config.read_json(_dir() / 'roles.json', [])
    return items if isinstance(items, list) else []


def roles() -> list[dict]:
    items = _read()
    return [next((p for p in items if isinstance(p, dict) and p.get('id') == 'observer'), DEFAULT),
            *[p for p in items if isinstance(p, dict) and p.get('id') != 'observer']]


def save(name: str, role: str, ident: str | None = None) -> dict:
    name, role = name.strip(), role.strip()
    if not name or not role or len(name) > 80 or len(role) > 4000:
        raise service.SessionError(400, 'bad_role', 'A name and role are required.')
    with open(_dir() / 'roles.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        items = [p for p in _read() if isinstance(p, dict)]
        if ident and not any(p.get('id') == ident for p in roles()):
            raise service.SessionError(404, 'not_found', 'Companion not found.')
        if not ident and len(items) >= 99:
            raise service.SessionError(400, 'limit', 'Maximum number of companions reached.')
        item = {'id': ident or str(uuid.uuid4()), 'name': name, 'role': role, 'provider': 'codex'}
        config.write_json(_dir() / 'roles.json', [p for p in items if p.get('id') != item['id']] + [item], mode=0o600)
    bus.invalidate('companions')
    return item


def _git(cwd: Path, *args: str, limit: int = MAX_PATCH) -> bytes:
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0'}
    try:
        with tempfile.TemporaryFile() as out:
            result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=cwd, env=env,
                                    stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.PIPE, timeout=90)
            if result.returncode:
                raise service.SessionError(400, 'git_failed', 'Could not inspect the experiment checkout.')
            if out.tell() > limit:
                raise service.SessionError(400, 'too_large', 'The proposal is too large to review here.')
            out.seek(0)
            return out.read()
    except (OSError, subprocess.TimeoutExpired) as e:
        raise service.SessionError(400, 'git_failed', f'Git could not prepare the experiment: {type(e).__name__}.') from None


def _clone(run_id: str) -> Path:
    root = _dir() / 'runs' / run_id
    root.mkdir(parents=True, mode=0o700)
    dest = root / 'repo'
    try:
        _git(config.CODE, 'clone', '--quiet', '--depth', '1', '--no-local', '--', config.CODE.resolve().as_uri(), str(dest), limit=1000)
        _git(dest, 'remote', 'remove', 'origin', limit=1000)
    except Exception:
        shutil.rmtree(root, ignore_errors=True)  # only the newly created, private experiment
        raise
    return dest


def run(ident: str, path: str, mission: str = '') -> dict:
    profile = next((p for p in roles() if p['id'] == ident), None)
    if profile is None:
        raise service.SessionError(404, 'not_found', 'Companion not found.')
    try:
        workspace.topic_dir(workspace.normalize_path(path))
    except ValueError as e:
        raise service.SessionError(400, 'bad_path', str(e)) from None
    if len(mission) > 6000:
        raise service.SessionError(400, 'bad_mission', 'Mission is too long.')
    run_id = str(uuid.uuid4())
    repo = _clone(run_id)
    base = _git(repo, 'rev-parse', 'HEAD', limit=100).decode().strip()
    try:
        session = service.create_session(path, title=f"{profile['name']} — platform review", provider='codex',
                                         permission_mode='acceptEdits', timeout_s=1800)
        sid = session['id']
        with store.edit(sid) as meta:
            meta['companion'] = {'id': ident, 'name': profile['name'], 'role': profile['role'],
                                 'run_id': run_id, 'base': base, 'decision': None}
        text = (f"You are {profile['name']}, a resident companion. Your persistent role:\n{profile['role']}\n\n"
                "You are working in a disposable clone of the platform source. Inspect the code, identify one "
                "concrete improvement, implement a small change in this clone, run relevant tests, and report "
                "the exact commands and outcomes. Explain if a test could not run. Do not push, merge, publish, "
                "contact external services, modify files outside this clone, or change credentials. "
                "The user must review and approve or reject your proposal. Respond in French.\n\n"
                f"Additional mission: {mission.strip() or 'Find a useful, small improvement.'}")
        service.send_message(sid, text, source='companion')
        bus.invalidate('companions', 'sessions')
        return service.get_session(sid) or session
    except Exception:
        # Preserve any session already created for diagnosis; do not touch other runs.
        raise


def _meta(sid: str) -> tuple[dict, dict, Path]:
    meta = service._require(sid)
    c = meta.get('companion')
    if not isinstance(c, dict) or not store.is_valid_id(str(c.get('run_id') or '')):
        raise service.SessionError(404, 'not_found', 'Companion run not found.')
    root = (_dir() / 'runs').resolve()
    repo = (root / c['run_id'] / 'repo').resolve()
    if root not in repo.parents or not repo.is_dir():
        raise service.SessionError(404, 'not_found', 'Experiment checkout not found.')
    return meta, c, repo


def runs() -> list[dict]:
    found = []
    for sid in store.list_ids():
        meta = store.read_cached(sid) or {}
        if isinstance(meta.get('companion'), dict):
            found.append(service.public(meta))
    return sorted(found, key=lambda s: s.get('created') or 0, reverse=True)[:100]


def review(sid: str) -> dict:
    meta, companion, repo = _meta(sid)
    base = str(companion.get('base') or '')
    if not re.fullmatch(r'[0-9a-f]{40,64}', base):
        raise service.SessionError(400, 'bad_base', 'Experiment base is invalid.')
    patch = _git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--binary', base, '--')
    raw = _git(repo, 'ls-files', '--others', '--exclude-standard', '-z')
    additions = []
    for rel in raw.decode('utf-8', 'replace').split('\0'):
        if not rel:
            continue
        p = repo / rel
        try:
            info = p.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 100000 or repo not in p.resolve().parents:
                raise service.SessionError(400, 'too_large', 'An untracked item cannot be reviewed safely.')
            data = p.read_bytes()
            if b'\0' in data:
                raise service.SessionError(400, 'binary_file', 'Binary additions cannot be reviewed here.')
            try:
                data.decode('utf-8')
            except UnicodeDecodeError:
                raise service.SessionError(400, 'binary_file', 'Non-UTF-8 additions cannot be reviewed here.') from None
        except OSError:
            raise service.SessionError(400, 'read_failed', 'An experiment file could not be read.') from None
        additions.append((rel, data))
        if len(patch) + sum(len(d) for _, d in additions) > MAX_PATCH:
            raise service.SessionError(400, 'too_large', 'The proposal is too large to review here.')
    digest = hashlib.sha256(patch)
    for name, data in additions:
        digest.update(name.encode() + b'\0' + data + b'\0')
    return {'session': service.public(meta), 'fingerprint': digest.hexdigest(), 'patch': patch.decode('utf-8', 'replace'),
            'untracked': [{'path': name, 'content': data.decode('utf-8', 'replace')} for name, data in additions],
            'has_changes': bool(patch or additions), 'base': base, 'decision': companion.get('decision')}


def decide(sid: str, decision: str, fingerprint: str) -> dict:
    if decision not in ('approved', 'rejected'):
        raise service.SessionError(400, 'bad_decision', 'Invalid decision.')
    result = review(sid)
    with store.edit(sid) as meta:
        if not isinstance(meta.get('companion'), dict):
            raise service.SessionError(404, 'not_found', 'Companion run not found.')
        if meta.get('state') == 'running':
            raise service.SessionError(409, 'running', 'Wait until the experiment stops.')
        if not result['has_changes'] or result['fingerprint'] != fingerprint:
            raise service.SessionError(409, 'changed', 'The proposal changed; review it again.')
        meta['companion']['decision'] = {'value': decision, 'fingerprint': fingerprint, 'at': time.time()}
    bus.invalidate('companions', 'sessions')
    return review(sid)


def _notify(session: dict) -> None:
    sid = str(session.get('id') or '')
    meta = store.read(sid) or {}
    if not isinstance(meta.get('companion'), dict):
        return
    if session.get('state') == 'error':
        url = f'/settings/companions?run={sid}'
        feed.system('Companion review needs attention', 'The experiment stopped with an error. Open its conversation.',
                    'warning', 'system', url, dedupe=f'companion-error:{sid}:{session.get("updated")}', kind='companion.error')
        return
    if session.get('state') != 'idle' or not session.get('turns'):
        return
    try:
        result = review(sid)
        url = f'/settings/companions?run={sid}'
        text = 'A source-code proposal is ready for your review.' if result['has_changes'] else 'The review finished without a code change.'
        feed.system('Companion review ready', text, 'warning' if result['has_changes'] else 'info', 'system', url,
                    dedupe=f"companion:{sid}:{session['turns']}", kind='companion.ready' if result['has_changes'] else 'companion.empty',
                    actions=[feed.link('review', 'Review', url)])
    except service.SessionError:
        feed.system('Companion review needs attention', 'Open the companion session to inspect the result.',
                    'warning', 'system', f'/settings/companions?run={sid}', kind='companion.error')


async def on_stop(session: dict) -> None:
    await asyncio.to_thread(_notify, session)
