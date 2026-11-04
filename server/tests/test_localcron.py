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


def test_reboot_jobs_run_once_when_the_application_starts(mx, monkeypatch):
    boot = crons.create_job({'name': 'At startup', 'schedule': '@reboot', 'command': 'true'})
    off = crons.create_job({'name': 'Off', 'schedule': '@reboot', 'command': 'true', 'enabled': False})
    minute = crons.create_job({'name': 'Minute', 'schedule': '* * * * *', 'command': 'true'})
    started = []
    monkeypatch.setattr(crons, 'spawn_run', lambda cid: started.append(cid))
    assert localcron.boot() == [boot['id']] and started == [boot['id']]
    assert localcron.tick(1_700_000_000) == [minute['id']]          # the minute loop never starts it again
    assert off['id'] not in started

    def busy(cid):
        raise crons.CronError('this job is already running', 'already_running')
    monkeypatch.setattr(crons, 'spawn_run', busy)
    assert localcron.boot() == []                                   # still running from before: left alone
    config.save_config({**config.load_config(), 'integrations_paused': True})
    monkeypatch.setattr(crons, 'spawn_run', lambda cid: started.append(cid))
    assert localcron.boot() == [] and started == [boot['id'], minute['id']]


def test_local_mode_startup_runs_reboot_jobs(mx, monkeypatch):
    from fastapi.testclient import TestClient
    from maxxing.app import create_app
    job = crons.create_job({'name': 'At startup', 'schedule': '@reboot', 'command': 'true'})
    started = []
    monkeypatch.setattr(crons, 'spawn_run', lambda cid: started.append(cid))
    monkeypatch.setattr(localcron, 'tick', lambda now=None: [])
    monkeypatch.setenv('HARNESS_PILOT_LOCAL_MODE', '1')
    with TestClient(create_app()):
        wait_for(lambda: started, timeout=10)
    assert started == [job['id']]
