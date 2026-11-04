"""Exercise Codex selection, event translation and continuation through the sessions API."""
import json

import pytest

from conftest import all_events, wait_idle
from maxxing.sessions import codex


def test_codex_session_resumes_its_own_thread(client, topic, mx, monkeypatch):
    fake = mx['tmp'] / 'codex'
    calls = mx['tmp'] / 'codex-calls.jsonl'
    fake.write_text('''#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
with open(os.environ["FAKE_CODEX_CALLS"], "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "prompt": prompt}) + "\\n")
print(json.dumps({"type": "thread.started", "thread_id": "codex-thread-123"}), flush=True)
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "Codex: " + prompt.splitlines()[-1]}}), flush=True)
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}), flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    monkeypatch.setenv('FAKE_CODEX_CALLS', str(calls))
    response = client.post('/api/sessions', json={'path': topic, 'provider': 'codex', 'message': 'premier'})
    assert response.status_code == 200, response.text
    sid = response.json()['id']
    session = wait_idle(client, sid)
    assert session['provider'] == 'codex' and session['state'] == 'idle'
    assert session['last_text'] == 'Codex: premier'
    assert client.post(f'/api/sessions/{sid}/messages', json={'text': 'deuxième'}).status_code == 200
    session = wait_idle(client, sid)
    assert session['turns'] == 2 and session['last_text'] == 'Codex: deuxième'
    requests = [json.loads(line) for line in calls.read_text().splitlines()]
    assert 'resume' not in requests[0]['argv']
    assert 'Shared workspace and topic instructions/memory' in requests[0]['prompt']
    assert requests[1]['argv'][requests[1]['argv'].index('resume') + 1] == 'codex-thread-123'
    assert [e['text'] for e in all_events(client, sid) if e['type'] == 'assistant'] == ['Codex: premier', 'Codex: deuxième']
    assert client.post(f'/api/sessions/{sid}/ask', json={'question': 'test'}).status_code == 409


def test_codex_sandbox_and_events():
    assert codex.command('', 'default')[codex.command('', 'default').index('--sandbox') + 1] == 'read-only'
    assert codex.command('', 'bypass')[codex.command('', 'bypass').index('--sandbox') + 1] == 'workspace-write'
    command = codex.events({'type': 'item.completed', 'item': {'id': 'item-1', 'type': 'command_execution',
                           'command': 'pwd', 'aggregated_output': '/tmp', 'exit_code': 0}})
    assert command[0]['message']['content'][0]['id'] == command[1]['message']['content'][0]['tool_use_id']
    assert codex.events({'type': 'turn.failed', 'error': {'message': 'auth failed'}})[0]['is_error']
    usage = codex.events({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 40,
                          'cache_write_input_tokens': 10, 'output_tokens': 7}})[0]['usage']
    assert usage == {'input_tokens': 50, 'output_tokens': 7, 'cache_read_input_tokens': 40,
                     'cache_creation_input_tokens': 10}


def test_codex_status_reports_login_without_exposing_cli_output(client, monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setenv('MAXXING_CODEX_BIN', '/fake/codex')
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(codex.subprocess, 'run', run)
    result = client.get('/api/system/codex').json()
    assert result == {'installed': True, 'authenticated': True, 'reason': None}
    # subprocess.run is patched process-wide: the app's background tasks may record their own calls too.
    mine = [call for call in calls if call[0] and call[0][0] == '/fake/codex']
    assert mine and all(call[0][-2:] == ['login', 'status'] for call in mine)
    assert 'analytics.enabled=false' in mine[0][0] and 'otel.exporter="none"' in mine[0][0]
    assert mine[0][1]['stdout'] == codex.subprocess.DEVNULL and mine[0][1]['stderr'] == codex.subprocess.DEVNULL


def test_workspace_context_does_not_follow_files_outside_workspace(tmp_path):
    root = tmp_path / 'workspace'
    topic = root / 'project' / 'topic'
    topic.mkdir(parents=True)
    (root / 'memory.md').write_text('shared memory')
    outside = tmp_path / 'private.txt'
    outside.write_text('should not be read')
    (topic / 'memory.md').symlink_to(outside)
    context = codex.workspace_context(root, topic)
    assert 'shared memory' in context and 'should not be read' not in context


@pytest.mark.parametrize(('provider', 'expected'), [('debate', 'Challenge their reasoning'), ('discussion', 'Build on their ideas')])
def test_debate_alternates_and_stop_clears_automatic_turns(client, topic, mx, monkeypatch, provider, expected):
    from conftest import wait_for
    import time
    fake = mx['tmp'] / 'codex-debate'
    prompts = mx['tmp'] / 'debate-prompts'
    monkeypatch.setenv('DEBATE_PROMPTS', str(prompts))
    fake.write_text('''#!/usr/bin/env python3
import json, sys, time, os
prompt = sys.stdin.read()
with open(os.environ["DEBATE_PROMPTS"], "a") as f: f.write(json.dumps(prompt) + "\\n")
print(json.dumps({"type":"thread.started","thread_id":"codex-debate-thread"}), flush=True)
time.sleep(0.25)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"Une réponse de Codex."}}), flush=True)
print(json.dumps({"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}), flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    response = client.post('/api/sessions', json={'path': topic, 'provider': provider, 'message': 'Un sujet NOTOOL'})
    assert response.status_code == 200, response.text
    sid = response.json()['id']
    wait_for(lambda: client.get(f'/api/sessions/{sid}').json()['turns'] >= 3, timeout=25)
    assert client.post(f'/api/sessions/{sid}/stop').status_code == 200
    stopped = wait_idle(client, sid)
    count = stopped['turns']
    time.sleep(0.6)
    assert client.get(f'/api/sessions/{sid}').json()['turns'] == count
    events = all_events(client, sid)
    labels = [e['text'] for e in events if e['type'] == 'note' and e['text'] in ('Claude Code', 'Codex')]
    assert labels[:3] == ['Claude Code', 'Codex', 'Claude Code']
    assert expected in json.loads(prompts.read_text().splitlines()[0])
    assert len([e for e in events if e['type'] == 'user']) == 1


def test_macos_keychain_claude_status_is_recognised(mx, monkeypatch):
    from types import SimpleNamespace
    from maxxing import claude_auth
    monkeypatch.setattr(claude_auth.sys, 'platform', 'darwin')
    monkeypatch.setattr(claude_auth.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout='{"loggedIn":true,"email":"private@example.invalid"}'))
    claude_auth._mac_status_cache.clear()
    method, detail = claude_auth.auth_method()
    assert method == 'credentials' and 'private@example.invalid' not in detail


@pytest.mark.asyncio
async def test_telegram_receives_automatic_turn_only_after_user_links_conversation(mx, monkeypatch):
    from maxxing.telegram import gateway
    g = gateway.Gateway('123456:fake')
    sent = []
    async def capture(sid, session, result, chat, thread, silent=False):
        sent.append((sid, chat, thread, session['last_turn']['agent']))
    monkeypatch.setattr(gateway, 'tg_config', lambda: {'chat_id': 123})
    monkeypatch.setattr(gateway, 'thread_of', lambda sid: 456)
    monkeypatch.setattr(g, '_answer', capture)
    monkeypatch.setattr(gateway, 'mirror_web', lambda *a: False)
    session = {'id': 's1', 'provider': 'discussion', 'source': 'web', 'last_turn': {'kind': 'debate', 'agent': 'codex'}}
    await g.on_turn_end(session, None)
    assert sent == []
    await g.on_turn_end({**session, 'debate_telegram': True}, None)
    assert sent == [('s1', 123, 456, 'codex')]


def test_pause_resume_keeps_next_agent_and_stop_discards_it(client, topic, mx, monkeypatch):
    from conftest import wait_for
    import time
    fake = mx['tmp'] / 'codex-pause'
    fake.write_text('''#!/usr/bin/env python3
import json, sys, time
sys.stdin.read()
print(json.dumps({"type":"thread.started","thread_id":"codex-paused-thread"}), flush=True)
time.sleep(.2)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"Suite Codex"}}), flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}), flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    s = client.post('/api/sessions', json={'path': topic, 'provider': 'discussion', 'message': 'PAUSE NOTOOL'}).json()
    sid = s['id']
    wait_for(lambda: any(e.get('text') == 'Claude Code' for e in all_events(client, sid)), 10)
    assert client.post(f'/api/sessions/{sid}/discussion/pause').status_code == 200
    wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused'], 10)
    n = client.get(f'/api/sessions/{sid}').json()['turns']
    time.sleep(.5)
    assert client.get(f'/api/sessions/{sid}').json()['turns'] == n
    assert client.post(f'/api/sessions/{sid}/discussion/resume').status_code == 200
    wait_for(lambda: any(e.get('text') == 'Suite Codex' for e in all_events(client, sid)), 10)
    client.post(f'/api/sessions/{sid}/stop')
    assert not wait_idle(client, sid)['debate_paused']


def test_interrupt_for_human_keeps_automatic_discussion_active(client, topic, mx, monkeypatch):
    from conftest import wait_for
    fake = mx['tmp'] / 'codex-steer'
    fake.write_text('''#!/usr/bin/env python3
import json,sys,time
sys.stdin.read()
print(json.dumps({"type":"thread.started","thread_id":"steer-thread"}),flush=True)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"Codex prend le relais"}}),flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}),flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    s = client.post('/api/sessions', json={'path': topic, 'provider': 'debate', 'message': 'SLOW NOTOOL'}).json()
    sid = s['id']
    wait_for(lambda: any(e.get('text') == 'Claude Code' for e in all_events(client, sid)), 10)
    assert client.post(f'/api/sessions/{sid}/messages', json={'text': 'Nouvelle consigne NOTOOL'}).status_code == 200
    assert client.post(f'/api/sessions/{sid}/steer').json()['steered']
    wait_for(lambda: any(e.get('text') == 'Codex prend le relais' for e in all_events(client, sid)), 20)
    client.post(f'/api/sessions/{sid}/stop')


def test_reply_limit_pauses_and_resume_starts_a_new_period(client, topic, mx, monkeypatch):
    from conftest import wait_for
    fake = mx['tmp'] / 'codex-limit'
    fake.write_text('''#!/usr/bin/env python3
import json,sys
sys.stdin.read()
print(json.dumps({"type":"thread.started","thread_id":"limit-thread"}),flush=True)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"Réponse limitée"}}),flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}),flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    s = client.post('/api/sessions', json={'path': topic, 'provider': 'discussion', 'message': 'NOTOOL', 'discussion_turn_limit': 1}).json()
    sid = s['id']
    wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused'], 10)
    s = client.get(f'/api/sessions/{sid}').json()
    assert s['discussion_turns'] == 1 and s['discussion_pause_reason'] == 'limit'
    assert client.post(f'/api/sessions/{sid}/discussion/resume').status_code == 200
    wait_for(lambda: any(e.get('text') == 'Réponse limitée' for e in all_events(client, sid)), 10)
    wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused'], 10)
    assert client.get(f'/api/sessions/{sid}').json()['discussion_turns'] == 1
    assert client.post('/api/sessions', json={'path': topic, 'provider': 'debate', 'discussion_turn_limit': 201}).status_code == 422


def test_duration_limit_pauses_after_current_reply(client, topic, mx):
    from conftest import wait_for
    from maxxing.sessions import store
    import time
    s = client.post('/api/sessions', json={'path': topic, 'provider': 'debate', 'message': 'PAUSE NOTOOL', 'discussion_duration_seconds': 60}).json()
    sid = s['id']
    wait_for(lambda: any(e.get('text') == 'Claude Code' for e in all_events(client, sid)), 10)
    store.update(sid, discussion_started=time.time() - 61)
    wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused'], 10)
    assert client.get(f'/api/sessions/{sid}').json()['discussion_pause_reason'] == 'limit'


def test_discussion_roles_reach_the_corresponding_agents(client, topic, mx, monkeypatch):
    from conftest import wait_for
    fake = mx['tmp'] / 'codex-roles'
    prompts = mx['tmp'] / 'codex-role-prompts'
    monkeypatch.setenv('ROLE_PROMPTS', str(prompts))
    fake.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["ROLE_PROMPTS"], "a") as f: f.write(json.dumps({"prompt": sys.stdin.read(), "argv": sys.argv[1:]}) + "\\n")
print(json.dumps({"type":"thread.started","thread_id":"role-thread"}), flush=True)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"Review"}}), flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}), flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    s = client.post('/api/sessions', json={'path': topic, 'provider': 'discussion', 'message': 'NOTOOL',
                    'discussion_turn_limit': 2, 'claude_role': 'PROPOSER ROLE', 'codex_role': 'REVIEWER ROLE',
                    'model': 'claude-test-model', 'codex_model': 'codex-test-model'}).json()
    wait_for(lambda: (x := client.get(f"/api/sessions/{s['id']}").json())['state'] == 'idle' and x['debate_paused'], 20)
    claude_calls = [json.loads(line) for line in (mx['fake_dir'] / 'calls.jsonl').read_text().splitlines()]
    assert 'PROPOSER ROLE' in claude_calls[0]['prompt'] and 'REVIEWER ROLE' not in claude_calls[0]['prompt']
    codex_call = json.loads(prompts.read_text().splitlines()[0])
    assert 'REVIEWER ROLE' in codex_call['prompt']
    assert codex_call['argv'][codex_call['argv'].index('--model') + 1] == 'codex-test-model'
    assert claude_calls[0]['argv'][claude_calls[0]['argv'].index('--model') + 1] == 'claude-test-model'


def test_discussion_preset_save_list_delete_and_validation(client):
    assert client.post('/api/discussion-presets', json={'name': '  '}).status_code == 422
    assert client.post('/api/discussion-presets', json={'name': 'x', 'claude_role': 'a' * 2001}).status_code == 422
    result = client.post('/api/discussion-presets', json={'name': 'Équipe', 'claude_role': 'Proposer', 'codex_role': 'Vérifier'})
    assert result.status_code == 200
    saved = result.json()
    assert client.get('/api/discussion-presets').json() == [saved]
    assert client.delete(f"/api/discussion-presets/{saved['id']}").json() == {'ok': True}
    assert client.get('/api/discussion-presets').json() == []


def _claude_json(tmp_path, monkeypatch, data):
    own = tmp_path / 'claude-config'
    own.mkdir(exist_ok=True)
    (own / '.claude.json').write_text(json.dumps(data))
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(own))       # read like Settings -> MCP and Claude's turns
    monkeypatch.setenv('MAXXING_CODEX_MCP', '1')            # conftest turns it off everywhere else
    return own


def test_mcp_servers_are_given_to_codex_without_secrets_on_the_command_line(tmp_path, monkeypatch):
    folder = tmp_path / 'ws' / 'projects' / 'acme' / 'topics' / 'ads'
    folder.mkdir(parents=True)
    _claude_json(tmp_path, monkeypatch, {
        'mcpServers': {
            'acme': {'command': 'npx', 'args': ['-y', '@acme/mcp', '--region=${REGION:-eu}'],
                     'env': {'LOG_LEVEL': 'debug', 'ACME_KEY': '${VAULT_ACME}'}},
            'legacy': {'type': 'sse', 'url': 'https://sse.example.com/sse'},
            'keyed': {'type': 'http', 'url': 'https://mcp.example.com/mcp?key=a1b2c3d4e5f6g7h8i9j0k1'},
            'dotted.name': {'command': 'tool'},
            'pathy': {'command': 'tool', 'env': {'PATH': '${VAULT_ACME}'}},
            'missing': {'command': 'tool', 'env': {'TOKEN': '${NOT_SET}'}},
            'argkey': {'command': 'tool', 'args': ['--token', '${VAULT_ACME}']},
        },
        'projects': {str(folder): {'mcpServers': {
            'ads': {'type': 'http', 'url': 'https://ads.example.com/mcp',
                    'headers': {'Authorization': 'Bearer ${ADS_TOKEN}', 'Content-Type': 'application/json'}}}}},
    })
    from maxxing.sessions import spawn
    monkeypatch.setattr(spawn, '_exposed_vault', lambda s: {'VAULT_ACME': 'acme-secret-123456'})
    env = {'ADS_TOKEN': 'ads-secret-987654'}
    args, extra, skipped = codex.mcp_config(str(folder), env)
    tables = {a.split('=', 1)[0]: a.split('=', 1)[1] for a in args[1::2]}
    assert set(tables) == {'mcp_servers.acme', 'mcp_servers.ads', 'shell_environment_policy.exclude'}
    assert tables['mcp_servers.acme'] == ('{command = "npx", args = ["-y", "@acme/mcp", "--region=eu"], '
                                          'env = {LOG_LEVEL = "debug"}, env_vars = ["ACME_KEY"]}')
    assert tables['mcp_servers.ads'] == ('{url = "https://ads.example.com/mcp", env_http_headers = '
                                         '{Authorization = "MAXXING_MCP_H0"}, http_headers = {Content-Type = "application/json"}}')
    assert extra == {'ACME_KEY': 'acme-secret-123456', 'MAXXING_MCP_H0': 'Bearer ads-secret-987654'}
    assert not any('secret' in a for a in args)                 # secrets go through the environment only
    assert tables['shell_environment_policy.exclude'] == '["ACME_KEY", "MAXXING_MCP_H0"]'
    reasons = dict(skipped)
    assert set(reasons) == {'legacy', 'keyed', 'dotted.name', 'pathy', 'missing', 'argkey'}
    assert 'arguments' in reasons['argkey']
    assert 'sse' in reasons['legacy'] and 'address' in reasons['keyed'] and '${NOT_SET}' in reasons['missing']


def test_a_codex_turn_gets_the_mcp_servers_and_says_which_are_left_out(client, topic, mx, monkeypatch):
    from maxxing import workspace
    folder = workspace.topic_dir(topic)
    _claude_json(mx['tmp'], monkeypatch, {
        'mcpServers': {'acme': {'command': 'npx', 'args': ['-y', '@acme/mcp'], 'env': {'ACME_KEY': '${ACME_SECRET}'}},
                       'legacy': {'type': 'sse', 'url': 'https://sse.example.com/sse'}},
        'projects': {str(folder): {'disabledMcpServers': []}},
    })
    monkeypatch.setenv('ACME_SECRET', 'turn-secret-42')
    fake = mx['tmp'] / 'codex-mcp'
    calls = mx['tmp'] / 'codex-mcp-calls.jsonl'
    fake.write_text(f'''#!/usr/bin/env python3
import json, os, sys
sys.stdin.read()
with open({str(calls)!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "acme": os.environ.get("ACME_KEY")}}) + "\\n")
print(json.dumps({{"type": "thread.started", "thread_id": "t-mcp"}}), flush=True)
print(json.dumps({{"type": "item.completed", "item": {{"type": "agent_message", "text": "ok"}}}}), flush=True)
print(json.dumps({{"type": "turn.completed", "usage": {{"input_tokens": 1, "output_tokens": 1}}}}), flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(fake))
    sid = client.post('/api/sessions', json={'path': topic, 'provider': 'codex', 'message': 'go'}).json()['id']
    wait_idle(client, sid)
    call = json.loads(calls.read_text().splitlines()[-1])
    assert 'mcp_servers.acme={command = "npx", args = ["-y", "@acme/mcp"], env_vars = ["ACME_KEY"]}' in call['argv']
    assert call['argv'].index('--ignore-user-config') < call['argv'].index('mcp_servers.acme={command = "npx", args = ["-y", "@acme/mcp"], env_vars = ["ACME_KEY"]}')
    assert call['acme'] == 'turn-secret-42' and not any('turn-secret' in a for a in call['argv'])
    notes = [e['text'] for e in all_events(client, sid) if e['type'] == 'note']
    assert any('MCP servers not given to Codex: legacy' in n for n in notes)
