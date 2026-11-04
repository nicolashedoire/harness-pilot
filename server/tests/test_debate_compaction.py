"""Compaction of a Claude Code + Codex discussion: near the context limit, after an overflow, and on demand."""
import json

from conftest import all_events, wait_for
from maxxing import config
from maxxing.sessions import runner, store

CODEX = '''#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
calls = os.environ["DEBATE_CODEX_CALLS"]
n = sum(1 for _ in open(calls)) if os.path.exists(calls) else 0
with open(calls, "a") as f: f.write(json.dumps({"argv": sys.argv[1:], "prompt": prompt}) + "\\n")
print(json.dumps({"type": "thread.started", "thread_id": "codex-thread-%d" % n}), flush=True)
if n == 0 and os.environ.get("DEBATE_CODEX_OVERFLOW"):
    print(json.dumps({"type": "turn.failed", "error": {"message": "Codex ran out of room in the model's context window."}}), flush=True)
    sys.exit(1)
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "Codex reply %d" % n}}), flush=True)
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}), flush=True)
'''


def _codex(mx, monkeypatch, overflow=False):
    fake, calls = mx['tmp'] / 'codex-compact', mx['tmp'] / 'codex-compact-calls.jsonl'
    fake.write_text(CODEX)
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    monkeypatch.setenv('DEBATE_CODEX_CALLS', str(calls))
    if overflow:
        monkeypatch.setenv('DEBATE_CODEX_OVERFLOW', '1')
    return lambda: [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []


def _claude_calls(mx):
    return [json.loads(line) for line in (mx['fake_dir'] / 'calls.jsonl').read_text().splitlines()]


def _paused(client, sid):
    return wait_for(lambda: (s := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and s['debate_paused'] and s, 40)


def _notes(client, sid):
    return [e['text'] for e in all_events(client, sid) if e['type'] == 'note']


def test_discussion_near_the_limit_is_compacted_and_both_agents_start_fresh_threads(client, topic, mx, monkeypatch):
    codex_calls = _codex(mx, monkeypatch)
    config.update_config(auto_compact_tokens=100000)          # every Claude reply reports 150k (BIGCTX)
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'discussion', 'message': 'Un sujet BIGCTX NOTOOL',
                                             'discussion_turn_limit': 4}).json()['id']
    s = _paused(client, sid)
    assert s['discussion_turns'] == 4 and s['discussion_pause_reason'] == 'limit'   # the summaries are not replies
    notes = _notes(client, sid)
    assert sum('The discussion reached 150k tokens' in n for n in notes) == 2
    assert sum(n.startswith('Discussion compacted') for n in notes) == 2
    events = all_events(client, sid)
    assert [e['source'] for e in events if e['type'] == 'user'] == ['web', 'system', 'system']   # the separators
    claude = _claude_calls(mx)
    summaries = [c for c in claude if c['prompt'].startswith(runner.DEBATE_SUMMARY_PROMPT)]
    replies = [c for c in claude if c not in summaries]
    assert len(summaries) == 2 and len(replies) == 2
    for c in summaries:                                        # read-only, in a throwaway thread, never a resume
        assert c['argv'][c['argv'].index('--permission-mode') + 1] == 'plan' and '--resume' not in c['argv']
    assert 'User: Un sujet BIGCTX NOTOOL' in summaries[0]['prompt'] and 'Codex: Codex reply 0' in summaries[1]['prompt']
    assert 'Summary of the earlier exchanges:\nSummary: the user tested' in summaries[1]['prompt']
    assert 'User: Un sujet' not in summaries[1]['prompt']      # only the exchanges since the last compaction
    # Claude's next reply opens a new thread seeded with the summary; Codex never resumes a thread opened before
    second = replies[1]
    assert '--session-id' in second['argv'] and '--resume' not in second['argv']
    assert second['argv'][second['argv'].index('--session-id') + 1] != replies[0]['argv'][replies[0]['argv'].index('--session-id') + 1]
    assert 'Context of this discussion before compaction' in second['prompt']
    codex = codex_calls()
    assert len(codex) == 2 and all('resume' not in c['argv'] for c in codex)
    assert all('Context of this discussion before compaction' in c['prompt'] for c in codex)
    meta = store.read(sid)
    assert meta['discussion_summary'].startswith('Summary:') and 'discussion_compact_due' not in meta


def test_an_agent_out_of_context_answers_again_after_the_compaction(client, topic, mx, monkeypatch):
    codex_calls = _codex(mx, monkeypatch, overflow=True)
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'debate', 'message': 'Overflow NOTOOL',
                                             'discussion_turn_limit': 2}).json()['id']
    s = _paused(client, sid)
    assert s['discussion_turns'] == 2 and not s['error']       # the exchange went on instead of failing
    notes = _notes(client, sid)
    assert any(n.startswith('Codex ran out of context') for n in notes)
    assert any(n.startswith('Discussion compacted') for n in notes)
    codex = codex_calls()
    assert len(codex) == 2 and 'resume' not in codex[1]['argv']
    assert 'Context of this discussion before compaction' in codex[1]['prompt']
    assert 'Latest contribution from Claude Code' in codex[1]['prompt']   # the same reply, asked again
    assert [e['text'] for e in all_events(client, sid) if e['type'] == 'assistant'][-1] == 'Codex reply 1'
    assert len([e for e in all_events(client, sid) if e['type'] == 'user' and e['source'] != 'system']) == 1


def test_a_paused_discussion_can_be_compacted_on_demand(client, topic, mx, monkeypatch):
    codex_calls = _codex(mx, monkeypatch)
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'discussion', 'message': 'Manual NOTOOL',
                                             'discussion_turn_limit': 1}).json()['id']
    _paused(client, sid)
    csid = store.read(sid)['csid']
    assert client.post(f'/api/sessions/{sid}/compact').json() == {'ok': True}
    wait_for(lambda: any(n.startswith('Discussion compacted') for n in _notes(client, sid)), 20)
    s = _paused(client, sid)                                   # still paused: nothing else ran
    assert s['discussion_turns'] == 1 and store.read(sid)['csid'] != csid and not codex_calls()
    assert client.post(f'/api/sessions/{sid}/discussion/resume').status_code == 200
    wait_for(lambda: codex_calls(), 20)
    assert 'Context of this discussion before compaction' in codex_calls()[0]['prompt']
    client.post(f'/api/sessions/{sid}/stop')


def test_transcript_keeps_who_said_what_and_skips_summaries(tmp_path):
    log = tmp_path / 'log.jsonl'
    say = lambda text: {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': text}]}, 'mx_at': 5}
    lines = [{'type': 'mx_user', 'kind': 'user', 'text': 'old', 'at': 1}, {'type': 'mx_done', 'at': 1},
             {'type': 'mx_user', 'kind': 'user', 'text': 'Goal', 'at': 5}, {'type': 'mx_note', 'text': 'Claude Code', 'at': 5},
             say('thinking aloud'), say('Claude answer'), {'type': 'mx_done', 'at': 5},
             {'type': 'mx_user', 'kind': 'compact', 'text': 'Summarize', 'at': 5}, say('A summary'), {'type': 'mx_done', 'at': 5},
             {'type': 'mx_note', 'text': 'Codex', 'at': 5}, say('Codex answer'), {'type': 'mx_done', 'at': 5}]
    log.write_text(''.join(json.dumps(x) + '\n' for x in lines) + 'not json\n')
    assert runner._debate_transcript(log, 3) == 'User: Goal\n\nClaude Code: Claude answer\n\nCodex: Codex answer'
    assert runner._debate_transcript(log, None).startswith('User: old\n\nUser: Goal')


def test_context_overflow_is_recognised_for_both_agents():
    claude = runner.Attempt(rc=1, result={'is_error': True, 'result': 'Prompt is too long'})
    assert runner._context_overflow(claude, 'Claude exited with code 1')
    assert runner._context_overflow(runner.Attempt(), "Codex ran out of room in the model's context window.")
    assert not runner._context_overflow(runner.Attempt(result={'is_error': False, 'result': 'Prompt is too long'}), 'boom')
    assert not runner._context_overflow(runner.Attempt(), 'OAuth session expired')
