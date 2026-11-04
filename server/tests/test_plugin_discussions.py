"""An agent plugin as the second agent of a discussion, when its declared capabilities allow it."""
import json
import sys

from conftest import all_events, wait_for
from maxxing.sessions import runner, store, summary

AGENT = '''import json, os, sys
request = json.loads(sys.stdin.read())
with open(os.environ["PLUGIN_CALLS"], "a") as f: f.write(json.dumps(request) + "\\n")
print(json.dumps({"type": "message", "text": "Plugin reply %d" % len(request["history"])}), flush=True)
print(json.dumps({"type": "result", "ok": True, "usage": {"input_tokens": 11, "output_tokens": 7}}), flush=True)
'''


def _install(mx, monkeypatch, capabilities=('text',)):
    folder = mx['ws'] / 'extensions/local-agent'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'agent').write_text(f'#!{sys.executable}\n' + AGENT)
    (folder / 'agent').chmod(0o755)
    (folder / 'manifest.json').write_text(json.dumps({
        'id': 'local-agent', 'name': 'Local engine', 'type': 'agent', 'api': 1, 'version': '1',
        'agent': {'protocol': 'pilot-jsonl-v1', 'command': ['./agent'], 'capabilities': list(capabilities)}}))
    calls = mx['tmp'] / 'plugin-calls.jsonl'
    monkeypatch.setenv('PLUGIN_CALLS', str(calls))
    return lambda: [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []


def test_a_plugin_takes_the_second_seat_of_a_discussion(client, topic, mx, monkeypatch):
    calls = _install(mx, monkeypatch)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(mx['tmp'] / 'no-codex'))     # Codex is never asked
    r = client.post('/api/sessions', json={'path': topic, 'provider': 'debate', 'message': 'Topic NOTOOL',
                                           'discussion_partner': 'plugin:local-agent', 'discussion_turn_limit': 4,
                                           'codex_role': 'REVIEWER ROLE', 'codex_model': 'engine-model'})
    assert r.status_code == 200, r.text
    sid = r.json()['id']
    assert r.json()['discussion_partner'] == 'plugin:local-agent' and r.json()['provider_name'] == 'Local engine'
    s = wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused'] and x, 30)
    assert s['discussion_turns'] == 4 and not s['error']
    labels = [e['text'] for e in all_events(client, sid) if e['type'] == 'note' and e['level'] == 'info']
    assert labels[:4] == ['Claude Code', 'Local engine', 'Claude Code', 'Local engine']
    first, second = calls()
    assert first['model'] == 'engine-model' and 'REVIEWER ROLE' in first['prompt']
    assert 'Latest contribution from Claude Code' in first['prompt']
    assert first['history'] == []                              # the objective and Claude's reply are in the prompt
    roles = [(h['role'], h['text'].split(':')[0]) for h in second['history']]
    assert roles == [('user', 'User'), ('user', 'Claude Code'), ('assistant', 'Plugin reply 0')]
    claude = [json.loads(line) for line in (mx['fake_dir'] / 'calls.jsonl').read_text().splitlines()]
    assert 'Latest contribution from Local engine' in claude[1]['prompt']
    assert store.read(sid)['provider_usage']['plugin:local-agent']['output'] == 14
    meta = store.read(sid)
    assert 'Local engine: Plugin reply 0' in runner._debate_transcript(store.log_path(sid), None, runner._agent_names(meta))
    monkeypatch.setattr(summary.service, 'read_back', lambda *_a, **_k: {'events': [
        {'type': 'note', 'text': 'Local engine'}, {'type': 'assistant', 'text': 'An idea'}], 'more_before': False})
    assert summary._transcript(sid)[0] == 'Local engine: An idea'


def test_a_plugin_is_refused_clearly_when_its_capabilities_do_not_allow_it(client, topic, mx, monkeypatch):
    _install(mx, monkeypatch)                                  # text only
    note = mx['files'] / 'note.txt'
    note.write_text('hello')
    body = {'path': topic, 'provider': 'discussion', 'discussion_partner': 'plugin:local-agent'}
    r = client.post('/api/sessions', json={**body, 'message': 'With a file', 'attachments': [str(note)]})
    assert r.status_code == 400 and "does not declare the 'attachments' capability" in r.json()['message']
    r = client.post('/api/sessions', json={**body, 'discussion_partner': 'plugin:missing'})
    assert r.status_code == 400 and r.json()['error'] == 'bad_provider'
    r = client.post('/api/sessions', json={'path': topic, 'provider': 'claude', 'discussion_partner': 'plugin:local-agent'})
    assert r.status_code == 400
    sid = client.post('/api/sessions', json=body).json()['id']
    r = client.post(f'/api/sessions/{sid}/messages', json={'text': 'A file', 'attachments': [str(note)]})
    assert r.status_code == 400 and 'Local engine cannot receive attached files' in r.json()['message']
    assert client.post('/api/sessions', json={'path': topic, 'provider': 'discussion'}).json()['discussion_partner'] == 'codex'
