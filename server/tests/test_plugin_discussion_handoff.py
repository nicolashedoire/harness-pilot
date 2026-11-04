"""A discussion whose second agent is an agent plugin keeps it when handed off, and the plugin starts from the summary."""
from conftest import wait_for
from maxxing.sessions import store
from test_plugin_discussions import _install


def test_a_hand_off_keeps_the_plugin_partner_and_gives_it_the_summary(client, topic, mx, monkeypatch):
    calls = _install(mx, monkeypatch)
    monkeypatch.setenv('MAXXING_CODEX_BIN', str(mx['tmp'] / 'no-codex'))
    old = client.post('/api/sessions', json={'path': topic, 'provider': 'discussion', 'message': 'Partner NOTOOL',
                                             'discussion_partner': 'plugin:local-agent', 'discussion_turn_limit': 1}).json()['id']
    wait_for(lambda: (x := client.get(f'/api/sessions/{old}').json())['state'] == 'idle' and x['debate_paused'], 30)
    new = client.post(f'/api/sessions/{old}/handoff').json()             # paused on the plugin's pending reply
    assert new['discussion_partner'] == 'plugin:local-agent' and new['provider_name'] == 'Local engine'
    wait_for(lambda: store.read(old).get('archived'), 20)
    assert store.read(new['id'])['provider_capabilities'] == ['text']
    assert client.post(f"/api/sessions/{new['id']}/discussion/resume").status_code == 200
    wait_for(lambda: calls(), 20)
    request = calls()[0]
    assert request['session_id'] == new['id']
    assert request['history'][0]['text'].startswith("Context carried over from discussion 'Partner NOTOOL'")
    assert 'Context carried over' not in request['prompt']           # given once, in its history
    assert 'Latest contribution from Claude Code' in request['prompt']
    client.post(f"/api/sessions/{new['id']}/stop")
