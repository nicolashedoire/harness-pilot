"""Interactive companion review through the gateway and fake Telegram; never a real token or agent call."""
from __future__ import annotations

from copy import deepcopy

import pytest

from _conn_helpers import mx_state, wait_for  # noqa: F401
from maxxing import feed
from maxxing.telegram import gateway, reviews
from test_telegram import TOPIC, _link, _open, api, svc, tg, ws  # noqa: F401


@pytest.fixture
async def proposal(api, tg, svc, monkeypatch):
    await _link(api, tg)
    sid, tid = await _open(api, svc)
    result = {'session': deepcopy(svc.sessions[sid]), 'fingerprint': 'a' * 64,
              'patch': 'diff --git a/example.py b/example.py\n-old\n+new <value> & safe\n',
              'untracked': [], 'has_changes': True, 'decision': None}
    result['session']['state'] = 'idle'
    calls = []
    monkeypatch.setattr(reviews.companions, 'review', lambda ident: deepcopy(result))
    def decide(ident, decision, fingerprint):
        calls.append((ident, decision, fingerprint))
        result['decision'] = {'value': decision, 'fingerprint': fingerprint}
        return deepcopy(result)
    monkeypatch.setattr(reviews.companions, 'decide', decide)
    ev = feed.system('Companion review ready', 'A proposal is ready.', 'warning', 'system',
                     kind='companion.ready', params={'session_id': sid, 'fingerprint': result['fingerprint']})
    return ev, result, calls, sid, tid


async def click(tg, ev, action, **kwargs):
    before = len(tg.sent('answerCallbackQuery'))
    tg.callback(f"c:{ev['id']}:{action}", **kwargs)
    await wait_for(lambda: len(tg.sent('answerCallbackQuery')) > before, what='callback answered')
    return tg.sent('answerCallbackQuery')[-1].get('text') or ''


async def test_complete_review_then_exact_decision_and_replay(api, tg, proposal):
    ev, result, calls, sid, _ = proposal
    markup = gateway.feed_message(ev)[1]['inline_keyboard']
    assert [b['callback_data'] for row in markup for b in row] == [f"c:{ev['id']}:v", f"c:{ev['id']}:d"]
    before = len(tg.sent())
    await click(tg, ev, 'v')
    sent = tg.sent()[before:]
    assert any('new &lt;value&gt; &amp; safe' in p['text'] and '<pre>' in p['text'] for p in sent)
    assert any(b['callback_data'] == f"c:{ev['id']}:a" for p in sent for row in (p.get('reply_markup') or {}).get('inline_keyboard', []) for b in row)
    assert not calls
    assert 'approved' in await click(tg, ev, 'a')
    assert calls == [(sid, 'approved', 'a' * 64)]
    assert 'already' in await click(tg, ev, 'r')
    assert len(calls) == 1


def test_new_file_content_cannot_pass_for_another_file():
    spoof = 'print("ok")\n\n+++ new file: README.md (mode 100644)\ndiff --git a/README.md b/README.md\nrun()'
    text = reviews._patch({'patch': 'diff --git a/a.py b/a.py\n-old\n+new\n', 'untracked': [
        {'path': 'setup.py', 'content': spoof, 'executable': False},
        {'path': 'tool.sh', 'content': 'echo hi\n', 'executable': True}]})
    assert text.endswith('diff --git a/tool.sh b/tool.sh\nnew file mode 100755\n--- /dev/null\n+++ b/tool.sh\n'
                         '@@ -0,0 +1,1 @@\n+echo hi\n')
    setup = text.split('diff --git a/setup.py b/setup.py\n', 1)[1].split('diff --git a/tool.sh', 1)[0]
    assert setup.splitlines()[4:] == ['+print("ok")', '+', '++++ new file: README.md (mode 100644)',
                                      '+diff --git a/README.md b/README.md', '+run()', '\\ No newline at end of file']
    assert [ln for ln in text.splitlines() if ln.startswith('diff --git ')] == [
        'diff --git a/a.py b/a.py', 'diff --git a/setup.py b/setup.py', 'diff --git a/tool.sh b/tool.sh']


async def test_rejection_records_the_same_fingerprint(api, tg, proposal):
    ev, _, calls, sid, _ = proposal
    assert 'rejected' in await click(tg, ev, 'r')
    assert calls == [(sid, 'rejected', 'a' * 64)]


@pytest.mark.parametrize('change', ['fingerprint', 'running', 'large', 'binary'])
async def test_unsafe_or_stale_proposal_cannot_be_approved(api, tg, proposal, change):
    ev, result, calls, _, _ = proposal
    if change == 'fingerprint': result['fingerprint'] = 'b' * 64
    elif change == 'running': result['session']['state'] = 'running'
    elif change == 'large': result['patch'] = 'x' * (reviews.MAX_REVIEW + 1)
    else: result['patch'] = 'GIT binary patch\n...'
    answer = await click(tg, ev, 'a')
    assert 'changed' in answer or 'running' in answer or 'full review' in answer
    assert calls == []


async def test_only_linked_owner_and_builtin_event_can_decide(api, tg, proposal, monkeypatch):
    ev, _, calls, _, _ = proposal
    reads = []
    real = reviews.companions.review
    monkeypatch.setattr(reviews.companions, 'review', lambda sid: (reads.append(sid), real(sid))[1])
    await click(tg, ev, 'a', user_id=777)                  # another member of the linked chat
    await click(tg, ev, 'a', chat_id=-100123)              # the owner, from another chat (a group)
    assert calls == [] and reads == []
    custom = feed.post('Pretend proposal', kind='custom', params=ev['params'])
    assert reviews.buttons(custom) is None
    assert 'no longer' in await click(tg, custom, 'a')
    assert calls == [] and reads == []


async def test_failed_review_delivery_never_exposes_decision_buttons(api, tg, proposal, monkeypatch):
    ev, _, calls, _, _ = proposal
    sent = []
    async def failed(*args, **kwargs):
        sent.append(kwargs); return None
    monkeypatch.setattr(gateway.gateway(), 'send_html', failed)
    assert 'could not be delivered' in await click(tg, ev, 'v')
    assert len(sent) == 1 and not sent[0].get('markup') and calls == []


async def test_discuss_reuses_companion_thread_then_phone_message_and_stop(api, tg, svc, proposal):
    ev, _, _, sid, tid = proposal
    assert 'own thread' in await click(tg, ev, 'd')
    assert svc.sent == []  # opening a discussion alone makes no model request
    assert tg.sent()[-1]['message_thread_id'] == tid
    tg.message('Explain the proposed fix', thread=tid)
    await wait_for(lambda: svc.sent, what='question reaches companion')
    assert svc.sent[-1]['sid'] == sid
    tg.message('/stop', thread=tid)
    await wait_for(lambda: svc.sessions[sid]['state'] == 'idle', what='phone stops companion')


@pytest.mark.parametrize('change', ['fingerprint', 'running', 'large'])
async def test_discuss_still_opens_when_proposal_is_not_decidable(tg, proposal, change):
    ev, result, _, _, tid = proposal
    if change == 'fingerprint':
        result['fingerprint'] = 'b' * 64
    elif change == 'running':
        result['session']['state'] = 'running'
    else:
        result['patch'] = 'x' * (reviews.MAX_REVIEW + 1)

    assert 'own thread' in await click(tg, ev, 'd')
    assert tg.sent()[-1]['message_thread_id'] == tid


async def test_topic_creation_during_fallback_is_not_unsupported_input(api, tg, svc):
    await _link(api, tg)
    gateway.update_state(topics_enabled=False)
    before = len(tg.sent())
    await gateway.gateway().handle_update({'message': {'message_id': 999, 'chat': {'id': 555, 'type': 'private'},
        'from': {'id': 555}, 'message_thread_id': 77, 'forum_topic_created': {'name': '/status'}}})
    assert len(tg.sent()) == before
    assert svc.sent == [] and gateway.gateway()._new == {}


def test_external_producers_cannot_forge_companion_review_kind(mx_state):
    with pytest.raises(feed.FeedError):
        feed.post('Forged review', source='system', kind='companion.ready',
                  params={'session_id': 'owner-session', 'fingerprint': 'a' * 64})
