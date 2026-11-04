"""Minute scheduler for the local, unprivileged development instance.

It does not install or alter the user's crontab. Only the current minute is considered: the
application must be running and missed jobs are not replayed after sleep or a shutdown.
"""
from __future__ import annotations

import logging
import time

from . import config, crons

log = logging.getLogger(__name__)
_lock = config.ProcessLock('local-cron')


def tick(now: float | None = None) -> list[str]:
    if config.integrations_paused():                    # a restored copy: nothing runs until its owner resumes it
        return []
    now = time.time() if now is None else now
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
