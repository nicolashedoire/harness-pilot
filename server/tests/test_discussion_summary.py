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
