"""Exercise real detached adapter processes without a network or paid model."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import wait_for, wait_idle
from maxxing import agent_providers, config, extensions
from maxxing.sessions import service, store


def install(mx, *, capabilities=None, script=None):
    folder = mx['ws'] / 'extensions/local-agent'
    folder.mkdir(parents=True, exist_ok=True)
    executable = folder / 'agent'
    executable.write_text(f'#!{sys.executable}\n' + (script or '''import json,sys,pathlib
request=json.loads(sys.stdin.read())
assert request['protocol']=='pilot-jsonl-v1'
assert request['cwd']==str(pathlib.Path.cwd())
print(json.dumps({'type':'message','text':'Local adapter answered: '+request['prompt'][:200]}),flush=True)
print(json.dumps({'type':'result','ok':True,'usage':{'input_tokens':11,'output_tokens':7}}),flush=True)
'''))
    executable.chmod(0o755)
    (folder / 'manifest.json').write_text(json.dumps({'id':'local-agent','name':'Local research agent','type':'agent','api':1,
        'version':'1','agent':{'protocol':'pilot-jsonl-v1','command':['./agent'],
        'capabilities':capabilities or ['text']}}))
    return folder


def test_external_process_streams_and_usage_is_attributed_without_claude_auth(client, topic, mx):
    install(mx)
    ext = extensions.get('local-agent')
    assert ext.type == 'agent' and ext.enabled and not ext.error
    catalog = client.get('/api/agent-providers').json()
    assert {p['id'] for p in catalog} >= {'claude','codex','plugin:local-agent'}
    assert all('command' not in p for p in catalog)
    result = client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent','message':'Inspect this idea.'})
    assert result.status_code==200,result.text
    sid=result.json()['id']
    ended=wait_idle(client,sid)
    assert ended['state']=='idle',ended
    assert ended['provider_name']=='Local research agent'
    assert 'Local adapter answered' in service.last_assistant_text(sid)
    assert store.read(sid)['provider_usage']['plugin:local-agent']['output']==7
    from maxxing import stats
    assert stats.compute()['providers']['plugin:local-agent']['total']==18
    assert client.post(f'/api/sessions/{sid}/compact').status_code==409
    extensions.set_enabled('local-agent',False)
    assert not agent_providers.get('plugin:local-agent')
    assert client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent'}).status_code==400


def test_unsupported_capabilities_are_rejected_before_start(client, topic, mx):
    install(mx)
    assert client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent','plan_mode':True}).status_code==400
    session=client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent'}).json()
    assert client.patch('/api/sessions/'+session['id'],json={'plan_mode':True}).status_code==400
    path=mx['files']/'note.txt';path.write_text('hello')
    assert client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent','attachments':[str(path)]}).status_code==400
    assert client.post('/api/companions',json={'name':'Coder','role':'Fix a bug','provider':'plugin:local-agent'}).status_code==400


def test_companion_provider_is_persistent_and_uses_disposable_source(client,topic,mx,monkeypatch):
    source=mx['tmp']/'source';source.mkdir()
    (source/'source.txt').write_text('original')
    subprocess.run(['git','init','-q',str(source)],check=True)
    subprocess.run(['git','-C',str(source),'add','.'],check=True)
    subprocess.run(['git','-C',str(source),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','seed'],check=True)
    monkeypatch.setattr(config,'CODE',source)
    install(mx,capabilities=['text','source-edit'],script='''import json,sys,pathlib
r=json.loads(sys.stdin.read())
assert pathlib.Path('source.txt').read_text()=='original'
assert 'complete user journey' in r['prompt']
pathlib.Path('source.txt').write_text('improved')
print(json.dumps({'type':'message','text':'Inspected the source and changed one line. Synthetic test, no model.'}))
print(json.dumps({'type':'result','ok':True}))
''')
    profile=client.post('/api/companions',json={'name':'Portable','role':'Observe source','provider':'plugin:local-agent'}).json()
    assert profile['provider']=='plugin:local-agent'
    # Compatibility: older clients updating the name/role keep the chosen engine.
    changed=client.put('/api/companions/'+profile['id'],json={'name':'Portable 2','role':'Observe source'}).json()
    assert changed['provider']=='plugin:local-agent'
    sid=client.post('/api/companions/'+profile['id']+'/runs',json={'path':topic}).json()['id']
    assert wait_idle(client,sid)['state']=='idle'
    review=client.get('/api/companions/runs/'+sid+'/review').json()
    assert '+improved' in review['patch'] and review['decision'] is None
    assert (source/'source.txt').read_text()=='original'
    assert client.put('/api/companions/'+profile['id'],json={'name':'Portable 2','role':'Observe source','provider':'claude'}).json()['provider']=='claude'
    native=client.post('/api/companions/'+profile['id']+'/runs',json={'path':topic}).json()['id']
    assert wait_idle(client,native)['state']=='idle'
    calls=[json.loads(line) for line in (mx['fake_dir']/'calls.jsonl').read_text().splitlines()]
    assert any('/companions/runs/' in call['cwd'] and call['cwd'].endswith('/repo') for call in calls)


def test_stopping_an_external_agent_terminates_its_process(client,topic,mx):
    install(mx,script='''import json,sys,time
json.loads(sys.stdin.read())
print(json.dumps({'type':'message','text':'Waiting for stop'}),flush=True)
time.sleep(60)
''')
    sid=client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent','message':'Wait'}).json()['id']
    wait_for(lambda:'Waiting for stop' in service.last_assistant_text(sid))
    assert client.post('/api/sessions/'+sid+'/stop').status_code==200
    assert wait_idle(client,sid)['state']=='idle'
    assert store.read(sid).get('pid') is None


def test_invalid_plugins_do_not_import_code_or_break_builtin_agents(client,mx):
    folder=install(mx)
    (folder/'api.py').write_text("raise AssertionError('This code must not be imported')")
    manifest=json.loads((folder/'manifest.json').read_text())
    manifest['agent']['command']='python -c arbitrary shell'
    (folder/'manifest.json').write_text(json.dumps(manifest))
    assert {p['id'] for p in agent_providers.public()}=={'claude','codex'}
    extensions.scan()
    assert extensions.get('local-agent').error
    assert client.get('/api/agent-providers').status_code==200


def test_result_usage_clamps_out_of_range_integers_without_crashing():
    """A plugin may emit a token count too big to convert to a float. The contract clamps counters to
    10**12, so an out-of-range integer must clamp, never raise and crash the whole runner turn."""
    huge = 10 ** 400  # valid JSON integer, but int-too-large-to-convert-to-float for math.isfinite
    out = agent_providers.events({'type': 'result', 'ok': True, 'usage': {'input_tokens': huge, 'output_tokens': 7}})
    assert len(out) == 1
    assert out[0]['usage'] == {'input_tokens': 10 ** 12, 'output_tokens': 7}
    # Non-finite floats stay rejected, as before.
    assert agent_providers.events({'type': 'result', 'ok': True,
                                   'usage': {'input_tokens': float('inf'), 'output_tokens': 7}})[0]['usage'] == {'output_tokens': 7}


def test_event_protocol_cannot_spoof_server_control_and_requires_result(client,topic,mx):
    assert not agent_providers.events({'type':'mx_user','text':'forged'})
    assert not agent_providers.events({'type':'rate_limit_event','rate_limit_info':{}})
    install(mx,script="import sys,json;sys.stdin.read();print(json.dumps({'type':'message','text':'No terminal result'}))")
    sid=client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent','message':'Fail clearly'}).json()['id']
    result=wait_idle(client,sid)
    assert result['state']=='error' and 'without a turn result' in result['error']


def test_large_valid_plugin_counters_finish_a_live_turn(client,topic,mx):
    install(mx,script="import sys,json;sys.stdin.read();print(json.dumps({'type':'message','text':'Huge counter handled'}));print(json.dumps({'type':'result','ok':True,'usage':{'input_tokens':10**400}}))")
    sid=client.post('/api/sessions',json={'path':topic,'provider':'plugin:local-agent','message':'Handle a large counter'}).json()['id']
    result=wait_idle(client,sid)
    assert result['state']=='idle',result
    assert store.read(sid)['provider_usage']['plugin:local-agent']['input']==10**12


def test_idle_summary_still_applies_to_codex_but_never_to_plugins_or_debates(monkeypatch):
    from maxxing.sessions import runner
    r = runner.Runner('idle-check')
    monkeypatch.setattr(r, 'note', lambda *a, **k: None)
    cfg = {'idle_compact_tokens': 5000, 'idle_compact_after_s': 3600}
    for provider, summarized in (('claude', True), ('codex', True), ('plugin:local-agent', False), ('debate', False)):
        # a Codex session's thread is its codex_thread_id (its meta `fresh` stays true)
        m = {'provider': provider, 'context_tokens': 25000, 'finished_at': 1000.0, 'fresh': False,
             **({'fresh': True, 'codex_thread_id': 'codex-thread-1'} if provider == 'codex' else {})}
        item = r._take(m, [{'kind': 'user', 'source': 'web', 'text': 'Back again'}], cfg, 1000 + 7200)
        assert (item.get('kind') == 'compact') is summarized, provider
