"""Resident experiments use disposable source copies and require explicit review."""
import subprocess

from conftest import wait_for, wait_idle
from maxxing import config


def test_proposal_review_and_decision(client, topic, mx, monkeypatch):
    source = mx['tmp'] / 'source'
    source.mkdir()
    subprocess.run(['git', 'init', '-q', str(source)], check=True)
    (source / 'app.txt').write_text('original\n')
    subprocess.run(['git', '-C', str(source), 'add', 'app.txt'], check=True)
    subprocess.run(['git', '-C', str(source), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial'], check=True)
    monkeypatch.setattr(config, 'CODE', source)
    fake = mx['tmp'] / 'codex'
    fake.write_text('''#!/usr/bin/env python3
import json, pathlib, subprocess, sys
prompt = sys.stdin.read()
assert 'complete user journey' in prompt and 'visual design and accessibility' in prompt
assert '--sandbox' in sys.argv and 'workspace-write' in sys.argv
assert not subprocess.check_output(['git', 'remote']).strip()
assert pathlib.Path('../architecture.json').is_file()
pathlib.Path('app.txt').write_text('improved\\n')
pathlib.Path('proof.txt').write_text('test evidence\\n')
print(json.dumps({'type':'thread.started','thread_id':'companion-test'}), flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'Test passed'}}), flush=True)
print(json.dumps({'type':'turn.completed','usage':{}}), flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    defaults = client.get('/api/companions').json()['companions']
    assert {p['id'] for p in defaults} >= {'observer', 'security', 'architect'}
    r = client.post('/api/companions', json={'name': 'Auditor', 'role': 'Inspect and test'})
    assert r.status_code == 200, r.text
    profile = r.json()
    assert any(p['id'] == profile['id'] for p in client.get('/api/companions').json()['companions'])
    r = client.post(f"/api/companions/{profile['id']}/runs", json={'path': topic})
    assert r.status_code == 200, r.text
    sid = r.json()['id']
    session = wait_idle(client, sid)
    assert session['state'] == 'idle', session
    graph = client.get(f'/api/companions/runs/{sid}/architecture')
    assert graph.status_code == 200 and graph.json()['version'] == 1
    r = client.get(f'/api/companions/runs/{sid}/review')
    assert r.status_code == 200, r.text
    proposal = r.json()
    assert '+improved' in proposal['patch']
    assert proposal['untracked'] == [{'path': 'proof.txt', 'content': 'test evidence\n'}]
    assert (source / 'app.txt').read_text() == 'original\n'
    assert not (source / 'proof.txt').exists()
    decision = f'/api/companions/runs/{sid}/decision'
    assert client.post(decision, json={'decision': 'approved', 'fingerprint': '0'*64}).status_code == 409
    r = client.post(decision, json={'decision': 'approved', 'fingerprint': proposal['fingerprint']})
    assert r.status_code == 200, r.text
    assert r.json()['decision']['value'] == 'approved'
    assert (source / 'app.txt').read_text() == 'original\n'
    def notification():
        result = client.get('/api/feed').json()
        events = result.get('events', []) if isinstance(result, dict) else result
        return any(e.get('url', '').endswith(f'run={sid}') for e in events)
    assert wait_for(notification, timeout=10)
