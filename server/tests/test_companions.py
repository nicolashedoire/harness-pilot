"""Resident experiments use disposable source copies and require explicit review."""
import subprocess
import uuid

from conftest import wait_for, wait_idle
from maxxing import companions, config


def test_proposal_review_and_decision(client, topic, mx, monkeypatch):
    source = mx['tmp'] / 'source'
    source.mkdir()
    subprocess.run(['git', 'init', '-q', str(source)], check=True)
    (source / 'app.txt').write_text('original\n')
    subprocess.run(['git', '-C', str(source), 'add', 'app.txt'], check=True)
    subprocess.run(['git', '-C', str(source), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'], check=True)
    subprocess.run(['git', '-C', str(source), 'remote', 'add', 'origin', 'https://github.com/example/demo.git'], check=True)
    monkeypatch.setattr(config, 'CODE', source)
    fake = mx['tmp'] / 'codex'
    fake.write_text('''#!/usr/bin/env python3
import json, pathlib, subprocess, sys
prompt = sys.stdin.read()
assert 'complete user journey' in prompt and 'visual design and accessibility' in prompt
assert 'workspace-write' in sys.argv or 'extends = ":workspace"' in ' '.join(sys.argv)   # --sandbox or the protect-secrets profile
assert not subprocess.check_output(['git', 'remote']).strip()
assert pathlib.Path('../architecture.json').is_file()
pathlib.Path('app.txt').write_text('improved\\n')
pathlib.Path('proof.txt').write_text('test evidence\\n')
pathlib.Path('proof.txt').chmod(0o755)
print(json.dumps({'type':'thread.started','thread_id':'companion-test'}), flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Test passed'}}), flush=True)
print(json.dumps({'type':'turn.completed','usage':{}}), flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    defaults = client.get('/api/companions').json()['companions']
    assert {p['id'] for p in defaults} >= {'observer', 'security', 'architect', 'reverse-engineer'}
    r = client.post('/api/companions', json={'name': 'Auditor', 'role': 'Inspect and test'})
    assert r.status_code == 200, r.text
    profile = r.json()
    assert any(p['id'] == profile['id'] for p in client.get('/api/companions').json()['companions'])
    r = client.post(f"/api/companions/{profile['id']}/runs", json={'path': topic})
    assert r.status_code == 200, r.text
    sid = r.json()['id']
    session = wait_idle(client, sid)
    assert session['state'] == 'idle', session
    r = client.get(f'/api/companions/runs/{sid}/review')
    assert r.status_code == 200, r.text
    proposal = r.json()
    assert '+improved' in proposal['patch']
    assert proposal['untracked'] == [{'path': 'proof.txt', 'content': 'test evidence\n', 'executable': True}]
    assert (source / 'app.txt').read_text() == 'original\n'
    assert not (source / 'proof.txt').exists()
    decision = f'/api/companions/runs/{sid}/decision'
    assert client.post(decision, json={'decision': 'approved', 'fingerprint': '0'*64}).status_code == 409
    pr_path = f'/api/companions/runs/{sid}/pull-request'
    pr_body = {'fingerprint': proposal['fingerprint'], 'title': 'Improve the app', 'body': 'A reviewed change.'}
    assert client.post(pr_path, json=pr_body).status_code == 409
    r = client.post(decision, json={'decision': 'approved', 'fingerprint': proposal['fingerprint']})
    assert r.status_code == 200, r.text
    assert r.json()['decision']['value'] == 'approved'
    assert client.post(decision, json={'decision': 'rejected', 'fingerprint': proposal['fingerprint']}).status_code == 200
    assert client.post(pr_path, json=pr_body).status_code == 409
    assert client.post(decision, json={'decision': 'approved', 'fingerprint': proposal['fingerprint']}).status_code == 200
    assert (source / 'app.txt').read_text() == 'original\n'
    from maxxing import companions, companion_pr
    real_git = companions._git
    pushed = []
    def fake_git(cwd, *args, **kwargs):
        if 'fetch' in args:
            base = real_git(cwd, 'rev-parse', 'HEAD').decode().strip()
            # At this point HEAD is the proposal; its parent is the reviewed base.
            real_git(cwd, 'update-ref', 'refs/remotes/pilot-base', base + '^')
            return b''
        if 'push' in args:
            assert real_git(cwd, 'show', 'HEAD:app.txt') == b'improved\n'
            assert real_git(cwd, 'show', 'HEAD:proof.txt') == b'test evidence\n'
            assert real_git(cwd, 'ls-tree', 'HEAD', 'proof.txt').startswith(b'100755 ')
            pushed.append(real_git(cwd, 'show', '--format=', '--stat', 'HEAD').decode())
            return b''
        return real_git(cwd, *args, **kwargs)
    def fake_gh(*args):
        if args[:2] == ('repo', 'view'):
            return 'main'
        if args[:2] == ('pr', 'list'):
            return ''
        if args[:2] == ('pr', 'create'):
            assert '--draft' in args and 'Improve the app' in args
            return 'https://github.com/example/demo/pull/42'
        raise AssertionError(args)
    monkeypatch.setattr(companions, '_git', fake_git)
    monkeypatch.setattr(companion_pr, '_gh', fake_gh)
    result = client.post(pr_path, json=pr_body)
    assert result.status_code == 200, result.text
    assert result.json()['url'] == 'https://github.com/example/demo/pull/42'
    assert pushed and 'app.txt' in pushed[0] and 'proof.txt' in pushed[0]
    assert client.get(f'/api/companions/runs/{sid}/review').json()['pull_request']['url'].endswith('/42')
    assert (source / 'app.txt').read_text() == 'original\n'
    def notification():
        result = client.get('/api/feed').json()
        events = result.get('events', []) if isinstance(result, dict) else result
        return any(e.get('url', '').endswith(f'run={sid}') for e in events)
    assert wait_for(notification, timeout=10)


def test_a_mission_planning_run_raises_no_companion_review_notice(client, topic):
    from maxxing import feed
    from maxxing.sessions import store
    def companion_notices():
        return [e for e in feed.list_events()['events'] if str(e.get('kind') or '').startswith('companion.')]
    for purpose in ('plan', 'experiment'):
        sid = client.post('/api/sessions', json={'path': topic, 'title': purpose}).json()['id']
        with store.edit(sid) as meta:
            meta.update(state='idle', turns=1)
            meta['companion'] = {'id': 'architect', 'run_id': str(uuid.uuid4()), 'base': 'a' * 40, 'purpose': purpose}
        companions._notify({'id': sid, 'state': 'idle', 'turns': 1})
        if purpose == 'plan':
            assert companion_notices() == []
    # the experiment run is still reported (its copy is missing here, so as needing attention)
    assert [e['kind'] for e in companion_notices()] == ['companion.error']


def _claude_settings(mx) -> list[dict]:
    import json
    f = mx['fake_dir'] / 'calls.jsonl'
    rows = [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []
    return [json.loads(r['argv'][r['argv'].index('--settings') + 1]) for r in rows if '--settings' in r['argv']]


def test_the_companion_sandbox_option_confines_claude_companion_commands(client, topic, mx, monkeypatch):
    """Off by default; on, only companion sessions get Claude Code's OS sandbox, with no way out and no new approval."""
    from maxxing.sessions import spawn
    source = mx['tmp'] / 'source'
    source.mkdir()
    subprocess.run(['git', 'init', '-q', str(source)], check=True)
    (source / 'app.txt').write_text('original\n')
    subprocess.run(['git', '-C', str(source), 'add', 'app.txt'], check=True)
    subprocess.run(['git', '-C', str(source), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'], check=True)
    monkeypatch.setattr(config, 'CODE', source)
    assert client.get('/api/settings').json()['companion_sandbox'] is False
    role = client.post('/api/companions', json={'name': 'Claude auditor', 'role': 'Inspect', 'provider': 'claude'}).json()

    def run() -> dict:
        r = client.post(f"/api/companions/{role['id']}/runs", json={'path': topic, 'mission': 'NOTOOL'})
        assert r.status_code == 200, r.text
        wait_idle(client, r.json()['id'])
        return _claude_settings(mx)[-1]

    assert 'sandbox' not in run()                                             # off by default
    assert client.put('/api/settings', json={'companion_sandbox': True}).json()['companion_sandbox'] is True
    s = run()
    assert s['sandbox'] == {'enabled': True, 'failIfUnavailable': True, 'allowUnsandboxedCommands': False,
                            'autoAllowBashIfSandboxed': False} == spawn.COMPANION_SANDBOX
    assert s['permissions']['deny']                                           # the deny rules stay
    plain = client.post('/api/sessions', json={'path': topic, 'message': 'NOTOOL'}).json()   # not a companion
    wait_idle(client, plain['id'])
    assert 'sandbox' not in _claude_settings(mx)[-1]
