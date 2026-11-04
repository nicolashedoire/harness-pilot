"""Minute scheduler for the local, unprivileged development instance.

It does not install or alter the user's crontab. Only the current minute is considered: the
application must be running and missed jobs are not replayed after sleep or a shutdown, except for the jobs with
`catch_up`: at startup (`catch_up()`), one run of each when its schedule fired at least once since the scheduler's
last heartbeat (`<state>/local-cron-alive.json`, written by every tick once per minute, paused or not).
"""
from __future__ import annotations

import logging
import math
import time

from . import config, crons

log = logging.getLogger(__name__)
_lock = config.ProcessLock('local-cron')
MISSED_MAX = 1000                                      # missed runs counted for the notification, at most
_alive: dict = {'minute': None}


def _alive_path():
    return config.STATE / 'local-cron-alive.json'


def _note_alive(now: float) -> None:
    """The scheduler looked at this minute (ran its jobs or deliberately skipped them): once per minute."""
    minute = int(now // 60)
    if _alive['minute'] != minute:
        config.write_json(_alive_path(), {'at': now}, mode=0o600)
        _alive['minute'] = minute


def _stamp(v) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else 0.0


def catch_up(now: float | None = None) -> list[str]:
    """At startup: one run of every enabled `catch_up` job whose schedule fired while the application was stopped
    (after the last heartbeat, and after the job was created or last changed), with a `cron.caught_up` notification.
    The heartbeat is moved to `now` before anything starts: a crash right after never runs them twice. Nothing on
    the first start (no heartbeat yet), for `@reboot`, or for a job due this very minute (the tick runs it)."""
    from . import feed
    now = time.time() if now is None else now
    minute_start = int(now // 60) * 60
    with _lock:
        last = config.read_json(_alive_path(), {})
        last = _stamp(last.get('at')) if isinstance(last, dict) else 0.0
        _note_alive(now)
        if not last or last >= now or config.integrations_paused():
            return []
        due: list[tuple[dict, int, float]] = []
        for job in crons.list_jobs():
            cid, schedule = job.get('id'), job.get('schedule')
            if not cid or not job.get('enabled') or not job.get('catch_up') or not schedule:
                continue
            try:
                expr = crons.parse(schedule)
                if expr.reboot or crons.is_due(schedule, now):
                    continue
                since = max(last, _stamp(job.get('created')), _stamp(job.get('updated')))
                missed, first = 0, 0.0
                for ts in crons.iter_runs(expr, since):
                    if ts >= minute_start or missed >= MISSED_MAX:
                        break
                    missed, first = missed + 1, first or ts
            except (ValueError, crons.CronError):
                continue
            if missed:
                due.append((job, missed, first))
    started = []
    for job, missed, first in due:
        cid = job['id']
        try:
            crons.spawn_run(cid)
        except crons.CronError as e:
            if e.code != 'already_running':
                log.exception('Could not catch up the local job %s', cid)
            continue
        except (OSError, ValueError):
            log.exception('Could not catch up the local job %s', cid)
            continue
        started.append(cid)
        feed.system(f"Missed run caught up: {job['name']}",
                    f"{missed} scheduled run{'s' if missed > 1 else ''} missed while harness-pilot was stopped: "
                    "ran once now.", "info", "crons", f"/crons?job={cid}", kind="cron.caught_up",
                    params={'cron_id': cid, 'name': job['name'], 'missed': missed, 'since': first})
    return started


def tick(now: float | None = None) -> list[str]:
    now = time.time() if now is None else now
    try:
        _note_alive(now)                                 # also while paused: those minutes are not to catch up
    except OSError:
        log.exception('Could not record the local scheduler heartbeat')
    if config.integrations_paused():                    # a restored copy: nothing runs until its owner resumes it
        return []
    minute = int(now // 60)
    due = []
    # Claim a particular minute before launching so restarts and concurrent instances do not
    # start the same job twice. If the process dies after claiming, that run is not replayed.
    with _lock:
        path = config.STATE / 'local-cron-minutes.json'
        saved = config.read_json(path, {})
        saved = saved if isinstance(saved, dict) else {}
        for job in crons.list_jobs():
            cid, schedule = job.get('id'), job.get('schedule')
            if not cid or not job.get('enabled') or not schedule or saved.get(cid) == minute:
                continue
            try:
                expr = crons.parse(schedule)
                if expr.reboot or not crons.is_due(schedule, now):
                    continue
            except (ValueError, crons.CronError):
                continue
            saved[cid] = minute
            due.append(cid)
        if due:
            config.write_json(path, saved, mode=0o600)
    started = []
    for cid in due:
        try:
            job = crons._raw_job(cid)
            if job and job.get('enabled'):
                crons.spawn_run(cid)
                started.append(cid)
        except (OSError, ValueError, crons.CronError):
            log.exception('Could not start scheduled local job %s', cid)
    return started
