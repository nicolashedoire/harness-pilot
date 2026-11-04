"""No real GitHub writes: a mutable API simulator exercises review, ordering and races."""
import copy

import pytest

from maxxing import pr_queue as queue
from maxxing.sessions.service import SessionError


@pytest.fixture
def github(monkeypatch,client):
    queue._stop.clear()
    pulls={}
    calls=[]
    def seed(number):
        pulls[number]={'head':str(number)*40,'base':'a'*40,'merged':False,'open':True,'draft':False,
                       'checks':'success','current_base':True,'review':'APPROVED','patch':f'diff --git a/{number}.txt b/{number}.txt\n+change\n'}
    for n in (1,2,3):seed(n)
    def api(path,*,method='GET',body=None,diff=False):
        calls.append((path,method,copy.deepcopy(body)))
        number=int(path.split('/pulls/')[1].split('/')[0].split('?')[0]) if '/pulls/' in path else None
        if number:
            p=pulls[number]
            if method=='PUT':
                assert path.endswith('/merge') and body['sha']==p['head']
                p['merged']=True
                return {'merged':True,'sha':'b'*40}
            if path.endswith('/reviews?per_page=100'):
                return [{'user':{'id':1},'state':p['review']}]
            if diff:return p['patch']
            return {'head':{'sha':p['head']},'base':{'sha':p['base'],'ref':'main','repo':{'full_name':'acme/app'}},
                    'title':f'Change {number}','body':'Test proposal','state':'open' if p['open'] else 'closed',
                    'draft':p['draft'],'merged':p['merged'],'merge_commit_sha':'b'*40 if p['merged'] else None,
                    'mergeable':True,'mergeable_state':'clean'}
        p=next(p for p in pulls.values() if p['head'] in path)
        if '/compare/' in path:
            # The live target branch, never the pull request's base.sha (GitHub leaves it stale when main moves).
            assert '/compare/main...' in path,path
            return {'status':'ahead' if p['current_base'] else 'diverged','behind_by':0 if p['current_base'] else 1}
        if '/check-runs?' in path:
            return {'total_count':0,'check_runs':[]} if p['checks']=='none' else {'total_count':1,'check_runs':[{'status':'in_progress' if p['checks']=='pending' else 'completed','conclusion':p['checks']}]}
        if path.endswith('/status?per_page=100'):return {'total_count':0,'statuses':[]}
        raise AssertionError(path)
    monkeypatch.setattr(queue,'_api',api)
    return pulls,calls,api


def add(client,n,dependencies=None):
    response=client.post('/api/pr-queue',json={'url':f'https://github.com/acme/app/pull/{n}','dependencies':dependencies or []})
    assert response.status_code==200,response.text
    return response.json()['id']


def approve(client,ident):
    p=client.get('/api/pr-queue/'+ident+'/preview')
    assert p.status_code==200,p.text
    result=client.post('/api/pr-queue/'+ident+'/approve',json={'fingerprint':p.json()['fingerprint']})
    assert result.status_code==200,result.text


def item(ident):
    return next(i for i in queue.state()['items'] if i['id']==ident)


def writes(calls):return [call for call in calls if call[1]=='PUT']


def test_queue_requires_owner_review_and_is_paused_initially(client,github):
    _,calls,_=github
    ident=add(client,1)
    assert queue.state()['paused'] is True
    queue.tick(force=True)
    assert not writes(calls)
    approve(client,ident)
    queue.tick(force=True)
    assert item(ident)['reason']=='paused' and not writes(calls)
    assert client.put('/api/pr-queue/pause',json={'paused':False}).status_code==200
    queue.tick(force=True)
    assert item(ident)['state']=='merged'
    assert writes(calls)[0][2]=={'sha':'1'*40,'merge_method':'merge'}


def test_cross_session_dependencies_integrate_in_order_and_require_current_base(client,github):
    pulls,calls,_=github
    first=add(client,1)
    second=add(client,2,[first])
    # Review cannot silently approve an unreviewed prerequisite.
    preview=client.get('/api/pr-queue/'+second+'/preview').json()
    assert client.post('/api/pr-queue/'+second+'/approve',json={'fingerprint':preview['fingerprint']}).status_code==409
    approve(client,first);approve(client,second)
    pulls[2]['current_base']=False
    queue.pause(False);queue.tick(force=True)
    assert item(first)['state']=='merged'
    assert item(second)['reason']=='base_changed'
    assert len(writes(calls))==1
    # Normal merge of main into the branch changes its head, so its old approval is invalid.
    pulls[2].update(head='c'*40,current_base=True)
    queue.tick(force=True)
    assert item(second)['approval'] is None and not pulls[2]['merged']
    approve(client,second);queue.tick(force=True)
    assert pulls[2]['merged'] and len(writes(calls))==2


@pytest.mark.parametrize(('field','value','reason'),[('checks','failure','checks_failed'),('checks','pending','checks_pending'),('checks','none','no_checks'),('review','CHANGES_REQUESTED','changes_requested')])
def test_checks_and_requested_changes_cannot_be_bypassed(client,github,field,value,reason):
    pulls,calls,_=github
    ident=add(client,1);approve(client,ident)
    pulls[1][field]=value
    queue.pause(False);queue.tick(force=True)
    assert item(ident)['reason']==reason and not writes(calls)


def test_read_only_refresh_never_merges_even_when_approved_and_running(client,github):
    _,calls,_=github
    ident=add(client,1);approve(client,ident);queue.pause(False)
    assert client.post('/api/pr-queue/refresh').status_code==200
    assert item(ident)['reason']=='ready' and not writes(calls)


def test_changed_head_or_diff_requires_a_new_review(client,github):
    pulls,calls,_=github
    ident=add(client,1)
    reviewed=client.get('/api/pr-queue/'+ident+'/preview').json()
    pulls[1]['patch']+='different\n'
    assert client.post('/api/pr-queue/'+ident+'/approve',json={'fingerprint':reviewed['fingerprint']}).status_code==409
    approve(client,ident);queue.pause(False)
    pulls[1]['head']='c'*40
    queue.tick(force=True)
    assert item(ident)['approval'] is None and not writes(calls)


def test_pause_or_cancel_during_checks_wins_over_stale_worker_state(client,github,monkeypatch):
    _,calls,api=github
    ident=add(client,1);approve(client,ident);queue.pause(False)
    def pausing(path,**kwargs):
        if '/compare/' in path:queue.pause(True)
        return api(path,**kwargs)
    monkeypatch.setattr(queue,'_api',pausing)
    queue.tick(force=True)
    assert not writes(calls)
    queue.pause(False)
    def cancelling(path,**kwargs):
        if '/compare/' in path:queue.cancel(ident)
        return api(path,**kwargs)
    monkeypatch.setattr(queue,'_api',cancelling)
    queue.tick(force=True)
    assert item(ident)['state']=='cancelled' and not writes(calls)


def test_remote_merge_is_reconciled_after_a_local_write_crash(client,github,monkeypatch):
    _,calls,_=github
    ident=add(client,1);approve(client,ident);queue.pause(False)
    original=queue._record
    def crash_once(ident,**values):
        if values.get('state')=='merged':raise OSError('simulated crash after remote acceptance')
        return original(ident,**values)
    monkeypatch.setattr(queue,'_record',crash_once)
    with pytest.raises(OSError):queue.tick(force=True)
    assert item(ident)['state']=='merging' and len(writes(calls))==1
    monkeypatch.setattr(queue,'_record',original)
    queue.tick(force=True)
    assert item(ident)['state']=='merged' and len(writes(calls))==1


def test_targets_dependencies_and_auth_are_validated(client,github):
    for url in ('http://github.com/acme/app/pull/1','https://github.com.evil.test/acme/app/pull/1','https://github.com/acme/../pull/1'):
        response=client.post('/api/pr-queue',json={'url':url})
        assert response.status_code==400
    assert client.post('/api/pr-queue',json={'url':'https://github.com/acme/app/pull/1','dependencies':['missing']}).status_code==404
    ident=add(client,1)
    assert client.post('/api/pr-queue',json={'url':'https://github.com/acme/app/pull/1'}).status_code==409
    client.cookies.clear()
    assert client.get('/api/pr-queue/'+ident+'/preview').status_code==401


def test_target_commit_changes_invalidate_approval_even_if_head_is_unchanged(client,github):
    pulls,calls,_=github
    ident=add(client,1);approve(client,ident);queue.pause(False)
    pulls[1]['base']='d'*40
    queue.tick(force=True)
    assert item(ident)['reason']=='changed' and item(ident)['approval'] is None
    assert not writes(calls)


def test_ambiguous_inflight_merge_is_never_automatically_retried(client,github):
    _,calls,_=github
    ident=add(client,1);approve(client,ident);queue.pause(False)
    queue._record(ident,state='merging',reason='github_pending')
    queue.tick(force=True)
    assert item(ident)['reason']=='github_pending' and not writes(calls)


def test_cancelled_entry_cannot_emit_a_stale_merge_notification(client,github,monkeypatch):
    pulls,_,api=github
    ident=add(client,1)
    notifications=[]
    monkeypatch.setattr(queue,'_notify',lambda *args:notifications.append(args))
    def cancel_on_read(path,**kwargs):
        value=api(path,**kwargs)
        queue.cancel(ident)
        return value
    pulls[1]['merged']=True
    monkeypatch.setattr(queue,'_api',cancel_on_read)
    queue.tick(force=True)
    assert item(ident)['state']=='cancelled' and not notifications


def test_refresh_batches_rotate_without_starvation(client,github,monkeypatch):
    for n in (1,2,3):add(client,n)
    seen=[]
    monkeypatch.setattr(queue,'BATCH_SIZE',2)
    original=queue._process
    def observe(ident,**kwargs):
        seen.append(ident)
        return original(ident,**kwargs)
    monkeypatch.setattr(queue,'_process',observe)
    queue.tick(force=True)
    assert len(seen)==2
    first=set(seen)
    queue.tick(force=True)
    assert len(seen)==4 and set(seen)!=first


def test_head_race_at_github_is_pinned_and_not_automatically_retried(client,github,monkeypatch):
    pulls,calls,api=github
    ident=add(client,1);approve(client,ident);queue.pause(False)
    def moving(path,**kwargs):
        if kwargs.get('method')=='PUT':
            assert kwargs['body']['sha']=='1'*40
            pulls[1]['head']='c'*40
            raise SessionError(502,'github_conflict','Head changed')
        return api(path,**kwargs)
    monkeypatch.setattr(queue,'_api',moving)
    queue.tick(force=True)
    assert item(ident)['state']=='merge_failed'
    queue.tick(force=True)
    assert item(ident)['state']=='awaiting_review' and item(ident)['approval'] is None
    assert not writes(calls)


def test_cli_transport_uses_json_stdin_no_shell_and_bounds_wait(client,monkeypatch):
    import json
    import subprocess
    seen=[]
    def run(command,**kwargs):
        seen.append((command,kwargs))
        kwargs['stdout'].write(b'{"ok":true}')
        return subprocess.CompletedProcess(command,0,stderr=b'')
    monkeypatch.setattr(queue.subprocess,'run',run)
    assert queue._api('repos/acme/app/pulls/1')['ok'] is True
    queue._api('repos/acme/app/pulls/1/merge',method='PUT',body={'sha':'a'*40,'merge_method':'squash'})
    assert seen[0][1]['stdin']==subprocess.DEVNULL
    assert json.loads(seen[1][1]['input'])['sha']=='a'*40
    assert seen[1][1]['timeout']==20 and not seen[1][1].get('shell')


def test_worker_stops_and_restarts_without_losing_queue(client,github,monkeypatch):
    import asyncio
    ident=add(client,1)
    monkeypatch.setenv('MAXXING_PR_QUEUE_WORKER','1')
    async def lifecycle():
        await queue.startup()
        first=queue._task
        await queue.shutdown()
        assert first.done() and queue._stop.is_set()
        await queue.startup()
        assert queue._task is not first and not queue._stop.is_set()
        await queue.shutdown()
    asyncio.run(lifecycle())
    queue._stop.clear()
    assert item(ident)['state']=='awaiting_review'


def test_restored_queue_cannot_reuse_approvals_from_another_installation(client,github):
    from maxxing import config
    ident=add(client,1);approve(client,ident);queue.pause(False)
    state=config.read_json(queue._dir()/'queue.json')
    state['origin_state']='/another/installation/state'
    config.write_json(queue._dir()/'queue.json',state)
    assert queue.state()['paused'] is True
    assert item(ident)['approval'] is None and item(ident)['state']=='awaiting_review'
    queue.tick(force=True)
    assert queue.state()['paused'] is True and not writes(github[1])


def test_github_incomplete_diff_is_not_presented_as_a_review(client,monkeypatch):
    import subprocess
    def too_large(command,**kwargs):
        return subprocess.CompletedProcess(command,1,stderr=b'diff exceeds 300 files (HTTP 406)')
    monkeypatch.setattr(queue.subprocess,'run',too_large)
    with pytest.raises(SessionError) as error:
        queue._api('repos/acme/app/pulls/1',diff=True)
    assert error.value.code=='too_large' and error.value.status==413
