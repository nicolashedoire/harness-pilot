"""Mission orchestration tests use controllable sessions, never real model calls."""
import contextlib
import copy
import json
import uuid

import pytest

from maxxing import missions, companions
from maxxing.sessions import service, store


@pytest.fixture
def agents(client,monkeypatch):
    missions._stop.clear()
    sessions={};calls=[];stops=[];reports={};reviews={};keys={}
    original=store.read_cached
    monkeypatch.setattr(store,'read_cached',lambda sid: sessions.get(sid) or original(sid))
    monkeypatch.setattr(service,'get_session',lambda sid: copy.deepcopy(sessions.get(sid)))
    monkeypatch.setattr(service,'last_assistant_text',lambda sid: reports.get(sid,''))
    monkeypatch.setattr(companions,'review',lambda sid: reviews.get(sid,{'has_changes':False,'fingerprint':'a'*64}))
    monkeypatch.setattr(missions,'_find_launch',lambda key:keys.get(key))
    def run(role,path,mission,**kwargs):
        with kwargs.get('launch_guard',contextlib.nullcontext)():
            sid=str(uuid.uuid4())
            keys[kwargs['launch_key']]=sid
            sessions[sid]={'id':sid,'state':'running','turns':0,'queue':0,'tokens':{},'error':None}
            calls.append({'sid':sid,'role':role,'mission':mission,**kwargs})
        return copy.deepcopy(sessions[sid])
    def stop(sid):
        stops.append(sid)
        if sid in sessions:sessions[sid]['state']='idle'
    monkeypatch.setattr(companions,'run',run)
    monkeypatch.setattr(service,'stop',stop)
    return sessions,calls,stops,reports,reviews,run


def step(n,after=None):
    return {'id':f'step-{n}','title':f'Review {n}','role':'observer','instruction':'Inspect and test one useful improvement.','after':after or []}


def create(client,topic,steps=None,**extra):
    response=client.post('/api/missions',json={'title':'Improve the platform','path':topic,'goal':'Inspect usability and test a small improvement.','steps':steps or [],**extra})
    assert response.status_code==200,response.text
    return response.json()['id']


def start(ident):
    return missions.control(ident,'start',missions.get(ident)['plan_fingerprint'])


def finish(agents,index=0,text='Verified result'):
    sessions,calls,_,reports,_,_=agents
    sid=calls[index]['sid']
    sessions[sid].update(state='idle',turns=1)
    reports[sid]=text
    return sid


def test_draft_never_launches_and_dependencies_run_once_after_completion(client,topic,agents):
    ident=create(client,topic,[step(1),step(2,['step-1'])])
    missions.tick();assert not agents[1]
    start(ident);missions.tick();missions.tick()
    assert len(agents[1])==1
    finish(agents);missions.tick()
    assert len(agents[1])==2
    assert 'NOT applied' in agents[1][1]['mission'] and 'Verified result' in agents[1][1]['mission']
    finish(agents,1);missions.tick();missions.tick()
    assert missions.get(ident)['phase']=='completed' and len(agents[1])==2


def test_proposal_decision_gates_dependent_work_and_rejection_is_explicit(client,topic,agents):
    ident=create(client,topic,[step(1),step(2,['step-1'])])
    start(ident);missions.tick();sid=finish(agents)
    agents[4][sid]={'has_changes':True,'fingerprint':'a'*64,'decision':None}
    missions.tick();missions.tick()
    assert missions.get(ident)['steps'][0]['state']=='review' and len(agents[1])==1
    agents[4][sid]['decision']={'value':'approved','fingerprint':'b'*64}
    missions.tick();assert len(agents[1])==1
    agents[4][sid]['decision']={'value':'rejected','fingerprint':'a'*64}
    missions.tick();assert missions.get(ident)['phase']=='paused'
    missions.acknowledge(ident,'step-1');start(ident);missions.tick()
    assert len(agents[1])==2 and missions.get(ident)['steps'][0]['state']=='skipped'


def test_generated_plan_is_not_executed_until_owner_starts_it(client,topic,agents):
    ident=create(client,topic)
    missions.control(ident,'plan');missions.tick()
    assert agents[1][0]['purpose']=='plan'
    finish(agents,text='```json\n'+json.dumps({'steps':[step(1)]})+'\n```')
    missions.tick();missions.tick()
    assert missions.get(ident)['phase']=='plan_review' and len(agents[1])==1
    start(ident);missions.tick()
    assert len(agents[1])==2 and agents[1][1]['purpose']=='experiment'


def test_invalid_agent_plan_is_held_and_can_be_replaced_manually(client,topic,agents):
    ident=create(client,topic);missions.control(ident,'plan');missions.tick()
    invalid=step(1,['future-step'])
    finish(agents,text=json.dumps({'steps':[invalid]}));missions.tick()
    assert missions.get(ident)['reason']=='invalid_plan' and len(agents[1])==1
    result=client.put('/api/missions/'+ident+'/plan',json={'steps':[step(1)]})
    assert result.status_code==200,result.text
    start(ident);missions.tick()
    assert len(agents[1])==2


@pytest.mark.parametrize('limit',['tokens','time','runs'])
def test_budgets_stop_owned_sessions_or_refuse_additional_launches(client,topic,agents,limit):
    ident=create(client,topic,[step(1),step(2,['step-1'])],max_runs=1,max_tokens=100)
    start(ident);missions.tick()
    if limit=='tokens':agents[0][agents[1][0]['sid']]['tokens']={'input':101}
    if limit=='time':
        with missions._edit(ident) as data:data['active_since']-=data['max_seconds']+1
    if limit=='runs':finish(agents)
    missions.tick()
    assert missions.get(ident)['phase']=='budget' and missions.get(ident)['reason']==limit
    assert len(agents[1])==1
    if limit!='runs':assert agents[2]==[agents[1][0]['sid']]


def test_parallelism_and_finite_recurring_cycles(client,topic,agents):
    ident=create(client,topic,[step(1),step(2)],concurrent=2)
    start(ident);missions.tick();missions.tick();missions.tick()
    assert len(agents[1])==2
    missions.control(ident,'stop')
    repeat=create(client,topic,[step(1)],max_runs=2,interval_minutes=1,max_cycles=2)
    start(repeat);missions.tick();finish(agents,2);missions.tick()
    assert missions.get(repeat)['next_cycle'] is not None
    with missions._edit(repeat) as data:data['next_cycle']=0.1
    missions.tick();assert len(agents[1])==4 and missions.get(repeat)['cycle']==2
    finish(agents,3);missions.tick();missions.tick()
    assert missions.get(repeat)['phase']=='completed' and len(agents[1])==4


def test_owner_pause_during_clone_prevents_a_later_model_launch(client,topic,agents,monkeypatch):
    ident=create(client,topic,[step(1)]);start(ident)
    def pause_first(*args,**kwargs):
        missions.control(ident,'pause')
        return agents[5](*args,**kwargs)
    monkeypatch.setattr(companions,'run',pause_first)
    missions.tick();missions.tick()
    assert missions.get(ident)['phase']=='paused' and not agents[1]


def test_process_crash_after_session_creation_reconciles_without_duplicate(client,topic,agents,monkeypatch):
    ident=create(client,topic,[step(1)]);start(ident)
    def crash(*args,**kwargs):
        agents[5](*args,**kwargs)
        raise SystemExit('simulated process death')
    monkeypatch.setattr(companions,'run',crash)
    with pytest.raises(SystemExit):missions.tick()
    assert missions.get(ident)['steps'][0]['state']=='starting'
    monkeypatch.setattr(companions,'run',agents[5]);missions.tick()
    assert len(agents[1])==1 and missions.get(ident)['steps'][0]['session']==agents[1][0]['sid']


def test_restore_and_auth_validation(client,topic,agents):
    for steps in ([step(1,['step-1'])],[step(1),step(1)],[{**step(1),'role':'invented-without-owner'}]):
        assert client.post('/api/missions',json={'title':'Test','path':topic,'goal':'Observe','steps':steps}).status_code==400
    ident=create(client,topic,[step(1)]);start(ident)
    with missions._edit(ident) as data:data['origin_state']='/old/state'
    missions.tick()
    assert missions.get(ident)['phase']=='paused' and missions.get(ident)['reason']=='restored' and not agents[1]
    client.cookies.clear()
    assert client.post('/api/missions/'+ident+'/control',json={'action':'start'}).status_code==401


def test_real_runner_plans_read_only_without_editing_the_source(client,topic,mx,monkeypatch):
    import subprocess
    from conftest import wait_idle
    source=mx['tmp']/'source';source.mkdir()
    subprocess.run(['git','init','-q',str(source)],check=True)
    (source/'app.txt').write_text('original\n')
    subprocess.run(['git','-C',str(source),'add','app.txt'],check=True)
    subprocess.run(['git','-C',str(source),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','initial'],check=True)
    from maxxing import config
    monkeypatch.setattr(config,'CODE',source)
    fake=mx['tmp']/'codex'
    plan={'steps':[step(1)]}
    fake.write_text('''#!/usr/bin/env python3
import json,sys
prompt=sys.stdin.read()
assert 'read-only' in prompt and 'Do not implement it' in prompt
assert '--sandbox' in sys.argv and 'read-only' in sys.argv
assert '--dangerously-bypass-approvals-and-sandbox' not in sys.argv
print(json.dumps({'type':'thread.started','thread_id':'planner-test'}),flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':PLAN}}),flush=True)
print(json.dumps({'type':'turn.completed','usage':{}}),flush=True)
'''.replace('PLAN',repr(json.dumps(plan))))
    fake.chmod(0o755);monkeypatch.setenv('MAXXING_CODEX_BIN',str(fake))
    ident=create(client,topic)
    missions._stop.clear();missions.control(ident,'plan');missions.tick()
    sid=missions.get(ident)['planner']['session']
    session=wait_idle(client,sid)
    assert session['state']=='idle',session
    missions.tick()
    assert missions.get(ident)['phase']=='plan_review'
    assert missions.get(ident)['steps'][0]['title']=='Review 1'
    assert (source/'app.txt').read_text()=='original\n'
    assert len(missions.get(ident)['launches'])==1


def test_installation_wide_concurrency_is_bounded_across_missions(client,topic,agents):
    ids=[create(client,topic,[step(1)]) for _ in range(3)]
    for ident in ids:start(ident)
    missions.tick();missions.tick()
    assert len(agents[1])==2
    running=next(i for i in ids if missions.get(i)['steps'][0]['session'])
    missions.control(running,'pause');missions.tick()
    assert len(agents[1])==3 and len(agents[2])==1


def test_recurring_proposal_waits_for_new_source_before_repeating(client,topic,agents,monkeypatch):
    ident=create(client,topic,[step(1)],interval_minutes=1,max_cycles=2)
    start(ident);missions.tick();sid=finish(agents)
    agents[4][sid]={'has_changes':True,'fingerprint':'a'*64,'decision':{'value':'approved','fingerprint':'a'*64}}
    with missions._edit(ident) as data:data['cycle_source']='a'*40
    missions.tick()
    with missions._edit(ident) as data:data['next_cycle']=0.1
    monkeypatch.setattr(companions,'_git',lambda *args,**kwargs:('a'*40).encode())
    missions.tick()
    assert len(agents[1])==1 and missions.get(ident)['reason']=='source_unchanged'
    monkeypatch.setattr(companions,'_git',lambda *args,**kwargs:('b'*40).encode())
    missions.tick()
    assert len(agents[1])==2 and missions.get(ident)['cycle']==2


def test_start_is_bound_to_the_reviewed_plan_and_limits(client,topic,agents):
    ident=create(client,topic,[step(1)])
    reviewed=missions.get(ident)['plan_fingerprint']
    assert client.post('/api/missions/'+ident+'/control',json={'action':'start'}).status_code==409
    missions.save_plan(ident,[{**step(1),'instruction':'A different assignment.'}])
    assert client.post('/api/missions/'+ident+'/control',json={'action':'start','fingerprint':reviewed}).status_code==409
    assert not agents[1] and missions.get(ident)['phase']=='plan_review'
    current=missions.get(ident)['plan_fingerprint']
    assert client.post('/api/missions/'+ident+'/control',json={'action':'start','fingerprint':current}).status_code==200


def test_completed_mission_keeps_its_terminal_state_against_stop(client,topic,agents):
    ident=create(client,topic,[step(1)])
    start(ident);missions.tick();finish(agents);missions.tick();missions.tick()
    assert missions.get(ident)['phase']=='completed' and missions.get(ident)['reason']=='completed'
    # Owner path: stopping a finished mission must be refused like any other invalid transition (409 busy),
    # not silently regress 'completed' back to 'stopped'.
    refused=client.post('/api/missions/'+ident+'/control',json={'action':'stop'})
    assert refused.status_code==409,refused.text
    assert refused.json()['error']=='busy'
    after=missions.get(ident)
    assert after['phase']=='completed' and after['reason']=='completed'


def test_owner_can_still_stop_an_active_mission(client,topic,agents):
    ident=create(client,topic,[step(1)])
    start(ident);missions.tick()
    sid=agents[1][0]['sid']
    result=client.post('/api/missions/'+ident+'/control',json={'action':'stop'})
    assert result.status_code==200,result.text
    assert missions.get(ident)['phase']=='stopped' and missions.get(ident)['reason']=='owner'
    assert agents[2]==[sid]
    assert missions.get(ident)['steps'][0]['state']=='interrupted'




@pytest.mark.parametrize('terminal',['budget','stopped'])
def test_repeated_stop_preserves_the_terminal_reason(client,topic,agents,terminal):
    ident=create(client,topic,[step(1)],max_tokens=10)
    start(ident);missions.tick()
    if terminal=='budget':
        agents[0][agents[1][0]['sid']]['tokens']={'input':11}
        missions.tick()
    else:missions.control(ident,'stop')
    before=missions.get(ident)
    assert before['phase']==terminal
    response=client.post('/api/missions/'+ident+'/control',json={'action':'stop'})
    assert response.status_code==409
    assert missions.get(ident)['phase']==terminal and missions.get(ident)['reason']==before['reason']


def test_malformed_unicode_from_an_agent_cannot_break_persisted_plan_state(client,topic,agents):
    ident=create(client,topic);missions.control(ident,'plan');missions.tick()
    finish(agents,text=json.dumps({'steps':[{**step(1),'instruction':'Broken surrogate: \ud800'}]}))
    missions.tick();missions.tick()
    assert missions.get(ident)['phase']=='paused' and missions.get(ident)['reason']=='invalid_plan'
    assert not missions.get(ident)['steps'] and len(agents[1])==1


def test_restored_state_pauses_only_automatic_work_and_says_so(client,topic,agents):
    from maxxing import feed
    draft=create(client,topic,[step(1)])
    stopped=create(client,topic,[step(1)]);start(stopped);missions.tick();missions.control(stopped,'stop')
    active=create(client,topic,[step(1)]);start(active)
    for ident in (draft,stopped,active):
        with missions._edit(ident) as data:data['origin_state']='/old/state'
    missions.tick()
    assert missions.get(draft)['phase']=='draft' and missions.get(stopped)['phase']=='stopped'
    assert missions.get(stopped)['reason']=='owner'
    assert missions.get(active)['phase']=='paused' and missions.get(active)['reason']=='restored'
    notices=[e for e in feed.list_events()['events'] if e.get('kind')=='mission.review']
    assert [e['url'] for e in notices]==['/settings/missions?mission='+active]


def test_a_terminal_mission_cannot_be_revived_by_skipping_a_step(client,topic,agents):
    ident=create(client,topic,[step(1),step(2)])
    start(ident);missions.tick();missions.control(ident,'stop')
    assert missions.get(ident)['steps'][0]['state']=='interrupted'
    refused=client.post('/api/missions/'+ident+'/steps/step-1/skip')
    assert refused.status_code==409 and refused.json()['error']=='busy'
    assert missions.get(ident)['phase']=='stopped'
    assert client.post('/api/missions/'+ident+'/control',json={'action':'start','fingerprint':missions.get(ident)['plan_fingerprint']}).status_code==409


def test_a_deeply_nested_agent_plan_is_invalid_and_does_not_block_other_missions(client,topic,agents):
    first=create(client,topic,[step(1)])
    planned=create(client,topic);missions.control(planned,'plan');missions.tick()
    finish(agents,text='{"steps":'+'['*14000+']'*14000+'}')  # under the 30000-character cap, deeper than recursion
    start(first);missions.tick()
    assert missions.get(planned)['phase']=='paused' and missions.get(planned)['reason']=='invalid_plan'
    assert missions.get(first)['steps'][0]['state']=='running'


def test_one_failing_mission_does_not_stop_the_others(client,topic,agents,monkeypatch):
    healthy=create(client,topic,[step(1)]);start(healthy)
    broken=create(client,topic,[step(1)]);start(broken)
    assert missions.listing()[0]['id']==broken  # newest first: processed before the healthy one
    original=missions.advance
    def advance(ident):
        if ident==broken:raise RuntimeError('simulated')
        return original(ident)
    monkeypatch.setattr(missions,'advance',advance)
    missions.tick()
    assert missions.get(healthy)['steps'][0]['state']=='running'


def test_the_approval_covers_the_instructions_and_engine_of_the_roles_used(client,topic,agents):
    ident=create(client,topic,[step(1)])
    reviewed=missions.get(ident)['plan_fingerprint']
    companions.save('Platform observer','Edited instructions after the review.','observer')
    edited=missions.get(ident)['plan_fingerprint']
    assert edited!=reviewed
    assert client.post('/api/missions/'+ident+'/control',json={'action':'start','fingerprint':reviewed}).status_code==409
    companions.save('Platform observer','Edited instructions after the review.','observer','claude')
    assert missions.get(ident)['plan_fingerprint'] not in (reviewed,edited)
    companions.save('Security and dependencies','A role this plan does not use.','security')
    assert missions.get(ident)['plan_fingerprint']==missions.listing()[0]['plan_fingerprint']
    unchanged=missions.get(ident)['plan_fingerprint']
    companions.save('Security and dependencies','Another edit of the unused role.','security')
    assert missions.get(ident)['plan_fingerprint']==unchanged


def test_editing_a_role_of_an_active_mission_pauses_it_for_a_new_review(client,topic,agents):
    ident=create(client,topic,[step(1),step(2,['step-1'])])
    start(ident);missions.tick()
    sid=agents[1][0]['sid']
    companions.save('Platform observer','Different instructions.','observer')
    missions.tick()
    mission=missions.get(ident)
    assert mission['phase']=='paused' and mission['reason']=='plan_changed'
    assert agents[2]==[sid] and mission['steps'][0]['state']=='interrupted' and len(agents[1])==1
    missions.acknowledge(ident,'step-1')
    assert client.post('/api/missions/'+ident+'/control',json={'action':'start','fingerprint':mission['plan_fingerprint']}).status_code==200
    missions.tick()
    assert missions.get(ident)['phase']=='active' and len(agents[1])==2


def test_only_working_time_counts_so_a_long_interval_still_reaches_cycle_two(client,topic,agents,monkeypatch):
    clock=[1000.0];monkeypatch.setattr(missions,'_now',lambda:clock[0])
    ident=create(client,topic,[step(1)],max_minutes=1,interval_minutes=5,max_cycles=2)
    start(ident);assert missions.get(ident)['active_since'] is None  # nothing works yet
    missions.tick();assert missions.get(ident)['active_since']==1000.0
    clock[0]+=30;sid=finish(agents)
    agents[4][sid]={'has_changes':True,'fingerprint':'a'*64,'decision':None}
    missions.tick()
    mission=missions.get(ident)
    assert mission['steps'][0]['state']=='review' and mission['spent_seconds']==30 and mission['active_since'] is None
    clock[0]+=10*3600;missions.tick()  # ten hours waiting for the owner's decision
    assert missions.get(ident)['phase']=='active' and missions.get(ident)['spent_seconds']==30
    agents[4][sid]['decision']={'value':'approved','fingerprint':'a'*64}
    missions.tick()
    assert missions.get(ident)['next_cycle']==clock[0]+300
    clock[0]+=301;missions.tick()  # the 5-minute wait is longer than the 1-minute limit
    mission=missions.get(ident)
    assert mission['phase']=='active' and mission['cycle']==2 and len(agents[1])==2 and mission['spent_seconds']==30
    clock[0]+=31;missions.tick()
    assert missions.get(ident)['phase']=='budget' and missions.get(ident)['reason']=='time'
    assert agents[2]==[agents[1][1]['sid']]


def test_planning_time_counts_as_work(client,topic,agents,monkeypatch):
    clock=[50.0];monkeypatch.setattr(missions,'_now',lambda:clock[0])
    ident=create(client,topic);missions.control(ident,'plan')
    assert missions.get(ident)['active_since'] is None
    missions.tick();clock[0]+=20
    finish(agents,text=json.dumps({'steps':[step(1)]}));missions.tick()
    mission=missions.get(ident)
    assert mission['phase']=='plan_review' and mission['spent_seconds']==20 and mission['active_since'] is None
