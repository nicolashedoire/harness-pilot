"""Local scheduling must not touch the real crontab or repeat an already claimed minute."""
from maxxing import config, crons, localcron
from conftest import wait_for
import shlex


def test_local_scheduler_runs_due_jobs_once_without_replaying_missed_minutes(mx, monkeypatch):
    job = crons.create_job({'name': 'Every minute', 'schedule': '* * * * *', 'command': 'true'})
    disabled = crons.create_job({'name': 'Disabled', 'schedule': '* * * * *', 'command': 'true', 'enabled': False})
    reboot = crons.create_job({'name': 'Reboot', 'schedule': '@reboot', 'command': 'true'})
    started = []
    monkeypatch.setattr(crons, 'spawn_run', lambda cid: started.append(cid))
    assert localcron.tick(1_700_000_000) == [job['id']]
    assert localcron.tick(1_700_000_005) == []
    # Jumping ahead does not replay the minutes during which the app was stopped.
    assert localcron.tick(1_700_000_180) == [job['id']]
    assert started == [job['id'], job['id']]
    assert disabled['id'] not in started and reboot['id'] not in started
    assert (config.STATE / 'local-cron-minutes.json').is_file()


def test_local_scheduler_launches_and_records_a_real_isolated_job(mx):
    marker = mx['tmp'] / 'local-scheduler-result'
    job = crons.create_job({'name': 'Local test', 'schedule': '* * * * *',
                            'command': f'printf scheduled > {shlex.quote(str(marker))}', 'notify': 'never'})
    assert localcron.tick() == [job['id']]
    wait_for(lambda: marker.exists(), timeout=15)
    assert marker.read_text() == 'scheduled'
    run = wait_for(lambda: next((r for r in crons.read_runs() if r.get('cron_id') == job['id']), None), timeout=15)
    assert run['ok'] is True


def _catch_up_env(monkeypatch):
    from maxxing import feed
    monkeypatch.setitem(localcron._alive, 'minute', None)        # the heartbeat is written once per minute in memory
    started = []
    monkeypatch.setattr(crons, 'spawn_run', lambda cid: started.append(cid))
    return started, lambda: feed.list_events(kind='cron.caught_up')['events']


def test_catch_up_runs_once_after_runs_were_missed_while_stopped(mx, monkeypatch):
    import datetime as dt
    started, events = _catch_up_env(monkeypatch)
    t0 = dt.datetime(2026, 3, 2, 9, 30, 20, tzinfo=dt.timezone.utc).timestamp()   # a Monday, config zone UTC
    hourly = crons.create_job({'name': 'Hourly', 'schedule': '0 * * * *', 'command': 'true', 'catch_up': True})
    plain = crons.create_job({'name': 'No catch-up', 'schedule': '0 * * * *', 'command': 'true'})
    yearly = crons.create_job({'name': 'Yearly', 'schedule': '0 0 1 1 *', 'command': 'true', 'catch_up': True})
    boot = crons.create_job({'name': 'Boot', 'schedule': '@reboot', 'command': 'true', 'catch_up': True})
    for j in (hourly, plain, yearly, boot):                       # made before the app last ran
        crons.update_job(j['id'], {})
    jobs = config.read_json(crons.jobs_path(), {})
    for j in jobs['jobs']:
        j['created'] = j['updated'] = t0 - 86400
    config.write_json(crons.jobs_path(), jobs)
    assert localcron.catch_up(t0) == [] and started == []         # first start: no heartbeat, nothing to judge
    assert localcron.tick(t0) == []                               # alive at 09:30
    # stopped from 09:30 to 12:15: 10:00, 11:00 and 12:00 were missed -> one run, one notification
    later = t0 + 2 * 3600 + 45 * 60
    assert localcron.catch_up(later) == [hourly['id']] and started == [hourly['id']]
    (ev,) = events()
    assert ev['source'] == 'crons' and ev['level'] == 'info' and ev['url'] == f"/crons?job={hourly['id']}"
    assert ev['params']['missed'] == 3 and ev['params']['name'] == 'Hourly'
    assert ev['params']['since'] == dt.datetime(2026, 3, 2, 10, 0, tzinfo=dt.timezone.utc).timestamp()
    # restarted right away (or crashed after starting it): the heartbeat moved, nothing again
    assert localcron.catch_up(later + 30) == [] and started == [hourly['id']] and len(events()) == 1


def test_catch_up_skips_what_the_tick_runs_paused_time_and_new_jobs(mx, monkeypatch):
    import datetime as dt
    started, events = _catch_up_env(monkeypatch)
    t0 = dt.datetime(2026, 3, 2, 9, 30, 20, tzinfo=dt.timezone.utc).timestamp()   # 09:30:20 UTC
    every = crons.create_job({'name': 'Every 5', 'schedule': '*/5 * * * *', 'command': 'true', 'catch_up': True})
    jobs = config.read_json(crons.jobs_path(), {})
    jobs['jobs'][0]['created'] = jobs['jobs'][0]['updated'] = t0 - 3600
    config.write_json(crons.jobs_path(), jobs)
    assert localcron.tick(t0) == [every['id']]                    # on time at 09:30
    started.clear()
    # 09:50:20, due this very minute: the minute tick runs it, no extra catch-up run
    assert localcron.catch_up(t0 + 20 * 60) == [] and events() == []
    # paused (a restored copy) from 10:02 to 10:04: the heartbeat still moves, those minutes are never caught up
    config.save_config({**config.load_config(), 'integrations_paused': True})
    assert localcron.catch_up(t0 + 32 * 60) == []
    assert localcron.tick(t0 + 33 * 60) == []
    config.save_config({**config.load_config(), 'integrations_paused': False})
    assert localcron.catch_up(t0 + 34 * 60) == [] and started == []
    assert localcron.tick(t0 + 35 * 60) == [every['id']]          # 10:05:20, on time
    started.clear()
    # changed at 10:16:20 while the app was stopped: 10:10 and 10:15 came before the change
    jobs = config.read_json(crons.jobs_path(), {})
    jobs['jobs'][0]['updated'] = t0 + 46 * 60
    config.write_json(crons.jobs_path(), jobs)
    assert localcron.catch_up(t0 + 49 * 60) == []                 # 10:19:20
    # stopped from 10:19 to 10:31: 10:20, 10:25 and 10:30 were missed
    assert localcron.catch_up(t0 + 61 * 60) == [every['id']] and started == [every['id']]
    assert [e['params']['missed'] for e in events()] == [3]


def test_catch_up_is_off_by_default_and_saved(client):
    j = client.post('/api/crons', json={'name': 'x', 'schedule': '0 7 * * *', 'command': 'true'}).json()
    assert j['catch_up'] is False
    assert client.patch(f"/api/crons/{j['id']}", json={'catch_up': True}).json()['catch_up'] is True
