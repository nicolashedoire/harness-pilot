import json
import os
import pytest

from maxxing import workspace
from maxxing.sessions import codex, store, summary


def test_summary_is_review_only_and_keeps_discussion_actors(client, topic, mx, monkeypatch):
    meta = store.new_meta(topic, 'Discussion', provider='discussion')
    store.create(meta)
    store.append_log(meta['id'], {'type': 'mx_user', 'text': 'Planifier le projet'})
    store.append_log(meta['id'], {'type': 'mx_note', 'text': 'Claude Code'})
    store.append_log(meta['id'], {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Nous retenons une première étape.'}]}})
    store.append_log(meta['id'], {'type': 'mx_note', 'text': 'Codex'})
    store.append_log(meta['id'], {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Préparer un prototype.'}]}})
    fake = mx['tmp'] / 'codex-summary'
    prompt = mx['tmp'] / 'summary-prompt'
    monkeypatch.setenv('SUMMARY_PROMPT_FILE', str(prompt))
    fake.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['SUMMARY_PROMPT_FILE'], 'w') as f: f.write(sys.stdin.read())
answer = {'summary': 'Une première étape.', 'decisions': ['Commencer petit'], 'actions': [{'title': 'Préparer un prototype', 'notes': 'Première étape'}]}
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(answer)}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1200,'cached_input_tokens':200,'output_tokens':80}}))
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    monkeypatch.setattr(codex, 'status', lambda: {'authenticated': True})
    before = client.get('/api/tasks').json()
    result = client.post(f"/api/sessions/{meta['id']}/summary")
    assert result.status_code == 200, result.text
    assert result.json()['actions'][0]['title'] == 'Préparer un prototype'
    assert result.json()['truncated'] is False
    assert 'Claude Code: Nous retenons une première étape.' in prompt.read_text()
    assert 'Codex: Préparer un prototype.' in prompt.read_text()
    assert client.get('/api/tasks').json() == before
    assert result.json()['engine'] == 'codex' and result.json()['cost_usd'] == 0
    m = store.read(meta['id'])                       # counted for Codex in the statistics, not as a turn
    assert m['provider_usage']['codex'] == {'input': 1000, 'output': 80, 'cache_read': 200, 'cache_write': 0, 'turns': 0}
    assert int(m.get('turns') or 0) == 0


def _claude_session(topic):
    meta = store.new_meta(topic, 'Claude', provider='claude')
    store.create(meta)
    store.append_log(meta['id'], {'type': 'mx_user', 'text': 'Plan the launch'})
    store.append_log(meta['id'], {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'We ship on Monday.'}]}})
    return meta


def test_summary_uses_claude_when_codex_is_not_signed_in(client, topic, mx, monkeypatch):
    """A Claude-only user gets the summary from Claude Code; its tokens and amount count in the statistics."""
    from maxxing import claude_auth, stats
    meta = _claude_session(topic)
    fake = mx['tmp'] / 'claude-summary'
    calls = mx['tmp'] / 'claude-summary-call'
    monkeypatch.setenv('SUMMARY_CALL_FILE', str(calls))
    fake.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['SUMMARY_CALL_FILE'], 'w') as f: json.dump({'argv': sys.argv[1:], 'prompt': sys.stdin.read(), 'cwd': os.getcwd()}, f)
answer = {'summary': 'Launch on Monday.', 'decisions': ['Ship on Monday'], 'actions': [{'title': 'Prepare the release notes', 'notes': ''}]}
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': '```json\\n' + json.dumps(answer) + '\\n```',
                  'total_cost_usd': 0.0123, 'usage': {'input_tokens': 900, 'output_tokens': 60, 'cache_read_input_tokens': 0,
                  'cache_creation_input_tokens': 300}}))
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CLAUDE_BIN', str(fake))
    monkeypatch.setattr(codex, 'status', lambda: {'installed': False, 'authenticated': False, 'reason': 'not_installed'})
    monkeypatch.setattr(claude_auth, 'status', lambda: {'ok': True, 'method': 'credentials'})
    result = client.post(f"/api/sessions/{meta['id']}/summary")
    assert result.status_code == 200, result.text
    body = result.json()
    assert body['engine'] == 'claude' and body['cost_usd'] == 0.0123
    assert body['decisions'] == ['Ship on Monday'] and body['actions'][0]['title'] == 'Prepare the release notes'
    call = json.loads(calls.read_text())
    assert call['argv'][:3] == ['-p', '--output-format', 'json'] and '--no-session-persistence' in call['argv']
    assert call['argv'][call['argv'].index('--tools') + 1] == ''              # no tool, nothing changed
    assert 'User: Plan the launch' in call['prompt'] and 'Agent: We ship on Monday.' in call['prompt']
    assert not call['cwd'].startswith(str(workspace.root()))                    # no CLAUDE.md of the topic read
    m = store.read(meta['id'])
    assert m['cost_usd'] == 0.0123 and int(m.get('turns') or 0) == 0
    assert m['provider_usage']['claude'] == {'input': 900, 'output': 60, 'cache_read': 0, 'cache_write': 300, 'turns': 0}
    totals = stats.tokens(force=True)
    assert totals['providers']['claude']['total'] == 1260 and totals['totals']['cost_usd'] >= 0.0123


def test_summary_without_any_signed_in_agent_says_so(client, topic, monkeypatch):
    from maxxing import claude_auth
    meta = _claude_session(topic)
    monkeypatch.setattr(codex, 'status', lambda: {'installed': True, 'authenticated': False, 'reason': 'not_authenticated'})
    monkeypatch.setattr(claude_auth, 'status', lambda: {'ok': False, 'method': None})
    result = client.post(f"/api/sessions/{meta['id']}/summary")
    assert result.status_code == 409 and result.json()['error'] == 'summary_no_agent'


def test_a_failed_claude_summary_still_counts_its_tokens(client, topic, mx, monkeypatch):
    from maxxing import claude_auth
    meta = _claude_session(topic)
    fake = mx['tmp'] / 'claude-fail'
    fake.write_text('''#!/usr/bin/env python3
import json, sys
sys.stdin.read()
print(json.dumps({'type': 'result', 'is_error': True, 'result': 'overloaded', 'total_cost_usd': 0.002,
                  'usage': {'input_tokens': 50, 'output_tokens': 0}}))
sys.exit(1)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CLAUDE_BIN', str(fake))
    monkeypatch.setattr(codex, 'status', lambda: {'authenticated': False})
    monkeypatch.setattr(claude_auth, 'status', lambda: {'ok': True})
    result = client.post(f"/api/sessions/{meta['id']}/summary")
    assert result.status_code == 502 and result.json()['error'] == 'summary_failed'
    assert 'Claude Code' in result.json()['message']
    assert store.read(meta['id'])['cost_usd'] == 0.002


def test_summary_identifies_a_truncated_transcript(monkeypatch):
    monkeypatch.setattr(summary.service, 'read_back', lambda *_a, **_kw: {
        'events': [{'type': 'user', 'text': 'x' * (summary.MAX_TEXT + 1)}], 'more_before': False})
    text, truncated = summary._transcript('id')
    assert truncated and len(text) == summary.MAX_TEXT


def test_summary_does_not_launch_twice_for_the_same_session():
    with summary._lock:
        summary._busy.add('same-session')
    try:
        with pytest.raises(summary.SessionError) as error:
            summary.generate('same-session')
        assert error.value.status == 409
    finally:
        with summary._lock:
            summary._busy.discard('same-session')


def test_reviewed_memory_is_appended_and_read_by_codex(client, topic):
    meta = store.new_meta(topic, 'Discussion', provider='discussion')
    store.create(meta)
    folder = workspace.topic_dir(topic)
    memory = folder / 'memory.md'
    before = memory.read_text()
    result = client.post(f"/api/sessions/{meta['id']}/summary/memory", json={'text': 'Décision validée : commencer petit.'})
    assert result.status_code == 200, result.text
    assert memory.read_text().startswith(before)
    assert 'Décision validée : commencer petit.' in codex.workspace_context(workspace.root(), folder)


def test_memory_rejects_symlinks_and_oversized_file(client, topic, mx):
    meta = store.new_meta(topic, 'Discussion', provider='discussion')
    store.create(meta)
    memory = workspace.topic_dir(topic) / 'memory.md'
    outside = mx['tmp'] / 'outside.txt'
    outside.write_text('unchanged')
    memory.unlink()
    memory.symlink_to(outside)
    url = f"/api/sessions/{meta['id']}/summary/memory"
    assert client.post(url, json={'text': 'safe text'}).status_code == 409
    assert outside.read_text() == 'unchanged'
    memory.unlink()
    memory.write_text('x' * 32760)
    assert client.post(url, json={'text': 'safe text'}).status_code == 409
    assert memory.read_text() == 'x' * 32760
    memory.unlink()
    os.mkfifo(memory)
    assert client.post(url, json={'text': 'safe text'}).status_code == 409
