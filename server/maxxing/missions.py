"""Bounded resident missions. Agent plans are advisory until an owner activates them."""
from __future__ import annotations

import asyncio
import contextlib
import copy
import fcntl
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid

from . import bus, companions, config, feed, workspace
from .sessions import service, store

_stop = threading.Event()
_task: asyncio.Task | None = None
MAX_MISSIONS = 50
_now = time.time  # the mission clock (tests replace it)


def _dir():
    folder = config.state_dir('resident-missions')
    folder.chmod(0o700)
    return folder


def _path(ident):
    if not re.fullmatch(r'[a-f0-9]{32}', ident):
        raise service.SessionError(404, 'not_found', 'Mission not found.')
    return _dir() / (ident + '.json')


def _read(ident):
    value = config.read_json(_path(ident))
    if not isinstance(value, dict):
        raise service.SessionError(404, 'not_found', 'Mission not found.')
    value.pop('plan_fingerprint', None)
    return value


def get(ident, engines=None):
    value = _read(ident)
    value['plan_fingerprint'] = _fingerprint(value, engines)
    return value


def _engines():
    """What each role would run now: its instructions and its engine. A plugin engine is identified by its resolved
    command and capabilities, so a replaced adapter is a different engine; an unavailable one is marked as such."""
    from . import agent_providers
    providers = {p['id']: p for p in agent_providers.available()}
    result = {}
    for profile in companions.roles():
        provider = profile.get('provider') or 'codex'
        adapter = providers.get(provider)
        engine = {'id': provider, 'available': adapter is not None}
        if adapter and not adapter.get('builtin'):
            engine.update(command=adapter.get('command'), capabilities=adapter.get('capabilities'))
        result[profile['id']] = {'role': profile.get('role'), 'engine': engine}
    return result


def _fingerprint(data, engines=None):
    """What the owner authorizes by starting: the plan, its limits, and the instructions and engine of every role it
    uses (editing one of those roles afterwards requires a new review)."""
    engines = _engines() if engines is None else engines
    fields = ('title', 'path', 'goal', 'max_runs', 'max_seconds', 'max_tokens', 'concurrent', 'interval_seconds', 'max_cycles')
    plan = {k: data[k] for k in fields}
    plan['steps'] = [{k: step[k] for k in ('id', 'title', 'role', 'instruction', 'after')} for step in data['steps']]
    plan['roles'] = {role: engines.get(role) for role in sorted({step['role'] for step in data['steps']})}
    return hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _listing():
    return sorted((_read(p.stem) for p in _dir().glob('*.json')), key=lambda m: m['created'], reverse=True)


def listing():
    engines = _engines()
    return [{**data, 'plan_fingerprint': _fingerprint(data, engines)} for data in _listing()]


@contextlib.contextmanager
def _edit(ident):
    _path(ident)  # validate before opening the lock path
    with (_dir() / (ident + '.lock')).open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        data = _read(ident)
        yield data
        config.write_json(_path(ident), data, mode=0o600)
    bus.invalidate('missions')


def _validate_steps(steps):
    if not isinstance(steps, list) or not 1 <= len(steps) <= 8:
        raise service.SessionError(400, 'bad_plan', 'A plan needs one to eight steps.')
    roles = {p['id'] for p in companions.roles()}
    seen = set()
    result = []
    for value in steps:
        if not isinstance(value, dict):
            raise service.SessionError(400, 'bad_plan', 'Invalid plan step.')
        ident = str(value.get('id') or '')
        title = str(value.get('title') or '').strip()
        role = str(value.get('role') or '')
        instruction = str(value.get('instruction') or '').strip()
        after = value.get('after') or []
        try:
            title.encode('utf-8')
            instruction.encode('utf-8')
        except UnicodeEncodeError:
            raise service.SessionError(400, 'bad_plan', 'The plan contains invalid Unicode text.') from None
        if (not re.fullmatch(r'[a-z0-9-]{1,40}', ident) or ident in seen or not 1 <= len(title) <= 120
                or role not in roles or not 1 <= len(instruction) <= 2000 or not isinstance(after, list)
                or any(not isinstance(dep, str) or dep not in seen for dep in after) or len(after) != len(set(after))):
            raise service.SessionError(400, 'bad_plan', 'Use existing roles and distinct steps with earlier prerequisites.')
        result.append({'id': ident, 'title': title, 'role': role, 'instruction': instruction,
                       'after': after, 'state': 'pending', 'session': None})
        seen.add(ident)
    return result


def create(title, path, goal, steps, max_runs=8, max_minutes=60, max_tokens=1000000,
           concurrent=1, interval_minutes=0, max_cycles=1):
    title, goal = title.strip(), goal.strip()
    if not title or len(title) > 120 or not goal or len(goal) > 2000:
        raise service.SessionError(400, 'bad_mission', 'A title and bounded goal are required.')
    try:
        path = workspace.normalize_path(path)
        workspace.topic_dir(path)
    except ValueError as error:
        raise service.SessionError(400, 'bad_path', str(error)) from None
    if (not 1 <= max_runs <= 32 or not 1 <= max_minutes <= 1440 or not 1 <= max_tokens <= 100000000
            or concurrent not in (1, 2) or not 0 <= interval_minutes <= 10080 or not 1 <= max_cycles <= 32):
        raise service.SessionError(400, 'bad_budget', 'Mission limits are out of range.')
    plan = _validate_steps(steps) if steps else []
    # Serialize the installation-wide count and publication of a new mission.
    with (_dir() / 'create.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if len(list(_dir().glob('*.json'))) >= MAX_MISSIONS:
            raise service.SessionError(400, 'limit', 'The mission list is full.')
        data = {'id': uuid.uuid4().hex, 'title': title, 'path': path, 'goal': goal, 'steps': plan,
                'phase': 'draft', 'reason': '', 'created': _now(), 'origin_state': str(config.STATE.resolve()),
                'max_runs': max_runs, 'max_seconds': max_minutes * 60, 'max_tokens': max_tokens,
                'concurrent': concurrent, 'interval_seconds': interval_minutes * 60, 'max_cycles': max_cycles,
                'cycle': 1, 'spent_seconds': 0, 'active_since': None, 'next_cycle': None,
                'launches': [], 'tokens': 0, 'planner': None}
        config.write_json(_path(data['id']), data, mode=0o600)
    bus.invalidate('missions')
    return get(data['id'])


def _elapsed(data):
    return data['spent_seconds'] + (max(0, _now() - data['active_since']) if data.get('active_since') else 0)


def _bank(data):
    data['spent_seconds'] = _elapsed(data)
    data['active_since'] = None


def _track_work(data):
    """The time limit counts working time only: while a step or the planner is being prepared or works. Waiting for
    the next cycle or for the owner's decision on a proposal does not count."""
    working = any(s['state'] in ('starting', 'running') for s in data['steps'] + ([data['planner']] if data.get('planner') else []))
    if working and not data.get('active_since'):
        data['active_since'] = _now()
    elif not working and data.get('active_since'):
        _bank(data)


class _Aborted(service.SessionError):
    """A launch stopped before its agent received any message (owner pause or stop, shutdown, deadline)."""

    def __init__(self):
        super().__init__(409, 'stopped', 'Mission stopped before model launch.')


def _runs(data):
    """Counted runs: a reservation released before any model call is not one."""
    return sum(1 for launch in data['launches'] if not launch.get('aborted'))


def _reset(step):
    for key in ('key', 'started', 'error'):
        step.pop(key, None)
    step.update(state='pending', session=None, proposed=False)


def _release(data, step):
    """No model call was made for this step's reservation: the run is not counted and the step runs again (the planner
    is simply requested again)."""
    for launch in data['launches']:
        if launch['key'] == step.get('key'):
            launch['aborted'] = True
    if step is data.get('planner'):
        data['planner'] = None
    else:
        _reset(step)


def save_plan(ident, steps):
    plan = _validate_steps(steps)
    with _edit(ident) as data:
        if data['phase'] not in ('draft', 'plan_review', 'paused'):
            raise service.SessionError(409, 'busy', 'A running or previously executed plan cannot be replaced.')
        if any(s.get('session') for s in data['steps']):
            raise service.SessionError(409, 'busy', 'Started steps cannot be replaced.')
        data.update(steps=plan, phase='plan_review', reason='')
    return get(ident)


def control(ident, action, fingerprint=None):
    if action not in ('start', 'pause', 'stop', 'plan'):
        raise service.SessionError(400, 'bad_action', 'Unknown mission action.')
    stops = []
    with _edit(ident) as data:
        if action == 'plan':
            if (data['phase'] not in ('draft', 'plan_review', 'paused') or data['planner']
                    or any(s.get('session') for s in data['steps'])):
                raise service.SessionError(409, 'busy', 'This mission already has a planner run.')
            data.update(phase='planning', active_since=None, reason='')
        elif action == 'start':
            if fingerprint != _fingerprint(data):
                raise service.SessionError(409, 'changed', 'The plan or limits changed. Review the current plan before starting it.')
            if data['phase'] not in ('draft', 'plan_review', 'paused') or not data['steps']:
                raise service.SessionError(409, 'busy', 'Review a plan before starting this mission.')
            if _runs(data) >= data['max_runs'] or _elapsed(data) >= data['max_seconds'] or data['tokens'] >= data['max_tokens']:
                raise service.SessionError(409, 'budget', 'The authorized mission budget is exhausted.')
            for step in data['steps']:
                if step['state'] == 'interrupted' and not step.get('session'):
                    _reset(step)  # interrupted before any model call: runs again on resume
            if any(s['state'] in ('failed', 'rejected', 'interrupted') for s in data['steps']):
                raise service.SessionError(409, 'unresolved', 'Retry or skip the steps that need your attention first.')
            data.update(phase='active', active_since=None, reason='', approved_plan=fingerprint)
        else:
            if action == 'stop' and data['phase'] in ('completed', 'stopped', 'budget'):
                raise service.SessionError(409, 'busy', 'A terminal mission cannot be stopped again.')
            if action == 'pause' and data['phase'] not in ('active', 'planning'):
                raise service.SessionError(409, 'busy', 'Only an active mission can be paused.')
            _bank(data)
            data.update(phase='paused' if action == 'pause' else 'stopped', reason='owner')
            for step in data['steps'] + ([data['planner']] if data.get('planner') else []):
                if step.get('session') and step['state'] in ('starting', 'running'):
                    stops.append(step['session'])
                    step['state'] = 'interrupted'
            # Pending clone creation checks this phase again before keeping its new session.
    for sid in stops:
        service.stop(sid)
    return get(ident)


def acknowledge(ident, step_id):
    """Interrupted/error steps need an explicit decision to skip; never silently retry code work."""
    with _edit(ident) as data:
        if data['phase'] != 'paused':
            # Stopped, budget and completed are terminal: a skip must not turn them back into a resumable pause.
            raise service.SessionError(409, 'busy', 'Only a paused mission can skip a step.')
        step = next((s for s in data['steps'] if s['id'] == step_id), None)
        if step is None or step['state'] not in ('interrupted', 'failed', 'rejected'):
            raise service.SessionError(409, 'busy', 'Only an interrupted or failed step can be skipped.')
        step['state'] = 'skipped'
        data.update(phase='paused', reason='owner')
    return get(ident)


def retry(ident, step_id):
    """Explicit owner decision to run an interrupted, failed or rejected step again (a new, counted run)."""
    with _edit(ident) as data:
        if data['phase'] != 'paused':
            raise service.SessionError(409, 'busy', 'Only a paused mission can retry a step.')
        step = next((s for s in data['steps'] if s['id'] == step_id), None)
        if step is None or step['state'] not in ('interrupted', 'failed', 'rejected'):
            raise service.SessionError(409, 'busy', 'Only an interrupted, failed or rejected step can be retried.')
        _reset(step)
        data.update(reason='owner')
    return get(ident)


def _usage(data):
    total = 0
    for launch in data['launches']:
        meta = (store.read_cached(launch['session']) or {}) if launch.get('session') else {}
        for value in (meta.get('tokens') or {}).values():
            if isinstance(value, int) and value > 0:
                total += min(value, 10**12)
    return total


def _find_launch(key):
    for sid in store.list_ids():
        meta = store.read_cached(sid) or {}
        if (meta.get('companion') or {}).get('launch_key') == key:
            return sid
    return None


def _reconcile(data):
    for step in data['steps'] + ([data['planner']] if data.get('planner') else []):
        if step['state'] not in ('starting', 'running', 'review'):
            continue
        sid = step.get('session') or _find_launch(step['key'])
        if not sid:
            if _now() - step['started'] > 180:
                # No session carries this launch key: its message was never sent (the key is stored before it).
                _release(data, step)
            continue
        step['session'] = sid
        launch = next(l for l in data['launches'] if l['key'] == step['key'])
        launch['session'] = sid
        session = service.get_session(sid)
        if not session:
            step.update(state='failed', error='missing_session')
        elif session['state'] == 'running' or session.get('queue'):
            step['state'] = 'running'
        elif session['state'] == 'error' or not session.get('turns'):
            step.update(state='failed', error='agent_failed')
        elif step is data.get('planner'):
            step['state'] = 'complete'
        else:
            try:
                review = companions.review(sid)
                step['proposed'] = bool(review['has_changes'])
                decision = review.get('decision') or {}
                if not review['has_changes']:
                    step['state'] = 'complete'
                elif decision.get('fingerprint') != review['fingerprint']:
                    step['state'] = 'review'
                else:
                    step['state'] = 'complete' if decision.get('value') == 'approved' else 'rejected'
            except service.SessionError:
                step.update(state='failed', error='review_failed')
    data['tokens'] = _usage(data)


def _planner_prompt(data):
    catalog = []
    for profile in companions.roles():
        entry = {'id': profile['id'], 'name': profile['name'], 'role': profile['role'][:100]}
        if len(json.dumps(catalog + [entry], ensure_ascii=False)) > 2400:
            break
        catalog.append(entry)
    return ("Design a small actionable plan for this goal, using existing roles only. Do not implement it. "
            "Return ONLY a JSON object with a steps array (one to eight steps). Each step has id "
            "(lowercase letters/digits/hyphens), title, role (existing role id), instruction (at most 2000 characters), "
            "and after (earlier step ids only). Parallel steps must touch independent files. Include explicit user "
            "journey, design, accessibility and test checks where relevant. Never assume a predecessor's unmerged "
            "patch is applied: dependent steps receive reports, not merged files. The owner reviews the plan before execution.\n"
            + json.dumps({'goal': data['goal'], 'roles': catalog}, ensure_ascii=False))


def _plan_result(step):
    text = service.last_assistant_text(step['session']).strip()
    if len(text) > 30000:
        raise ValueError('oversized plan')
    if text.startswith('```'):
        text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    try:
        value = json.loads(text)
    except RecursionError:  # deeply nested agent output: not a ValueError
        raise ValueError('nested plan') from None
    return _validate_steps(value['steps'])


def _prepare(data, step, purpose):
    key = f"{data['id']}:{data['cycle']}:{step['id']}:{len(data['launches'])}"
    step.update(state='starting', key=key, started=_now(), session=None)
    data['launches'].append({'key': key, 'session': None})
    context = []
    for dep in data['steps']:
        if dep['id'] in step.get('after', []) and dep.get('session'):
            session = service.get_session(dep['session']) or {}
            context.append({'step': dep['title'], 'session': dep['session'], 'report': service.last_assistant_text(dep['session'])[:120],
                            'state': dep['state']})
    mission = (_planner_prompt(data) if purpose == 'plan' else
               f"Mission goal: {data['goal']}\nYour step: {step['title']}\n{step['instruction']}\n"
               "Predecessor reports are advisory. Their patches are NOT applied in this clone. "
               "Do not assume or duplicate a predecessor's code changes. If integration is needed, stop and explain it.\n"
               + json.dumps(context, ensure_ascii=False))
    return {'key': key, 'role': step['role'], 'path': data['path'], 'mission': mission, 'purpose': purpose,
            'timeout_s': max(60, min(1800, int(data['max_seconds'] - _elapsed(data))))}


def _notify(data):
    completed = data['phase'] == 'completed'
    feed.system('Resident mission completed' if completed else 'Resident mission needs your attention',
                data['title'], 'info' if completed else 'warning', 'system',
                '/settings/missions?mission=' + data['id'], dedupe=f"mission:{data['id']}:{data['cycle']}:{data['phase']}:{data['reason']}",
                kind='mission.completed' if data['phase'] == 'completed' else 'mission.review', params={'title': data['title']})


def _relocated(ident):
    """State restored or moved from another installation: pause automatic work only. Drafts, plans under review and
    terminal missions keep their phase (a restore must not revive a stopped or completed mission)."""
    current = str(config.STATE.resolve())
    if _read(ident)['origin_state'] == current:
        return
    notification = None
    with _edit(ident) as data:
        if data['origin_state'] == current:
            return
        data['origin_state'] = current
        if data['phase'] in ('active', 'planning'):
            _bank(data)
            data.update(phase='paused', reason='restored')
            for step in data['steps'] + ([data['planner']] if data.get('planner') else []):
                if step['state'] == 'starting' and not step.get('session'):
                    _release(data, step)
                elif step['state'] in ('starting', 'running'):
                    step['state'] = 'interrupted'
            notification = copy.deepcopy(data)
    if notification:
        _notify(notification)


def advance(ident):
    _relocated(ident)
    launch = None
    stops = []
    notification = None
    with _edit(ident) as data:
        if data['phase'] not in ('active', 'planning'):
            return
        _reconcile(data)
        other_slots = sum(1 for other in _listing() if other['id'] != ident and other['phase'] in ('active', 'planning')
                          for s in other['steps'] + ([other['planner']] if other.get('planner') else [])
                          if s['state'] in ('starting', 'running'))
        if (_elapsed(data) >= data['max_seconds'] or data['tokens'] >= data['max_tokens']):
            _bank(data)
            data.update(phase='budget', reason='time' if data['spent_seconds'] >= data['max_seconds'] else 'tokens')
        elif data['phase'] == 'active' and data.get('approved_plan') != _fingerprint(data):
            # A role of the plan (instructions or engine) changed after approval: nothing more runs until the owner
            # reviews and starts the plan again; agents still working are stopped like a pause.
            _bank(data)
            data.update(phase='paused', reason='plan_changed')
        elif any(s['state'] in ('failed', 'rejected', 'interrupted') for s in data['steps'] + ([data['planner']] if data['phase'] == 'planning' and data.get('planner') else [])):
            _bank(data)
            data.update(phase='paused', reason='step_failed')
        elif data['phase'] == 'planning':
            if data.get('planner') and data['planner']['state'] == 'complete':
                try:
                    data['steps'] = _plan_result(data['planner'])
                    data.update(phase='plan_review', reason='plan_ready')
                except (ValueError, KeyError, TypeError, service.SessionError):
                    data.update(phase='paused', reason='invalid_plan')
                _bank(data)
            elif data['planner'] is None and _runs(data) < data['max_runs'] and other_slots < 2 and not _stop.is_set():
                data['planner'] = {'id': 'planner', 'role': 'architect', 'state': 'pending', 'after': []}
                launch = _prepare(data, data['planner'], 'plan')
        else:
            active = [s for s in data['steps'] if s['state'] in ('starting', 'running')]
            if all(s['state'] in ('complete', 'skipped') for s in data['steps']):
                if data['interval_seconds'] and data['cycle'] < data['max_cycles']:
                    data['next_cycle'] = data.get('next_cycle') or _now() + data['interval_seconds']
                    changed = True
                    if _now() >= data['next_cycle'] and data.get('cycle_source') and any(s.get('proposed') for s in data['steps']):
                        head = companions._git(config.CODE, 'rev-parse', 'HEAD', limit=100).decode().strip()
                        changed = head != data['cycle_source']
                        if not changed:
                            data['reason'] = 'source_unchanged'
                    if _now() >= data['next_cycle'] and changed:
                        data.update(cycle=data['cycle'] + 1, next_cycle=None, cycle_source=None, reason='')
                        for step in data['steps']:
                            _reset(step)
                else:
                    _bank(data)
                    data.update(phase='completed', reason='completed')
            if data['phase'] == 'active' and len(active) < data['concurrent'] and len(active) + other_slots < 2 and not data.get('next_cycle'):
                ready = next((s for s in data['steps'] if s['state'] == 'pending' and all(
                    any(d['id'] == dep and d['state'] in ('complete', 'skipped') for d in data['steps']) for dep in s['after'])), None)
                if ready:
                    if _runs(data) >= data['max_runs']:
                        _bank(data)
                        data.update(phase='budget', reason='runs')
                    elif not _stop.is_set():
                        launch = _prepare(data, ready, 'experiment')
        if data['phase'] in ('active', 'planning'):
            _track_work(data)
        else:
            stops = [s['session'] for s in data['steps'] + ([data['planner']] if data.get('planner') else [])
                     if s.get('session') and s['state'] == 'running']
            for step in data['steps'] + ([data['planner']] if data.get('planner') else []):
                if step['state'] == 'running':
                    step['state'] = 'interrupted'
            notification = copy.deepcopy(data)
    for sid in stops:
        service.stop(sid)
    if notification:
        _notify(notification)
    if launch:
        try:
            if _stop.is_set():
                raise _Aborted()
            @contextlib.contextmanager
            def guard():
                with _edit(ident) as live:
                    if _stop.is_set() or live['phase'] not in ('active', 'planning') or _elapsed(live) >= live['max_seconds']:
                        raise _Aborted()
                    yield
            result = companions.run(launch['role'], launch['path'], launch['mission'], purpose=launch['purpose'],
                                    launch_key=launch['key'], timeout_s=launch['timeout_s'], launch_guard=guard)
            keep = False
            with _edit(ident) as data:
                step = next((s for s in data['steps'] + ([data['planner']] if data.get('planner') else []) if s.get('key') == launch['key']), None)
                if step:
                    step['session'] = result['id']
                    if launch['purpose'] == 'experiment' and not data.get('cycle_source'):
                        data['cycle_source'] = ((store.read_cached(result['id']) or {}).get('companion') or {}).get('base')
                    next(l for l in data['launches'] if l['key'] == launch['key'])['session'] = result['id']
                    keep = data['phase'] in ('active', 'planning') and not _stop.is_set()
                    step['state'] = 'running' if keep else 'interrupted'
            if not keep:
                service.stop(result['id'])
        except Exception as error:
            aborted = isinstance(error, _Aborted)
            with _edit(ident) as data:
                step = next((s for s in data['steps'] + ([data['planner']] if data.get('planner') else []) if s.get('key') == launch['key']), None)
                if step and aborted:
                    _release(data, step)  # nothing reached a model: pending again, run not counted
                elif step:
                    step.update(state='failed', error='launch_failed')
                if not aborted and data['phase'] in ('active', 'planning'):
                    _bank(data)
                    data.update(phase='paused', reason='step_failed')
                if data['phase'] in ('active', 'planning'):
                    _track_work(data)
            if not aborted:
                _notify(data)


def tick():
    with (_dir() / 'worker.lock').open('a') as leader:
        try:
            fcntl.flock(leader, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        for data in _listing():
            if _stop.is_set():
                break
            try:
                advance(data['id'])
            except Exception:  # one mission's failure must not stop the limits and progress of the others
                logging.getLogger(__name__).exception('Resident mission %s advance failed', data['id'])


async def startup():
    global _task
    _stop.clear()
    if os.environ.get('MAXXING_MISSIONS_WORKER') == '0' or _task and not _task.done():
        return
    async def worker():
        while not _stop.is_set():
            try:
                await asyncio.to_thread(tick)
            except Exception:
                logging.getLogger(__name__).exception('Resident mission advance failed')
            for _ in range(20):
                if _stop.is_set():
                    break
                await asyncio.sleep(.1)
    _task = asyncio.create_task(worker())


async def shutdown():
    global _task
    _stop.set()
    if _task:
        await _task
        _task = None
