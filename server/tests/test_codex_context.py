"""Context gauge of Codex sessions: `codex exec --json` carries no context size, Codex's own session file does
(`token_count` after every model call). Shapes as written by codex-cli 0.150.1 (INTERNALS.md `maxxing.sessions.codex`)."""
import json
import os
import time
from pathlib import Path

from conftest import wait_idle
from maxxing.sessions import codex, store

V7 = '01a1a71d-9208-7c31-b16c-defbcfd43e6a'      # a 0.150.1 thread id (UUIDv7: started 2026-11-04 16:11 local time)


def _line(kind: str, payload: dict) -> str:
    return json.dumps({'timestamp': '2026-11-04T15:11:35.000Z', 'type': kind, 'payload': payload}) + '\n'


def _count(last: int, total: int, window: object = 258400) -> str:
    usage = lambda n: {'input_tokens': n, 'cached_input_tokens': n // 2, 'cache_write_input_tokens': 0,  # noqa: E731
                       'output_tokens': 20, 'reasoning_output_tokens': 2, 'total_tokens': n + 20}
    info = {'total_token_usage': usage(total), 'last_token_usage': usage(last), 'model_context_window': window}
    return _line('event_msg', {'type': 'token_count', 'info': info, 'rate_limits': {'limit_id': 'codex'}})


def _write(home: Path, day: str, thread: str, lines: list[str], at: str = '2026-11-04T16-11-35') -> Path:
    path = home / 'sessions' / day / f'rollout-{at}-{thread}.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    head = [_line('session_meta', {'id': thread, 'base_instructions': {'text': 'x' * 2000}}),
            _line('event_msg', {'type': 'task_started', 'model_context_window': 258400}),
            _line('event_msg', {'type': 'token_count', 'info': None, 'rate_limits': None})]
    path.write_text(''.join(head + lines))
    return path


def test_context_comes_from_the_last_call_in_codex_session_file(tmp_path):
    home = tmp_path / 'codex-home'
    env = {'CODEX_HOME': str(home)}
    day = time.strftime('%Y/%m/%d', time.localtime(int(V7.replace('-', '')[:12], 16) / 1000))
    path = _write(home, day, V7, [_count(102000, 102000), _count(103000, 205000),
                                  _line('event_msg', {'type': 'task_complete'})])
    assert codex.session_file(V7, env) == path
    assert codex.context_usage(V7, env) == {'tokens': 103000, 'window': 258400, 'first': None}
    assert codex.context_usage(V7, env, first=True) == {'tokens': 103000, 'window': 258400, 'first': 102000}
    # resumed: appended to the same file; a -c model_context_window=150000 thread records 142 500
    with path.open('a') as f:
        f.write(_count(104000, 309000, 142500))
    assert codex.context_usage(V7, env)['tokens'] == 104000 and codex.context_usage(V7, env)['window'] == 142500
    # Codex compacted its thread: 0 until the next call - unknown, never 0
    with path.open('a') as f:
        f.write(_line('compacted', {'message': ''}) + _count(0, 309000))
    assert codex.context_usage(V7, env) is None
    with path.open('a') as f:
        f.write(_count(9000, 318000, None))                       # no window recorded: Codex's own fallback
    assert codex.context_usage(V7, env) == {'tokens': 9000, 'window': codex.DEFAULT_WINDOW, 'first': None}
    # the last call is found beyond the first 256 KB read from the end
    with path.open('a') as f:
        f.write(_line('response_item', {'type': 'function_call_output', 'output': 'y' * (300 * 1024)}))
    assert codex.context_usage(V7, env)['tokens'] == 9000


def test_session_file_lookup(tmp_path):
    home = tmp_path / 'codex-home'
    env = {'CODEX_HOME': str(home)}
    other = 'thread-not-v7-0001'                                   # not a UUIDv7: every day folder is searched
    path = _write(home, '2025/01/02', other, [_count(5000, 5000)])
    assert codex.session_file(other, env) == path
    assert codex.context_usage(other, env)['tokens'] == 5000
    _write(home, '2025/01/02', V7, [_count(7000, 7000)])            # a v7 id outside its day: found too
    assert codex.context_usage(V7, env)['tokens'] == 7000
    for bad in ('', '../sessions', 'a*', 'x' * 80, 'abc'):
        assert codex.session_file(bad, env) is None and codex.context_usage(bad, env) is None
    assert codex.context_usage('missing-thread-01', env) is None
    assert codex.home({'HOME': str(tmp_path)}) == tmp_path / '.codex'
    assert codex.home({'CODEX_HOME': str(home), 'HOME': '/nowhere'}) == home
    broken = _write(home, '2025/01/03', 'broken-thread-01', ['{not json\n', _count(1, 1).replace('"info"', '"x"')])
    assert broken.exists() and codex.context_usage('broken-thread-01', env) is None


# A fake `codex` that writes its session file like 0.150.1 (into $CODEX_HOME, under today's folder, a UUIDv7 thread
# id) - each turn n makes two calls of 50 000n and 50 000n + 1000 input tokens - and prints the JSON stream.
FAKE = '''#!/usr/bin/env python3
import json, os, sys, time
sys.stdin.read()
home = os.environ["CODEX_HOME"]
counter = os.path.join(home, "calls")
n = int(open(counter).read()) + 1 if os.path.exists(counter) else 1
os.makedirs(home, exist_ok=True)
open(counter, "w").write(str(n))
if "resume" in sys.argv:
    thread = sys.argv[sys.argv.index("resume") + 1]
else:
    h = "%012x" % int(time.time() * 1000) + "7" + "%019x" % n
    thread = "-".join((h[:8], h[8:12], h[12:16], h[16:20], h[20:32]))
day = os.path.join(home, "sessions", time.strftime("%Y/%m/%d"))
os.makedirs(day, exist_ok=True)
found = [f for f in os.listdir(day) if f.endswith(thread + ".jsonl")]
path = os.path.join(day, found[0] if found else time.strftime("rollout-%Y-%m-%dT%H-%M-%S-") + thread + ".jsonl")
def line(kind, payload):
    return json.dumps({"timestamp": "", "type": kind, "payload": payload}) + "\\n"
def count(k):
    u = {"input_tokens": k, "cached_input_tokens": 0, "output_tokens": 10, "total_tokens": k + 10}
    return line("event_msg", {"type": "token_count", "info": {"total_token_usage": u, "last_token_usage": u,
                                                               "model_context_window": 258400}})
if not os.environ.get("FAKE_CODEX_NO_FILE"):
    with open(path, "a") as f:
        f.write(line("event_msg", {"type": "task_started", "model_context_window": 258400}))
        f.write(count(50000 * n) + count(50000 * n + 1000))
print(json.dumps({"type": "thread.started", "thread_id": thread}), flush=True)
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": f"answer {n}"}}), flush=True)
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100 * n, "output_tokens": 10}}), flush=True)
'''


def _fake_codex(mx, monkeypatch) -> Path:
    fake = mx['tmp'] / 'codex'
    fake.write_text(FAKE)
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    return Path(os.environ['CODEX_HOME'])


def test_codex_session_shows_its_context(client, topic, mx, monkeypatch):
    home = _fake_codex(mx, monkeypatch)
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'codex', 'message': 'one'}).json()['id']
    s = wait_idle(client, sid)
    assert (s['context_tokens'], s['context_window']) == (51000, 258400)
    assert store.read(sid)['base_tokens'] == 50000                  # the first call of the thread: its fixed part
    assert client.post(f'/api/sessions/{sid}/messages', json={'text': 'two'}).status_code == 200
    s = wait_idle(client, sid)
    assert (s['context_tokens'], s['context_window']) == (101000, 258400)
    assert store.read(sid)['base_tokens'] == 50000                  # a resumed thread keeps it
    assert [p.parent.relative_to(home / 'sessions') for p in home.glob('sessions/*/*/*/*.jsonl')] == \
        [Path(time.strftime('%Y/%m/%d'))]


def test_a_codex_turn_without_its_session_file_keeps_the_gauge_hidden(client, topic, mx, monkeypatch):
    """`--ephemeral`, another CODEX_HOME, a format Codex changed: no number rather than a guess."""
    _fake_codex(mx, monkeypatch)
    monkeypatch.setenv('FAKE_CODEX_NO_FILE', '1')
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'codex', 'message': 'one'}).json()['id']
    s = wait_idle(client, sid)
    assert s['turns'] == 1 and s['state'] == 'idle' and s['last_text'] == 'answer 1'
    assert (s['context_tokens'], s['context_window']) == (None, None)
    assert 'base_tokens' not in store.read(sid)
