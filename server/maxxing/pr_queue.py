"""Owner-reviewed, dependency-aware PR integration. All GitHub writes pin the approved head SHA."""
from __future__ import annotations

import asyncio
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from . import bus, config, feed
from .sessions.service import SessionError

URL = re.compile(r'^https://github\.com/([A-Za-z0-9-]{1,39})/([A-Za-z0-9_.-]{1,100})/pull/([1-9][0-9]{0,8})/?$')
SHA = re.compile(r'^[a-f0-9]{40,64}$')
MAX_ITEMS = 100
BATCH_SIZE = 3
MAX_OUTPUT = 2 * 1024 * 1024
_stop = threading.Event()
_task: asyncio.Task | None = None
_wake: asyncio.Event | None = None


def _dir() -> Path:
    folder = config.state_dir('pr-queue')
    folder.chmod(0o700)
    return folder


def _state() -> dict:
    data = config.read_json(_dir() / 'queue.json', {})
    origin = str(config.STATE.resolve())
    items = copy.deepcopy(data.get('items') or [])
    moved = bool(data.get('origin_state') and data['origin_state'] != origin)
    if moved:
        for item in items:
            if item['state'] not in ('merged', 'closed', 'cancelled'):
                item.update(approval=None, state='awaiting_review', reason='changed', checked_at=0,
                            revision=item.get('revision', 0) + 1)
    return {'origin_state': origin, 'paused': moved or bool(data.get('paused', True)), 'items': items}


@contextlib.contextmanager
def _edit():
    with (_dir() / 'queue.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        data = copy.deepcopy(_state())
        yield data
        config.write_json(_dir() / 'queue.json', data, mode=0o600)
    bus.invalidate('pr-queue')


def _find(data: dict, ident: str) -> dict:
    found = next((item for item in data['items'] if item['id'] == ident), None)
    if found is None:
        raise SessionError(404, 'not_found', 'Pull request queue item not found.')
    return found


def state() -> dict:
    data = _state()
    return {'paused': data['paused'], 'items': data['items'], 'github_cli_available': bool(shutil.which('gh'))}


def _api(path: str, *, method='GET', body: dict | None = None, diff=False):
    if _stop.is_set():
        raise SessionError(409, 'queue_stopping', 'The integration worker is stopping.')
    command = ['gh', 'api', '--hostname', 'github.com', '--method', method,
               '-H', 'Accept: ' + ('application/vnd.github.diff' if diff else 'application/vnd.github+json'),
               '-H', 'X-GitHub-Api-Version: 2026-03-10', path]
    if body is not None:
        command += ['--input', '-']
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(command, input=json.dumps(body).encode() if body is not None else None,
                stdin=subprocess.DEVNULL if body is None else None, stdout=output, stderr=subprocess.PIPE,
                timeout=20, env={**os.environ, 'GH_PROMPT_DISABLED': '1'})
            if result.returncode:
                if diff and b'HTTP 406' in result.stderr:
                    raise SessionError(413, 'too_large', 'GitHub cannot provide a complete diff for this pull request. Review it on GitHub; local approval is blocked.')
                code = 'github_conflict' if b'HTTP 409' in result.stderr else 'github_failed'
                raise SessionError(502, code, 'GitHub refused the request. Check access, checks and repository rules.')
            if output.tell() > MAX_OUTPUT:
                raise SessionError(413, 'too_large', 'This GitHub response is too large for the local review.')
            output.seek(0)
            raw = output.read().decode('utf-8')
        return raw if diff else json.loads(raw)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise SessionError(502, 'github_unavailable', 'GitHub CLI is unavailable, timed out or returned invalid data.') from None


def _metadata(item: dict) -> dict:
    value = _api(f"repos/{item['repo']}/pulls/{item['number']}")
    if (not isinstance(value, dict) or (value.get('base', {}).get('repo', {}).get('full_name') or '').casefold() != item['repo'].casefold()
            or not SHA.fullmatch(str(value.get('head', {}).get('sha') or ''))):
        raise SessionError(502, 'github_invalid', 'GitHub returned an unexpected pull request.')
    return {'head': value['head']['sha'], 'base_ref': value['base']['ref'], 'base_sha': value['base']['sha'],
            'title': str(value.get('title') or '')[:500], 'body': str(value.get('body') or '')[:30000],
            'draft': bool(value.get('draft')), 'merged': bool(value.get('merged')), 'merge_sha': value.get('merge_commit_sha'),
            'open': value.get('state') == 'open', 'mergeable': value.get('mergeable'),
            'mergeable_state': value.get('mergeable_state')}


def _bindings(data: dict, item: dict) -> list[list]:
    pairs = []
    for ident in sorted(item['dependencies']):
        dep = _find(data, ident)
        head = ((dep.get('snapshot') or {}).get('head') if dep.get('state') == 'merged'
                else (dep.get('approval') or {}).get('head'))
        pairs.append([ident, head])
    return pairs


def _fingerprint(item: dict, remote: dict, bindings: list[list], patch: str) -> str:
    payload = [item['repo'].casefold(), item['number'], remote['head'], remote['base_ref'], remote['base_sha'],
               item['method'], bindings, hashlib.sha256(patch.encode()).hexdigest()]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def add(url: str, dependencies: list[str], method='merge') -> dict:
    match = URL.fullmatch(url.strip())
    if not match or match[2] in ('.', '..') or method not in ('merge', 'squash'):
        raise SessionError(400, 'bad_request', 'Use a canonical GitHub pull request URL and merge or squash.')
    repo, number = '/'.join(match.groups()[:2]), int(match[3])
    if not isinstance(dependencies, list) or len(dependencies) > 20 or len(set(dependencies)) != len(dependencies):
        raise SessionError(400, 'bad_dependencies', 'Choose up to 20 distinct existing prerequisites.')
    with _edit() as data:
        if len(data['items']) >= MAX_ITEMS:
            raise SessionError(400, 'limit', 'The integration queue is full.')
        if any(i['repo'].casefold() == repo.casefold() and i['number'] == number and i['state'] != 'cancelled' for i in data['items']):
            raise SessionError(409, 'duplicate', 'This pull request is already in the queue.')
        for dependency in dependencies:
            _find(data, dependency)  # dependencies refer only to older entries: cycles cannot be created
        item = {'id': uuid.uuid4().hex, 'repo': repo, 'number': number, 'url': f'https://github.com/{repo}/pull/{number}',
                'method': method, 'dependencies': dependencies, 'state': 'awaiting_review', 'reason': 'approval',
                'approval': None, 'created': time.time(), 'checked_at': 0, 'revision': 0}
        data['items'].append(item)
    return copy.deepcopy(item)


def preview(ident: str) -> dict:
    data = _state()
    item = copy.deepcopy(_find(data, ident))
    remote = _metadata(item)
    patch = _api(f"repos/{item['repo']}/pulls/{item['number']}", diff=True)
    after = _metadata(item)
    if any(after[key] != remote[key] for key in ('head', 'base_ref', 'base_sha')):
        raise SessionError(409, 'changed', 'The pull request changed while its diff was loading. Review it again.')
    bindings = _bindings(data, item)
    return {'item': item, 'snapshot': remote, 'patch': patch,
            'fingerprint': _fingerprint(item, remote, bindings, patch), 'dependencies': bindings}


def approve(ident: str, fingerprint: str) -> dict:
    reviewed = preview(ident)
    if fingerprint != reviewed['fingerprint']:
        raise SessionError(409, 'changed', 'The reviewed commit or dependencies changed. Review the current diff.')
    if reviewed['snapshot']['merged'] or not reviewed['snapshot']['open'] or reviewed['snapshot']['draft']:
        raise SessionError(409, 'not_open', 'Only a ready, open pull request can be approved for integration.')
    if any(not head for _, head in reviewed['dependencies']):
        raise SessionError(409, 'dependencies_unreviewed', 'Review and approve the prerequisite pull requests first.')
    with _edit() as data:
        item = _find(data, ident)
        if item['state'] in ('merging', 'merge_requested', 'cancelled', 'merged'):
            raise SessionError(409, 'busy', 'This item cannot receive a new approval in its current state.')
        if _bindings(data, item) != reviewed['dependencies']:
            raise SessionError(409, 'changed', 'The prerequisites changed while approval was being recorded.')
        item['revision'] = item.get('revision', 0) + 1
        item.update(approval={'fingerprint': fingerprint, 'head': reviewed['snapshot']['head'],
            'base_ref': reviewed['snapshot']['base_ref'], 'base_sha': reviewed['snapshot']['base_sha'], 'dependencies': reviewed['dependencies'], 'at': time.time()},
            snapshot=reviewed['snapshot'], state='queued', reason='paused' if data['paused'] else 'checks', checked_at=0)
    if _wake:
        _wake.set()
    return state()


def pause(paused: bool) -> dict:
    with _edit() as data:
        data['paused'] = bool(paused)
    if _wake:
        _wake.set()
    return state()


def cancel(ident: str) -> dict:
    with _edit() as data:
        item = _find(data, ident)
        if item['state'] in ('merging', 'merge_requested', 'merged'):
            raise SessionError(409, 'already_sent', 'An already initiated GitHub merge cannot be cancelled here.')
        item['revision'] = item.get('revision', 0) + 1
        item.update(state='cancelled', reason='cancelled', approval=None)
    return state()


def retry(ident: str) -> dict:
    with _edit() as data:
        item = _find(data, ident)
        if item['state'] != 'merge_failed' or not item.get('approval'):
            raise SessionError(409, 'not_retryable', 'This item has no approved merge to retry.')
        item['revision'] = item.get('revision', 0) + 1
        item.update(state='queued', reason='checks', checked_at=0)
    if _wake:
        _wake.set()
    return state()


def _checks(item: dict, remote: dict) -> str | None:
    if not remote['open'] or remote['draft']:
        return 'draft_or_closed'
    if remote['mergeable'] is not True:
        return 'conflict' if remote['mergeable'] is False else 'computing'
    if remote['mergeable_state'] in ('blocked', 'behind', 'dirty', 'unknown'):
        return 'repository_rules'
    root = f"repos/{item['repo']}"
    compared = _api(f"{root}/compare/{remote['base_sha']}...{remote['head']}")
    if compared.get('status') not in ('ahead', 'identical') or compared.get('behind_by') != 0:
        return 'base_changed'
    runs = _api(f"{root}/commits/{remote['head']}/check-runs?per_page=100&filter=latest")
    statuses = _api(f"{root}/commits/{remote['head']}/status?per_page=100")
    if runs.get('total_count', 0) > 100 or statuses.get('total_count', 0) > 100:
        return 'checks_incomplete'
    checks = runs.get('check_runs') or []
    states = statuses.get('statuses') or []
    if any(run.get('status') != 'completed' for run in checks) or any(s.get('state') == 'pending' for s in states):
        return 'checks_pending'
    if any(run.get('conclusion') not in ('success', 'skipped', 'neutral') for run in checks) or any(s.get('state') != 'success' for s in states):
        return 'checks_failed'
    if not any(run.get('conclusion') == 'success' for run in checks) and not states:
        return 'no_checks'
    reviews = _api(f"{root}/pulls/{item['number']}/reviews?per_page=100")
    if len(reviews) >= 100:
        return 'reviews_incomplete'
    last = {}
    for review in reviews:
        if review.get('state') in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
            last[(review.get('user') or {}).get('id')] = review['state']
    return 'changes_requested' if 'CHANGES_REQUESTED' in last.values() else None


def _notify(item: dict, kind: str):
    head = (item.get('snapshot') or {}).get('head', '')
    feed.post('Pull request merged' if kind == 'merged' else 'Pull request needs your review',
              f"{item['repo']} #{item['number']}", 'success' if kind == 'merged' else 'warning', 'system',
              f"/settings/pull-requests?item={item['id']}", dedupe=f"pr-queue:{item['id']}:{kind}:{head}",
              kind='pr_queue.' + kind, params={'repo': item['repo'], 'number': item['number']}, trusted=True)


def _record(ident: str, *, expected_revision: int | None = None, **values) -> dict:
    with _edit() as data:
        item = _find(data, ident)
        if item['state'] == 'cancelled' or (expected_revision is not None and item.get('revision', 0) != expected_revision):
            return copy.deepcopy(item)
        item.update(values, checked_at=time.time())
        return copy.deepcopy(item)


def _process(ident: str, *, allow_merge: bool):
    data = _state()
    item = copy.deepcopy(_find(data, ident))
    def record(**values):
        return _record(ident, expected_revision=item.get('revision', 0), **values)
    remote = _metadata(item)
    if remote['merged']:
        merged = record(state='merged', reason='merged', snapshot=remote)
        if merged['state'] == 'merged':
            _notify(merged, 'merged')
        return
    if not remote['open']:
        record(state='closed', reason='closed', snapshot=remote)
        return
    approval = item.get('approval')
    if not approval:
        record(state='awaiting_review', reason='approval', snapshot=remote)
        return
    data = _state()
    if (remote['head'] != approval['head'] or remote['base_ref'] != approval['base_ref'] or remote['base_sha'] != approval.get('base_sha')
            or _bindings(data, item) != approval['dependencies']):
        changed = record(state='awaiting_review', reason='changed', snapshot=remote, approval=None)
        if changed['state'] == 'awaiting_review' and changed['reason'] == 'changed':
            _notify(changed, 'review')
        return
    if item['state'] in ('merging', 'merge_requested'):
        record(reason='github_pending', snapshot=remote)
        return
    if item['state'] == 'merge_failed':
        record(snapshot=remote)
        return
    reason = 'dependencies' if any(_find(data, dep)['state'] != 'merged' for dep in item['dependencies']) else None
    reason = reason or _checks(item, remote)
    if not reason and (data['paused'] or not allow_merge):
        reason = 'paused' if data['paused'] else 'ready'
    if reason:
        record(state='queued' if reason in ('paused', 'ready') else 'blocked', reason=reason, snapshot=remote)
        return
    with _edit() as current:
        live = _find(current, ident)
        if (_stop.is_set() or current['paused'] or live.get('approval') != approval
                or live['state'] == 'cancelled' or _bindings(current, live) != approval['dependencies']
                or any(_find(current, dep)['state'] != 'merged' for dep in live['dependencies'])):
            return
        live.update(state='merging', reason='github_pending', snapshot=remote)
    try:
        result = _api(f"repos/{item['repo']}/pulls/{item['number']}/merge", method='PUT',
                      body={'sha': approval['head'], 'merge_method': item['method']})
        if result.get('merged') is True:
            merged = record(state='merged', reason='merged', snapshot={**remote, 'merged': True, 'merge_sha': result.get('sha')})
            if merged['state'] == 'merged':
                _notify(merged, 'merged')
        else:
            record(state='merge_requested', reason='github_pending', snapshot=remote)
    except SessionError as error:
        record(state='merge_failed', reason=error.code, snapshot=remote)


def tick(*, allow_merge=True, force=False):
    with (_dir() / 'worker.lock').open('a') as leader:
        try:
            fcntl.flock(leader, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return state()
        due = sorted((i for i in _state()['items'] if i['state'] not in ('cancelled', 'merged', 'closed')),
                     key=lambda i: (i.get('checked_at', 0), i['created']))
        processed = 0
        for item in due:
            if _stop.is_set():
                break
            if item['state'] in ('cancelled', 'merged', 'closed'):
                continue
            if not force and time.time() - item.get('checked_at', 0) < 30:
                continue
            if processed >= BATCH_SIZE:
                break
            processed += 1
            try:
                _process(item['id'], allow_merge=allow_merge)
            except SessionError as error:
                _record(item['id'], expected_revision=item.get('revision', 0), reason=error.code)
        return state()


async def startup():
    global _task, _wake
    _stop.clear()
    if os.environ.get('MAXXING_PR_QUEUE_WORKER') == '0' or _task and not _task.done():
        return
    _wake = asyncio.Event()
    async def worker():
        while not _stop.is_set():
            try:
                await asyncio.to_thread(tick)
            except Exception:
                import logging
                logging.getLogger(__name__).exception('PR queue refresh failed')
            if not _stop.is_set():
                try:
                    await asyncio.wait_for(_wake.wait(), timeout=15)
                except asyncio.TimeoutError:
                    pass
                _wake.clear()
    _task = asyncio.create_task(worker())


async def shutdown():
    global _task
    _stop.set()
    if _wake:
        _wake.set()
    if _task:
        await _task  # finish the bounded in-flight request before a snapshot or server shutdown
        _task = None
