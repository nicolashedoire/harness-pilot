from __future__ import annotations

import json
import concurrent.futures
import os
from pathlib import Path
import subprocess
import sys
import threading
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
