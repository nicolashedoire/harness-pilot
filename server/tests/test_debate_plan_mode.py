"""Plan mode in a Claude Code + Codex discussion: both agents work out a plan read-only, the owner validates it,
one agent implements it and the discussion pauses for the other one's review."""
import json

from conftest import codex_sandbox, wait_for
from maxxing.sessions import runner

CODEX = '''#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
with open(os.environ["PLAN_CODEX_CALLS"], "a") as f: f.write(json.dumps({"argv": sys.argv[1:], "prompt": prompt}) + "\\n")
print(json.dumps({"type": "thread.started", "thread_id": "plan-thread"}), flush=True)
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "Codex plan v2"}}), flush=True)
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}), flush=True)
'''


def test_plan_mode_discussion_is_read_only_until_the_owner_validates(client, topic, mx, monkeypatch):
    fake, calls = mx['tmp'] / 'codex-plan', mx['tmp'] / 'codex-plan-calls.jsonl'
    fake.write_text(CODEX)
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    monkeypatch.setenv('PLAN_CODEX_CALLS', str(calls))
    codex = lambda: [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
    claude = lambda: [json.loads(line) for line in (mx['fake_dir'] / 'calls.jsonl').read_text().splitlines()]
    r = client.post('/api/sessions', json={'path': topic, 'provider': 'debate', 'message': 'Plan it NOTOOL',
                                           'plan_mode': True, 'discussion_turn_limit': 2})
    assert r.status_code == 200, r.text
    sid = r.json()['id']
    s = wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused'] and x, 30)
    assert s['plan_mode'] and s['plan_ready']                  # the latest reply holds the plan to validate
    first = claude()[0]
    assert first['argv'][first['argv'].index('--permission-mode') + 1] == 'plan'
    assert '--dangerously-skip-permissions' not in first['argv'] and 'with the other agent' in first['prompt']
    review = codex()[0]
    assert codex_sandbox(review['argv']) == 'read-only'
    assert 'Work out a plan for the user' in review['prompt']
    r = client.post(f'/api/sessions/{sid}/plan/approve', json={'text': 'Plan validated - go ahead.'})
    assert r.status_code == 200, r.text
    s = wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused'] and x['turns'] == 3 and x, 30)
    assert not s['plan_mode'] and not s['plan_ready'] and s['discussion_pause_reason'] == 'user'
    implement = claude()[-1]                                   # Claude is next after Codex: it implements Codex's plan
    assert '--permission-mode' not in implement['argv'] and 'with the other agent' not in implement['prompt']
    assert 'The user validated the plan of this discussion' in implement['prompt'] and 'Codex plan v2' in implement['prompt']
    assert len(codex()) == 1                                   # paused: the review waits for the owner
    assert client.post(f'/api/sessions/{sid}/discussion/resume').status_code == 200
    wait_for(lambda: len(codex()) == 2, 20)
    assert codex_sandbox(codex()[1]['argv']) == 'workspace-write'
    client.post(f'/api/sessions/{sid}/stop')


def test_plan_mode_can_be_switched_on_for_an_existing_discussion(client, topic):
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'discussion'}).json()['id']
    r = client.patch(f'/api/sessions/{sid}', json={'plan_mode': True})
    assert r.status_code == 200 and r.json()['plan_mode']
    assert runner.DEBATE_PLAN_PREFACE.startswith('[Plan mode is on')
