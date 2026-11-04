"""Plan mode in a discussion whose second agent is an agent plugin: allowed only when it declares `plan`, and its
read-only turns get the discussion's plan preface."""
from conftest import wait_for
from maxxing.sessions import runner
from test_plugin_discussions import _install


def _paused(client, sid, **extra):
    return wait_for(lambda: (x := client.get(f'/api/sessions/{sid}').json())['state'] == 'idle' and x['debate_paused']
                    and all(x[k] == v for k, v in extra.items()) and x, 30)


def test_a_plugin_with_plan_debates_the_plan_read_only_then_reviews(client, topic, mx, monkeypatch):
    calls = _install(mx, monkeypatch, capabilities=('text', 'plan'))
    r = client.post('/api/sessions', json={'path': topic, 'provider': 'debate', 'message': 'Plan NOTOOL', 'plan_mode': True,
                                           'discussion_partner': 'plugin:local-agent', 'discussion_turn_limit': 2})
    assert r.status_code == 200, r.text
    sid = r.json()['id']
    assert _paused(client, sid)['plan_ready']
    plan = calls()[0]
    assert plan['permission_mode'] == 'plan' and plan['prompt'].startswith(runner.DEBATE_PLAN_PREFACE)
    assert client.post(f'/api/sessions/{sid}/plan/approve', json={'text': 'Go.'}).status_code == 200
    _paused(client, sid, turns=3)                              # Claude implemented, the plugin's review waits
    assert len(calls()) == 1
    assert client.post(f'/api/sessions/{sid}/discussion/resume').status_code == 200
    wait_for(lambda: len(calls()) == 2, 20)
    review = calls()[1]
    assert review['permission_mode'] != 'plan' and not review['prompt'].startswith('[Plan mode is on')
    client.post(f'/api/sessions/{sid}/stop')


def test_a_plugin_without_plan_is_refused_for_plan_mode(client, topic, mx, monkeypatch):
    _install(mx, monkeypatch)                                  # text only
    body = {'path': topic, 'provider': 'discussion', 'discussion_partner': 'plugin:local-agent'}
    r = client.post('/api/sessions', json={**body, 'plan_mode': True})
    assert r.status_code == 400 and "does not declare the 'plan' capability" in r.json()['message']
    sid = client.post('/api/sessions', json=body).json()['id']
    r = client.patch(f'/api/sessions/{sid}', json={'plan_mode': True})
    assert r.status_code == 400 and 'cannot join a discussion in plan mode' in r.json()['message']
