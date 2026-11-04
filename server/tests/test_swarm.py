import json

from conftest import all_events, wait_for, wait_idle


def test_agent_team_requests_delegation_and_preserves_agent_events(client, topic, mx):
    result = client.post('/api/sessions', json={
        'path': topic, 'provider': 'claude', 'swarm_agents': 3,
        'message': 'AGENTS Investigate three independent aspects.'})
    assert result.status_code == 200, result.text
    sid = result.json()['id']
    assert result.json()['swarm_agents'] == 3
    session = wait_idle(client, sid)
    assert session['state'] == 'idle'
    calls = [json.loads(line) for line in (mx['tmp'] / 'fake-claude' / 'calls.jsonl').read_text().splitlines()]
    assert any('delegate to 3 native Claude Code subagents using the Agent tool' in call['prompt'] and 'same assistant message' in call['prompt'] for call in calls)
    events = all_events(client, sid)
    assert any(event.get('type') == 'task' and event.get('kind') == 'agent' for event in events)
    assert [event['text'] for event in events if event.get('type') == 'user'] == ['AGENTS Investigate three independent aspects.']
    assert client.post(f'/api/sessions/{sid}/messages', json={'text': 'NOTOOL Continue.'}).status_code == 200
    assert wait_idle(client, sid)['swarm_agents'] == 3
    calls = [json.loads(line) for line in (mx['tmp'] / 'fake-claude' / 'calls.jsonl').read_text().splitlines()]
    assert 'delegate to 3 native Claude Code subagents using the Agent tool' in calls[-1]['prompt']


def test_agent_team_count_and_provider_are_checked(client, topic, mx):
    for count in (0, 1, 7, True, '3'):
        assert client.post('/api/sessions', json={'path': topic, 'swarm_agents': count}).status_code == 422
    assert client.post('/api/sessions', json={'path': topic, 'provider': 'codex', 'swarm_agents': 3}).status_code == 400
    normal = client.post('/api/sessions', json={'path': topic, 'provider': 'claude', 'message': 'NOTOOL single agent'}).json()
    assert normal['swarm_agents'] is None
    wait_idle(client, normal['id'])
    calls = [json.loads(line) for line in (mx['tmp'] / 'fake-claude' / 'calls.jsonl').read_text().splitlines()]
    assert '[Agent team requested by the user]' not in calls[-1]['prompt']


def test_stopping_agent_team_interrupts_running_turn(client, topic, monkeypatch):
    monkeypatch.setenv('FAKE_CLAUDE_AGENTS_S', '15')
    session = client.post('/api/sessions', json={'path': topic, 'swarm_agents': 2, 'message': 'AGENTS test stop'}).json()
    sid = session['id']
    wait_for(lambda: any(e.get('type') == 'task' and e.get('kind') == 'agent' for e in all_events(client, sid)))
    assert client.post(f'/api/sessions/{sid}/stop').status_code == 200
    stopped = wait_idle(client, sid)
    assert stopped['state'] != 'running' and stopped['queue'] == 0


def test_agent_team_setting_survives_handoff(client, topic):
    session = client.post('/api/sessions', json={'path': topic, 'swarm_agents': 4, 'message': 'NOTOOL test'}).json()
    wait_idle(client, session['id'])
    result = client.post(f"/api/sessions/{session['id']}/handoff")
    assert result.status_code == 200, result.text
    assert result.json()['swarm_agents'] == 4
