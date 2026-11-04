from __future__ import annotations

import json
import concurrent.futures
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import zipfile

import pytest

from maxxing import config, instance_backup as snapshots, security, workspace
from maxxing.sessions import service, store

PASSWORD = 'test backup phrase 2026'


def seed(mx):
    if not security.password_is_set():
        security.set_password('correct horse battery')
    workspace.create_project('acme')
    topic = workspace.create_topic('acme', 'blog')['path']
    note = mx['ws'] / topic / 'memory.md'
    note.write_text('Remember the recovered project.\n')
    attachment = mx['files'] / 'attachment.bin'
    attachment.write_bytes(b'\x00\xffattachment data')
    sid = service.create_session(topic, title='A saved conversation')['id']
    store.append_log(sid, {'type': 'assistant', 'message': {'content': [
        {'type': 'text', 'text': 'The saved answer.'}]}, 'attachments': [str(attachment)]})
    from maxxing.api import space_labels
    space_labels.set_label(space_labels.LabelIn(path=str(attachment), label='personal'))
    return sid, note, attachment


def round_trip(mx):
    exported = snapshots.export(PASSWORD)
    original = snapshots.exported(exported['id'])
    preview = snapshots.inspect(original, PASSWORD)
    restored = snapshots.restore(preview['id'], preview['sha256'])
    return exported, preview, restored


def test_full_snapshot_preserves_data_credentials_labels_and_separate_destination(mx):
    sid, note, attachment = seed(mx)
    before_secrets = (mx['state'] / 'secrets.json').read_bytes()
    _, preview, restored = round_trip(mx)
    destination = Path(restored['destination'])
    assert destination != mx['state'] and destination.exists()
    assert (destination / 'workspace' / note.relative_to(mx['ws'])).read_text() == note.read_text()
    assert (destination / 'files/attachment.bin').read_bytes() == attachment.read_bytes()
    assert (destination / 'files/attachment.bin').stat().st_mtime_ns == attachment.stat().st_mtime_ns
    assert (destination / 'state/secrets.json').read_bytes() == before_secrets
    assert 'The saved answer.' in (destination / f'state/sessions/{sid}.log').read_text()
    cfg = json.loads((destination / 'state/config.json').read_text())
    assert cfg['workspace'] == str(destination / 'workspace')
    assert cfg['files_root'] == str(destination / 'files')
    assert cfg['restore_hold'] is True and cfg['bind'] == '127.0.0.1'
    assert cfg['integrations_paused'] is True and restored['integrations_paused'] is True
    labels = json.loads((destination / 'state/space-labels/labels.json').read_text())
    identity = (destination / 'files/attachment.bin').stat()
    assert labels[str(destination / 'files/attachment.bin')] == {
        'label': 'personal', 'identity': [identity.st_dev, identity.st_ino]}
    assert preview['files'] >= 5
    assert not (mx['state'] / 'instance-backups/imports' / preview['id'] / 'snapshot.zip').exists()
    assert note.read_text() == 'Remember the recovered project.\n'


def test_wrong_password_and_modified_ciphertext_are_not_admitted(mx):
    seed(mx)
    result = snapshots.export(PASSWORD)
    path = snapshots.exported(result['id'])
    assert b'The saved answer.' not in path.read_bytes()
    with pytest.raises(snapshots.SnapshotError, match='incorrect or'):
        snapshots.inspect(path, 'a different backup phrase')
    data = bytearray(path.read_bytes())
    data[-1] ^= 1
    path.write_bytes(data)
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.inspect(path, PASSWORD)
    assert caught.value.code == 'decrypt_failed'
    assert list((mx['state'] / 'instance-backups/imports').iterdir()) == []


def test_changes_after_preview_require_another_review(mx):
    seed(mx)
    result = snapshots.export(PASSWORD)
    preview = snapshots.inspect(snapshots.exported(result['id']), PASSWORD)
    path = mx['state'] / 'instance-backups/imports' / preview['id'] / 'snapshot.zip'
    with path.open('ab') as stream:
        stream.write(b'changed after review')
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.restore(preview['id'], preview['sha256'])
    assert caught.value.code == 'changed'
    assert not list(mx['tmp'].glob('pilot-restored-*'))


def test_snapshot_refuses_source_changes_and_active_sessions(mx, monkeypatch):
    sid, note, _ = seed(mx)
    with store.edit(sid) as meta:
        meta['state'] = 'running'
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.export(PASSWORD)
    assert caught.value.code == 'sessions_active'
    with store.edit(sid) as meta:
        meta['state'] = 'idle'
    original = snapshots._inventory
    calls = 0

    def changing(roots):
        nonlocal calls
        inventory = original(roots)
        calls += 1
        if calls == 1:
            note.write_text('Mutated during backup.\n')
        return inventory

    monkeypatch.setattr(snapshots, '_inventory', changing)
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.export(PASSWORD)
    assert caught.value.code == 'source_changed'
    assert not list((mx['state'] / 'instance-backups/exports').glob('*.pilotbackup'))


def test_internal_links_are_relocated_and_external_targets_are_not_read(mx):
    seed(mx)
    (mx['ws'] / 'attachment-link').symlink_to(mx['files'] / 'attachment.bin')
    external = mx['tmp'] / 'outside-secret'
    external.write_text('Do not include this target.')
    (mx['ws'] / 'external-link').symlink_to(external)
    _, preview, restored = round_trip(mx)
    destination = Path(restored['destination'])
    assert (destination / 'workspace/attachment-link').read_bytes() == b'\x00\xffattachment data'
    assert preview['external_links'] == ['workspace/external-link']
    assert not (destination / 'workspace/external-link').exists()


@pytest.mark.parametrize('name', ['workspace/../../escape', '/absolute/escape', 'workspace/./hidden', 'workspace\\escape'])
def test_archive_paths_cannot_escape_the_restore(mx, name):
    seed(mx)
    plain, encrypted = mx['tmp'] / 'invalid.zip', mx['tmp'] / 'invalid.pilotbackup'
    manifest = {'format': 'pilot-instance', 'schema': 1, 'version': 'test', 'created': 1,
                'roots': snapshots._roots(), 'entries': [{'path': name, 'kind': 'directory', 'mode': 448}]}
    with zipfile.ZipFile(plain, 'w') as bundle:
        bundle.writestr('manifest.json', json.dumps(manifest))
    snapshots._crypt(plain, encrypted, PASSWORD)
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.inspect(encrypted, PASSWORD)
    assert caught.value.code == 'unsafe_path'
    assert not list(mx['tmp'].glob('pilot-restored-*'))


def test_recovered_app_can_authenticate_read_history_and_hold_services(mx):
    sid, _, attachment = seed(mx)
    extension = mx['ws'] / 'extensions/recovered-plugin'
    extension.mkdir(parents=True)
    (extension / 'manifest.json').write_text(json.dumps({'id': 'recovered-plugin', 'type': 'widget'}))
    (extension / 'api.py').write_text("from pathlib import Path\nPath(__file__).with_name('imported').touch()\ndef card(ctx): return {'blocks': []}\n")
    _, _, restored = round_trip(mx)
    script = '''
from fastapi.testclient import TestClient
from maxxing.app import create_app
from maxxing import config
import json,sys
with TestClient(create_app()) as c:
    c.headers['X-Maxxing']='1'
    assert c.post('/api/auth/login',json={'password':'correct horse battery'}).status_code==200
    assert c.get('/api/sessions/'+sys.argv[1]).json()['title']=='A saved conversation'
    assert c.get('/api/files/raw',params={'path':sys.argv[2]}).content==b'\\x00\\xffattachment data'
    roots = c.get('/api/settings').json()['restored_file_roots']
    assert str(__import__('pathlib').Path(sys.argv[2]).parent) in roots
    assert str(config.STATE) not in roots
    assert c.post('/api/sessions',json={}).status_code==409
    assert c.get('/api/backup/instance').json()['restore_hold'] is True
    plugin = __import__('pathlib').Path(config.load_config()['workspace'])/'extensions/recovered-plugin'
    assert c.get('/api/extensions').status_code==200
    assert not (plugin/'imported').exists(), 'Listing recovered plugins must not execute them'
    assert c.post('/api/backup/instance/activate').status_code==200
    assert (plugin/'imported').exists(), 'Explicit activation loads deferred plugins'
    assert c.get('/api/backup/instance').json()['restore_hold'] is False
    assert c.post('/api/workspace/projects',json={'name':'after-restore'}).status_code==200
    print('Recovered authentication, history, attachment and service hold verified.')
'''
    environment = {**os.environ, 'MAXXING_STATE': restored['state'],
                   'PYTHONPATH': str(Path(__file__).resolve().parents[1])}
    process = subprocess.run([sys.executable, '-c', script, sid, str(attachment)], env=environment,
                             text=True, capture_output=True, timeout=30)
    assert process.returncode == 0, process.stdout + process.stderr
    assert 'service hold verified' in process.stdout


def test_authenticated_export_preview_restore_routes(client, mx):
    seed(mx)
    exported = client.post('/api/backup/instance/export', json={'passphrase': PASSWORD})
    assert exported.status_code == 200, exported.text
    result = exported.json()
    download = client.get('/api/backup/instance/download/' + result['id'])
    assert download.content.startswith(snapshots.MAGIC)
    preview = client.post('/api/backup/instance/preview', files={'file': ('test.pilotbackup', download.content)},
                          data={'passphrase': PASSWORD})
    assert preview.status_code == 200, preview.text
    plan = preview.json()
    response = client.post('/api/backup/instance/restore', json={'id': plan['id'], 'sha256': plan['sha256']})
    assert response.status_code == 200, response.text
    assert response.json()['background_services_paused'] is True
    client.cookies.clear()
    assert client.get('/api/backup/instance/download/' + result['id']).status_code == 401


def test_snapshot_mutation_gate_releases_after_export_failure(client, mx, monkeypatch):
    seed(mx)
    entered, release = threading.Event(), threading.Event()

    def failed_export(password):
        entered.set()
        assert release.wait(10)
        raise snapshots.SnapshotError('source_changed', 'Changed externally.', 409)

    monkeypatch.setattr(snapshots, 'export', failed_export)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        pending = pool.submit(client.post, '/api/backup/instance/export', json={'passphrase': PASSWORD})
        try:
            assert entered.wait(10)
            assert client.post('/api/workspace/projects', json={'name': 'blocked'}).json()['error'] == 'snapshot_busy'
            assert client.get('/api/auth/state').status_code == 200
        finally:
            release.set()
        assert pending.result(timeout=15).status_code == 409
    assert client.post('/api/workspace/projects', json={'name': 'available-again'}).status_code == 200


def test_excluded_runtime_symlinks_are_reported_and_expired_previews_cannot_restore(mx):
    seed(mx)
    runtime = mx['state'] / 'tools/provider'
    runtime.mkdir(parents=True)
    (runtime / 'binary').write_text('external runtime')
    (mx['ws'] / 'provider-link').symlink_to(runtime)
    exported = snapshots.export(PASSWORD)
    preview = snapshots.inspect(snapshots.exported(exported['id']), PASSWORD)
    assert 'workspace/provider-link' in preview['external_links']
    staging = snapshots._base() / 'imports' / preview['id']
    os.utime(staging, (1, 1))
    with pytest.raises(snapshots.SnapshotError, match='expired'):
        snapshots.restore(preview['id'], preview['sha256'])
    assert not staging.exists()


def test_restored_copy_gets_its_own_crontab_and_interrupted_exports_leave_no_plaintext(mx):
    seed(mx)
    # A server stopped in the middle of an export leaves its plaintext staging behind: the next operation removes it.
    leftover = snapshots._base() / 'export-interrupted'
    leftover.mkdir()
    (leftover / 'snapshot.zip').write_bytes(b'plaintext credentials')
    _, preview, restored = round_trip(mx)
    assert not leftover.exists()
    destination = Path(restored['destination'])
    assert f"MAXXING_CRONTAB_FILE={destination / 'crontab'}" in restored['launch_command']
    # An expired preview (decrypted data) is cleared as soon as the Backup page asks for the status.
    preview = snapshots.inspect(snapshots.exported(snapshots.export(PASSWORD)['id']), PASSWORD)
    staging = snapshots._base() / 'imports' / preview['id']
    os.utime(staging, (1, 1))
    snapshots.status()
    assert not staging.exists()


def test_restored_integrations_stay_paused_after_activation_until_resumed(mx, monkeypatch):
    """Activating a restored copy must not make it a second live instance: Telegram, scheduled jobs and the GitHub
    memory backup stay off until the owner resumes them, then each one really works again."""
    import argparse
    import subprocess as sp
    from fastapi.testclient import TestClient
    from _conn_helpers import GH_TOKEN, TG_TOKEN, FakeGitHub, FakeTelegram
    from conftest import wait_for
    from maxxing import backup, cmd_cron, companions, crons, localcron, missions
    from maxxing.app import create_app
    from maxxing.telegram import gateway

    telegram, github = FakeTelegram(), FakeGitHub(mx['tmp'] / 'remotes')
    monkeypatch.setenv('MAXXING_TELEGRAM_API', telegram.url)
    monkeypatch.setenv('MAXXING_TELEGRAM_POLL', '1')
    monkeypatch.setenv('MAXXING_GITHUB_API', github.url)
    monkeypatch.setenv('MAXXING_GITHUB_GIT', f"file://{mx['tmp'] / 'remotes'}")
    bare = github.add_repo('alice/memory')
    (mx['ws'] / 'memory.md').write_text('- restored fact\n')
    security.set_password('correct horse battery')
    # The state a restore leaves behind, with a linked bot, a job and a configured memory backup.
    config.update_config(restore_hold=True, integrations_paused=True, telegram={'chat_id': 555, 'user_ids': [555]})
    config.set_secret('telegram_token', TG_TOKEN)
    job = crons.create_job({'name': 'Every minute', 'schedule': '* * * * *', 'command': 'true', 'notify': 'never'})
    assert backup.configure('alice/memory', GH_TOKEN)['ok']
    # A resident mission that was running in the original installation (#47's moved-state check pauses it).
    workspace.create_project('acme')
    topic = workspace.create_topic('acme', 'blog')['path']
    mission = missions.create('Improve the platform', topic, 'Inspect and test one improvement.',
                              [{'id': 'step-1', 'title': 'Review', 'role': 'observer', 'instruction': 'Inspect.', 'after': []}])['id']
    missions.control(mission, 'start', missions.get(mission)['plan_fingerprint'])
    with missions._edit(mission) as data:
        data['origin_state'] = '/original/state'
    monkeypatch.setattr(companions, 'run', lambda *a, **k: pytest.fail('a restored mission launched an agent'))
    started = []
    monkeypatch.setattr(crons, 'spawn_run', started.append)
    commits = lambda: int(sp.run(['git', '--git-dir', str(bare), 'rev-list', '--count', 'main'], capture_output=True,
                                 text=True).stdout.strip() or 0)
    scheduled = argparse.Namespace(cron_cmd='run', id=job['id'], if_due=True, detach=False)
    try:
        with TestClient(create_app()) as c:
            c.cookies.set(security.COOKIE, security.make_cookie())
            c.headers['X-Maxxing'] = '1'
            assert c.post('/api/backup/instance/resume-integrations').json()['error'] == 'restore_hold'
            assert c.post('/api/backup/instance/activate').status_code == 200
            assert c.get('/api/backup/instance').json()['integrations_paused'] is True
            # Telegram: no poller and no notification from this copy.
            assert gateway.gateway() is None and not gateway.status()['running']
            gateway.system_alert('A restored copy must stay silent.')
            # Scheduled jobs: no crontab line, no local tick, a leftover crontab line exits without running.
            assert 'cron run' not in crons.read_crontab()
            assert localcron.tick() == [] and started == []
            monkeypatch.setattr(crons, 'run_job', lambda cid: pytest.fail('a paused scheduled job ran'))
            assert cmd_cron._handler(scheduled) == 0
            # GitHub memory backup: refused before any push.
            refused = c.post('/api/backup/run')
            assert refused.status_code == 409 and refused.json()['error'] == 'paused'
            assert commits() == 0 and backup.history() == []
            assert telegram.calls == [] and gateway.status()['last_poll_ok'] is None
            missions.tick()                              # the worker's pass after activation (off in tests)
            assert missions.get(mission)['phase'] == 'paused' and missions.get(mission)['reason'] == 'restored'

            resumed = c.post('/api/backup/instance/resume-integrations')
            assert resumed.status_code == 200, resumed.text
            assert resumed.json()['telegram'] is True and resumed.json()['scheduled_jobs'] == 2
            assert c.get('/api/backup/instance').json()['integrations_paused'] is False
            wait_for(lambda: gateway.status()['last_poll_ok'])     # the bot is polled again
            assert gateway.status()['running'] and telegram.calls
            assert f"cron run {job['id']}" in crons.read_crontab()
            assert job['id'] in localcron.tick()
            pushed = c.post('/api/backup/run')
            assert pushed.status_code == 200 and pushed.json()['ok'] is True, pushed.text
            assert commits() == 1
            missions.tick()                              # resuming integrations never restarts a mission
            assert missions.get(mission)['phase'] == 'paused'
    finally:
        telegram.close()
        github.close()


def _rewrite_header(path, **changes):
    data = bytearray(path.read_bytes())
    fields = dict(zip(('magic', 'version', 'kdf', 'log_n', 'r', 'p', 'salt', 'nonce'),
                      snapshots._HEADER.unpack_from(data)))
    fields.update(changes)
    data[:snapshots._HEADER.size] = snapshots._HEADER.pack(*fields.values())
    path.write_bytes(data)


def test_archive_header_records_versioned_scrypt_parameters(mx, monkeypatch):
    seed(mx)
    path = snapshots.exported(snapshots.export(PASSWORD)['id'])
    magic, version, kdf, log_n, r, p, salt, nonce = snapshots._HEADER.unpack_from(path.read_bytes())
    assert (magic, version, kdf, (log_n, r, p)) == (b'PILOTBK\n', 2, snapshots.KDF_SCRYPT, (15, 8, 1))
    assert len(salt) == 16 and len(nonce) == 12
    # Decryption reads the cost from the header: an archive made with other in-bounds settings still opens.
    monkeypatch.setattr(snapshots, 'SCRYPT_DEFAULT', (14, 4, 2))
    other = snapshots.exported(snapshots.export(PASSWORD)['id'])
    monkeypatch.setattr(snapshots, 'SCRYPT_DEFAULT', (15, 8, 1))
    assert snapshots._HEADER.unpack_from(other.read_bytes())[3:6] == (14, 4, 2)
    assert snapshots.inspect(other, PASSWORD)['files'] >= 5


@pytest.mark.parametrize('changes, code', [
    ({'nonce': b'\x00' * 12}, 'decrypt_failed'),       # authenticated header fields
    ({'salt': b'\x01' * 16}, 'decrypt_failed'),
    ({'r': 9}, 'decrypt_failed'),                       # in bounds, but not the cost the key was made with
    ({'version': 1}, 'format'),
    ({'version': 3}, 'format'),
    ({'kdf': 2}, 'format'),
    ({'magic': b'PILOTBK1'}, 'format'),
])
def test_tampered_archive_header_is_refused(mx, changes, code):
    seed(mx)
    path = snapshots.exported(snapshots.export(PASSWORD)['id'])
    _rewrite_header(path, **changes)
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.inspect(path, PASSWORD)
    assert caught.value.code == code
    assert list((mx['state'] / 'instance-backups/imports').iterdir()) == []


@pytest.mark.parametrize('cost', [
    {'log_n': 13}, {'log_n': 21}, {'log_n': 40},        # N
    {'r': 0}, {'r': 17}, {'r': 65535},                  # r
    {'p': 0}, {'p': 5}, {'p': 65535},                   # p
    {'log_n': 20, 'r': 2},                              # 256 MiB of memory
    {'log_n': 18, 'r': 4, 'p': 4},                      # N·r·p = 2^22
])
def test_out_of_bounds_kdf_parameters_are_refused_before_any_derivation(mx, monkeypatch, cost):
    seed(mx)
    path = snapshots.exported(snapshots.export(PASSWORD)['id'])
    _rewrite_header(path, **cost)
    monkeypatch.setattr(snapshots.hashlib, 'scrypt', lambda *a, **k: pytest.fail('scrypt ran on absurd settings'))
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.inspect(path, PASSWORD)
    assert caught.value.code == 'kdf_params'


def test_passphrase_is_unicode_normalized_on_export_and_import(mx):
    import unicodedata
    seed(mx)
    composed = 'Crème brûlée à côté de l’été'
    decomposed = unicodedata.normalize('NFD', composed)
    assert decomposed != composed and len(decomposed) > len(composed)
    salt = b'\x07' * 16
    assert snapshots._key(decomposed, salt, *snapshots.SCRYPT_DEFAULT) == snapshots._key(composed, salt, *snapshots.SCRYPT_DEFAULT)
    # Typed precomposed at export, as letter + combining accent (another keyboard or system) at import - and back.
    for exported_with, imported_with in ((composed, decomposed), (decomposed, composed)):
        path = snapshots.exported(snapshots.export(exported_with)['id'])
        assert snapshots.inspect(path, imported_with)['files'] >= 5


def test_exports_are_listed_and_deleted_by_id_only(client, mx):
    seed(mx)
    first = client.post('/api/backup/instance/export', json={'passphrase': PASSWORD}).json()
    second = client.post('/api/backup/instance/export', json={'passphrase': PASSWORD}).json()
    listed = client.get('/api/backup/instance/exports').json()
    assert [e['id'] for e in listed] == [second['id'], first['id']]
    assert listed[0]['archive_bytes'] == second['archive_bytes'] and listed[0]['files'] == second['files']
    exports = mx['state'] / 'instance-backups/exports'
    # A planted link and a traversal attempt are never followed: the outside file stays.
    outside = mx['tmp'] / 'outside.pilotbackup'
    outside.write_bytes(b'not ours')
    planted = 'c' * 32
    (exports / f'{planted}.pilotbackup').symlink_to(outside)
    assert planted not in [e['id'] for e in client.get('/api/backup/instance/exports').json()]
    for ident in (planted, '..', '..%2F..%2Foutside', 'A' * 32, 'f' * 31, 'f' * 32 + '.json'):
        response = client.delete('/api/backup/instance/exports/' + ident)
        assert response.status_code == 404, (ident, response.text)
    assert client.get('/api/backup/instance/download/' + planted).status_code == 404
    assert outside.read_bytes() == b'not ours' and (exports / f'{planted}.pilotbackup').is_symlink()
    deleted = client.delete('/api/backup/instance/exports/' + first['id'])
    assert deleted.status_code == 200 and deleted.json() == {'ok': True, 'id': first['id']}
    assert not (exports / f"{first['id']}.pilotbackup").exists() and not (exports / f"{first['id']}.json").exists()
    assert client.delete('/api/backup/instance/exports/' + first['id']).status_code == 404
    assert client.get('/api/backup/instance/download/' + first['id']).status_code == 404
    assert [e['id'] for e in client.get('/api/backup/instance/exports').json()] == [second['id']]
    assert client.get('/api/backup/instance/download/' + second['id']).status_code == 200
    client.cookies.clear()
    assert client.delete('/api/backup/instance/exports/' + second['id']).status_code == 401
    assert snapshots.exported(second['id']).is_file()


def test_decrypted_previews_last_one_hour_and_are_purged_at_startup_and_on_expiry(mx, monkeypatch):
    from fastapi.testclient import TestClient
    from conftest import wait_for
    from maxxing.app import create_app
    seed(mx)
    archive = snapshots.exported(snapshots.export(PASSWORD)['id'])
    imports = snapshots._base() / 'imports'
    assert snapshots.PREVIEW_TTL == 3600
    # 59 minutes old: kept, and the purge pass wakes up when it expires; 61 minutes old: removed.
    young = imports / snapshots.inspect(archive, PASSWORD)['id']
    old = imports / snapshots.inspect(archive, PASSWORD)['id']
    now = time.time()
    os.utime(young, (now - 59 * 60, now - 59 * 60))
    os.utime(old, (now - 61 * 60, now - 61 * 60))
    assert 55 <= snapshots.purge_expired() <= 60
    assert young.exists() and not old.exists()
    # At startup: an expired preview and the plaintext staging of an interrupted export are gone before any request.
    os.utime(young, (1, 1))
    leftover = snapshots._base() / 'export-interrupted'
    leftover.mkdir()
    (leftover / 'snapshot.zip').write_bytes(b'plaintext')
    monkeypatch.setattr(snapshots, 'PREVIEW_TTL', 2)
    monkeypatch.setattr(snapshots, 'PURGE_EVERY', 1)
    with TestClient(create_app()):
        wait_for(lambda: not young.exists() and not leftover.exists(), timeout=10)
        # On expiry: a new preview disappears once its time is up, with nobody opening Settings -> Backup.
        fresh = imports / snapshots.inspect(archive, PASSWORD)['id']
        assert (fresh / 'snapshot.zip').is_file()
        wait_for(lambda: not fresh.exists(), timeout=15)


def test_a_broad_files_root_is_left_out_and_the_copy_uses_its_restored_workspace(mx, monkeypatch):
    seed(mx)
    home = mx['tmp']                                  # the default install: files_root = $HOME
    monkeypatch.setenv('HOME', str(home))
    config.update_config(files_root=str(home))
    personal = home / 'Documents/tax-return.pdf'
    personal.parent.mkdir()
    personal.write_bytes(b'%PDF personal')
    (mx['state'] / 'notes.json').write_text(json.dumps({'file': str(personal)}))
    excluded = {'files': {'source': str(home.resolve()), 'reason': 'broad_root'}}
    status = snapshots.status()
    assert status['export_error'] is None
    assert status['roots']['files'] == {'source': str(home.resolve()), 'archive': None, 'excluded': 'broad_root'}
    assert status['roots']['workspace']['archive'] == 'workspace' and status['roots']['state']['archive'] == 'state'
    exported, preview, restored = round_trip(mx)
    for result in (exported, preview, restored):
        assert result['excluded_roots'] == excluded and 'files' not in result['includes']
    destination = Path(restored['destination'])
    assert not (destination / 'files').exists()
    assert not [p for p in destination.rglob('*') if p.name in ('tax-return.pdf', 'attachment.bin', 'crontab')]
    assert (destination / 'workspace/projects/acme').is_dir()
    cfg = json.loads((destination / 'state/config.json').read_text())
    assert cfg['files_root'] == str(destination / 'workspace') and cfg['workspace'] == str(destination / 'workspace')
    assert str(home.resolve()) not in [alias['source'] for alias in cfg['restored_path_aliases']]
    # A path into the original home folder stays a historical reference: never retargeted into the copy.
    assert json.loads((destination / 'state/notes.json').read_text()) == {'file': str(personal)}
    assert json.loads((destination / 'restore-report.json').read_text())['excluded_roots'] == excluded
    # An ancestor of the home folder (/home, /Users) is just as broad.
    monkeypatch.setenv('HOME', str(mx['files'] / 'someone'))
    config.update_config(files_root=str(mx['files']))
    assert snapshots._roots()['files']['archive'] is None


@pytest.mark.parametrize('name, home', [('workspace', 'ws'), ('workspace', 'ws/someone'), ('state', 'state')])
def test_a_broad_state_or_workspace_root_is_refused_clearly(mx, monkeypatch, name, home):
    seed(mx)
    monkeypatch.setenv('HOME', str(mx['tmp'] / home))
    label = {'workspace': 'workspace folder', 'state': 'application data folder'}[name]
    assert label in snapshots.status()['export_error']
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.export(PASSWORD)
    assert caught.value.code == 'broad_root' and 'dedicated folder' in str(caught.value)
    assert not list((mx['state'] / 'instance-backups').glob('exports/*.pilotbackup'))


@pytest.mark.parametrize('files_root, entry', [
    ({'source': '/', 'archive': None, 'excluded': 'broad_root'}, 'files/secret'),   # data under a root left out
    ({'source': '/', 'archive': None, 'excluded': 'other'}, None),
    ({'source': '/', 'archive': None}, None),
    ({'source': '/srv/files', 'archive': 'elsewhere'}, None),
])
def test_restore_refuses_inconsistent_excluded_roots(mx, files_root, entry):
    seed(mx)
    roots = {**snapshots._roots(), 'files': files_root}
    plain, encrypted = mx['tmp'] / 'invalid.zip', mx['tmp'] / 'invalid.pilotbackup'
    entries = [{'path': entry, 'kind': 'directory', 'mode': 448}] if entry else []
    manifest = {'format': 'pilot-instance', 'schema': 1, 'version': 'test', 'created': 1, 'roots': roots, 'entries': entries}
    with zipfile.ZipFile(plain, 'w') as bundle:
        bundle.writestr('manifest.json', json.dumps(manifest))
    snapshots._crypt(plain, encrypted, PASSWORD)
    with pytest.raises(snapshots.SnapshotError) as caught:
        snapshots.inspect(encrypted, PASSWORD)
    assert caught.value.code == 'manifest'


def test_scheduled_archives_store_a_derived_key_never_the_passphrase(mx):
    seed(mx)
    with pytest.raises(snapshots.SnapshotError) as refused:
        snapshots.set_schedule('daily', 3, 2, PASSWORD)
    assert refused.value.code == 'consent_required'
    with pytest.raises(snapshots.SnapshotError) as refused:
        snapshots.set_schedule('daily', 3, 2)
    assert refused.value.code == 'passphrase_required'
    with pytest.raises(snapshots.SnapshotError) as refused:
        snapshots.set_schedule('hourly', 3, 2, PASSWORD, True)
    assert refused.value.code == 'schedule'
    status = snapshots.set_schedule('daily', 3, 2, PASSWORD, True)
    assert status['enabled'] and status['frequency'] == 'daily' and status['next_run'] > time.time()
    for name in ('secrets.json', 'config.json'):
        assert PASSWORD.encode() not in (mx['state'] / name).read_bytes()
    assert set(config.load_secrets()[snapshots.SCHEDULE_KEY]) == {'salt', 'kdf', 'key'}
    # Changing the frequency keeps the stored key; the passphrase alone opens a scheduled archive.
    assert snapshots.set_schedule('weekly', 4, 2)['frequency'] == 'weekly'
    exported = snapshots.export_scheduled()
    assert exported['scheduled'] is True
    preview = snapshots.inspect(snapshots.exported(exported['id']), PASSWORD)
    assert preview['sha256'] and preview['files'] == exported['files']
    with pytest.raises(snapshots.SnapshotError) as refused:
        snapshots.inspect(snapshots.exported(exported['id']), 'another backup phrase')
    assert refused.value.code == 'decrypt_failed'
    off = snapshots.disable_schedule()
    assert off['enabled'] is False and off['next_run'] is None
    assert snapshots.SCHEDULE_KEY not in config.load_secrets() and snapshots.schedule_delay() is None
    assert snapshots.list_exports()[0]['id'] == exported['id']              # archives already made stay


def test_scheduled_retention_keeps_the_newest_scheduled_archives_and_every_manual_one(mx):
    seed(mx)
    snapshots.set_schedule('daily', 3, 2, PASSWORD, True)
    manual = snapshots.export(PASSWORD)['id']
    made = [snapshots.export_scheduled()['id'] for _ in range(3)]
    kept = {entry['id']: entry['scheduled'] for entry in snapshots.list_exports()}
    assert kept == {manual: False, made[1]: True, made[2]: True}
    assert not (mx['state'] / 'instance-backups' / 'exports' / f'{made[0]}.json').exists()


def test_schedule_timing_retries_and_failure_notice(mx, monkeypatch):
    from maxxing import feed
    config.update_config(timezone='UTC')
    snapshots.set_schedule('daily', 3, 7, PASSWORD, True)
    first = snapshots.schedule_status()['next_run']
    assert time.gmtime(first).tm_hour == 3 and 0 < first - time.time() <= 86400
    notices = lambda: feed.list_events(kind='instance_backup.failed')['events']
    # Blocked by activity: retried in 30 minutes, no notice yet.
    state = snapshots.record_scheduled(None, 'sessions_active', 'Finish or stop active sessions.')
    assert abs(state['retry_at'] - time.time() - snapshots.SCHEDULE_RETRY) < 5 and notices() == []
    # Still blocked six hours later: one notice for the series.
    with config._lock:
        state['failing_since'] -= snapshots.SCHEDULE_NOTIFY_AFTER
        config.write_json(mx['state'] / 'instance-backups' / 'schedule.json', state)
    snapshots.record_scheduled(None, 'sessions_active', 'Finish or stop active sessions.')
    assert len(notices()) == 1 and notices()[0]['params']['code'] == 'sessions_active'
    # Another kind of failure waits for the next day's slot and does not notify again.
    state = snapshots.record_scheduled(None, 'too_large', 'The archive exceeds the portable backup limit.')
    assert time.gmtime(state['retry_at']).tm_hour == 3 and state['retry_at'] - time.time() > 12 * 3600
    assert len(notices()) == 1
    assert snapshots.schedule_status()['error']['code'] == 'too_large'
    # A success resolves the notice and the next run is the next day's slot.
    snapshots.record_scheduled({'id': 'a' * 32})
    status = snapshots.schedule_status()
    assert status['error'] is None and status['last_id'] == 'a' * 32 and notices()[0]['resolved_at']
    assert time.gmtime(status['next_run']).tm_hour == 3 and status['next_run'] - time.time() > 12 * 3600
    # A restored copy never runs the schedule until its integrations are resumed.
    config.update_config(integrations_paused=True)
    assert snapshots.schedule_delay() is None and snapshots.schedule_status()['next_run'] is None


def test_scheduler_runs_a_due_archive_through_the_app_wrapper_and_records_the_outcome(mx, monkeypatch):
    import asyncio
    from maxxing.api import instance_backup as snapshot_api
    snapshots.set_schedule('daily', 3, 7, PASSWORD, True)
    delays = iter([-1.0, -1.0])
    monkeypatch.setattr(snapshots, 'schedule_delay', lambda: next(delays, None))
    monkeypatch.setattr(snapshots, 'SCHEDULE_POLL', 0.01)
    calls = []

    async def export(password, scheduled=False):
        calls.append((password, scheduled))
        if len(calls) == 1:
            raise snapshots.SnapshotError('crons_active', 'Wait for running scheduled tasks.', 409)
        return {'id': 'b' * 32}

    async def main():
        task = asyncio.create_task(snapshot_api.scheduler(export))
        for _ in range(500):
            if len(calls) == 2 and snapshots.schedule_status()['last_id']:
                break
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert calls == [(None, True), (None, True)]
    assert snapshots.schedule_status()['last_id'] == 'b' * 32


def test_schedule_routes(client, mx):
    seed(mx)
    assert client.get('/api/backup/instance').json()['schedule']['enabled'] is False
    refused = client.put('/api/backup/instance/schedule', json={'frequency': 'daily', 'passphrase': PASSWORD})
    assert refused.status_code == 400 and refused.json()['error'] == 'consent_required'
    saved = client.put('/api/backup/instance/schedule', json={'frequency': 'weekly', 'hour': 22, 'keep': 4,
                                                             'passphrase': PASSWORD, 'store_key': True})
    assert saved.status_code == 200, saved.text
    assert {k: saved.json()[k] for k in ('enabled', 'frequency', 'hour', 'keep')} == \
        {'enabled': True, 'frequency': 'weekly', 'hour': 22, 'keep': 4}
    assert client.get('/api/backup/instance').json()['schedule']['enabled'] is True
    assert client.delete('/api/backup/instance/schedule').json()['enabled'] is False


def test_copy_folder_rules(mx, tmp_path):
    with pytest.raises(snapshots.SnapshotError) as refused:
        snapshots.set_copy_folder('relative/folder')
    assert refused.value.code == 'copy_folder'
    with pytest.raises(snapshots.SnapshotError):
        snapshots.set_copy_folder(str(tmp_path / 'unplugged-drive'))      # never created
    assert not (tmp_path / 'unplugged-drive').exists()
    for inside in (mx['state'] / 'copies', mx['ws'] / 'copies'):          # would be archived again
        inside.mkdir()
        with pytest.raises(snapshots.SnapshotError):
            snapshots.set_copy_folder(str(inside))
    target = tmp_path / 'drive'
    target.mkdir()
    assert snapshots.set_copy_folder(str(target)) == {'folder': str(target), 'last': None}
    assert snapshots.disable_copy()['folder'] is None


def test_each_archive_is_copied_and_checked(mx, tmp_path, monkeypatch):
    from maxxing import feed
    seed(mx)
    target = tmp_path / 'drive'
    target.mkdir()
    snapshots.set_copy_folder(str(target))
    exported = snapshots.export(PASSWORD)
    record = snapshots.copy_export(exported['id'])
    copy = Path(record['path'])
    assert record['ok'] and copy.parent == target and copy.name.endswith(f"-{exported['id'][:12]}.pilotbackup")
    assert copy.read_bytes() == snapshots.exported(exported['id']).read_bytes()
    assert record['sha256'] == exported['sha256'] and oct(copy.stat().st_mode & 0o777) == '0o600'
    assert snapshots.list_exports()[0]['copy'] == record and snapshots.copy_status()['last'] == record
    assert snapshots.inspect(copy, PASSWORD)['files'] == exported['files']           # the copy restores
    assert not list(target.glob('.*.partial'))
    notices = lambda: feed.list_events(kind='instance_backup.copy_failed')['events']
    # A copy that does not read back as the archive is refused and notified; no partial file stays.
    real_digest = snapshots._digest
    monkeypatch.setattr(snapshots, '_digest', lambda path: 'f' * 64 if path.name.endswith('.partial') else real_digest(path))
    copy.unlink()
    failed = snapshots.copy_export(exported['id'])
    assert failed['ok'] is False and failed['code'] == 'copy_mismatch' and not list(target.iterdir())
    assert len(notices()) == 1 and notices()[0]['params']['code'] == 'copy_mismatch'
    monkeypatch.setattr(snapshots, '_digest', real_digest)
    # An unplugged drive fails without writing elsewhere; the next good copy resolves the notice.
    target.rmdir()
    missing = snapshots.copy_export(exported['id'])
    assert missing['code'] == 'copy_folder_missing' and not target.exists()
    target.mkdir()
    assert snapshots.copy_export(exported['id'])['ok'] and notices()[0]['resolved_at']


def test_export_route_copies_after_services_resume_and_retry_route(client, mx, tmp_path):
    seed(mx)
    target = tmp_path / 'synced'
    target.mkdir()
    assert client.put('/api/backup/instance/copy', json={'folder': str(target)}).json()['folder'] == str(target)
    bad = client.put('/api/backup/instance/copy', json={'folder': 'nowhere'})
    assert bad.status_code == 400 and bad.json()['error'] == 'copy_folder'
    exported = client.post('/api/backup/instance/export', json={'passphrase': PASSWORD}).json()
    assert exported['copy']['ok'] and Path(exported['copy']['path']).is_file()
    assert client.get('/api/backup/instance').json()['copy']['last']['path'] == exported['copy']['path']
    Path(exported['copy']['path']).unlink()
    again = client.post(f"/api/backup/instance/exports/{exported['id']}/copy").json()
    assert again['ok'] and Path(again['path']).is_file()
    assert client.delete('/api/backup/instance/copy').json()['folder'] is None
    off = client.post(f"/api/backup/instance/exports/{exported['id']}/copy")
    assert off.status_code == 409 and off.json()['error'] == 'copy_off'
    assert client.post('/api/backup/instance/export', json={'passphrase': PASSWORD}).json().get('copy') is None
