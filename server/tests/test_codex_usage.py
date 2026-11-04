"""Codex token counts: `codex exec --json` reports the thread's running totals in `turn.completed` (checked with
codex-cli 0.150.1 against a stub Responses API, INTERNALS.md `maxxing.sessions.codex`); a turn counts what they grew by."""
import json

from conftest import all_events, wait_idle
from maxxing.sessions import codex, store

# A fake `codex` that behaves like 0.150.1: call n adds 100n input tokens (40n cached) and 10n output tokens to the
# running totals of its thread, and reports those totals. `exec ... resume <id> -` continues thread <id>.
FAKE = '''#!/usr/bin/env python3
import json, os, sys
sys.stdin.read()
path = os.environ["FAKE_CODEX_TOTALS"]
state = json.load(open(path)) if os.path.exists(path) else {"n": 0, "threads": {}}
state["n"] += 1
n = state["n"]
thread = sys.argv[sys.argv.index("resume") + 1] if "resume" in sys.argv else f"thread-{n}"
t = state["threads"].get(thread) or {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
t = {"input_tokens": t["input_tokens"] + 100 * n, "cached_input_tokens": t["cached_input_tokens"] + 40 * n,
     "output_tokens": t["output_tokens"] + 10 * n}
state["threads"][thread] = t
json.dump(state, open(path, "w"))
print(json.dumps({"type": "thread.started", "thread_id": thread}), flush=True)
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": f"answer {n}"}}), flush=True)
print(json.dumps({"type": "turn.completed", "usage": {**t, "cache_write_input_tokens": 0}}), flush=True)
'''


def test_turn_usage_is_what_the_running_totals_grew_by():
    first = {'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 40, 'output_tokens': 10}}
    later = {'type': 'turn.completed', 'usage': {'input_tokens': 300, 'cached_input_tokens': 120, 'output_tokens': 30,
                                                 'cache_write_input_tokens': 5}}
    base = codex.usage_totals(first)
    assert base == {'input_tokens': 100, 'cached_input_tokens': 40, 'cache_write_input_tokens': 0, 'output_tokens': 10}
    assert codex.events(later, base)[0]['usage'] == {'input_tokens': 115, 'output_tokens': 20,
                                                      'cache_read_input_tokens': 80, 'cache_creation_input_tokens': 5}
    # no base (a new thread, or one counted before this fix) or a base above the totals (another thread): the totals
    whole = {'input_tokens': 175, 'output_tokens': 30, 'cache_read_input_tokens': 120, 'cache_creation_input_tokens': 5}
    assert codex.events(later)[0]['usage'] == whole
    assert codex.events(later, {**base, 'output_tokens': 31})[0]['usage'] == whole
    assert codex.events(later, {'input_tokens': 'x'})[0]['usage'] == whole


def test_codex_turns_count_their_own_tokens_across_resume_and_compaction(client, topic, mx, monkeypatch):
    fake = mx['tmp'] / 'codex'
    fake.write_text(FAKE)
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    monkeypatch.setenv('FAKE_CODEX_TOTALS', str(mx['tmp'] / 'codex-totals.json'))
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'codex', 'message': 'one'}).json()['id']
    wait_idle(client, sid)
    assert client.post(f'/api/sessions/{sid}/messages', json={'text': 'two'}).status_code == 200
    wait_idle(client, sid)
    # the summary turn resumes thread-1 (call 3); the seed then starts thread-4 (call 4), counted from zero
    assert client.post(f'/api/sessions/{sid}/compact').status_code == 200
    wait_idle(client, sid)
    results = [e['usage'] for e in all_events(client, sid) if e['type'] == 'result']
    assert results == [{'input': 60 * n, 'output': 10 * n, 'cache_read': 40 * n, 'cache_write': 0} for n in (1, 2, 3, 4)]
    m = store.read(sid)
    assert m['tokens'] == {'input': 600, 'output': 100, 'cache_read': 400, 'cache_write': 0}
    assert m['codex_usage'] == {'thread': 'thread-4', 'total': {'input_tokens': 400, 'cached_input_tokens': 160,
                                                                 'cache_write_input_tokens': 0, 'output_tokens': 40}}
    usage = m['provider_usage']['codex']
    assert (usage['input'], usage['cache_read'], usage['output'], usage['turns']) == (600, 400, 100, 4)
    totals = json.loads((mx['tmp'] / 'codex-totals.json').read_text())['threads']
    assert set(totals) == {'thread-1', 'thread-4'}
