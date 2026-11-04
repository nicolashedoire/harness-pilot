"""Notifications follow-ups: changing the limits of a Claude Code + Codex discussion and its pause time
(docs/dev/API.md#sessions)."""
from __future__ import annotations

import time

import pytest

from conftest import all_events, wait_for


# ---- discussion limits -----------------------------------------------------------------------------------------
def _paused(client, sid: str) -> dict:
    return wait_for(lambda: (x := client.get(f"/api/sessions/{sid}").json())["state"] == "idle"
                    and x["debate_paused"] and x, 20)


def _fake_codex(mx, monkeypatch, text: str = "Codex reply") -> None:
    fake = mx["tmp"] / "codex-followups"
    fake.write_text('''#!/usr/bin/env python3
import json,sys
sys.stdin.read()
print(json.dumps({"type":"thread.started","thread_id":"followups-thread"}),flush=True)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":%r}}),flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}),flush=True)
''' % text)
    fake.chmod(0o755)
    monkeypatch.setenv("MAXXING_CODEX_BIN", str(fake))


def test_discussion_limits_can_be_changed_with_the_creation_ranges(client, topic):
    s = client.post("/api/sessions", json={"path": topic, "provider": "debate", "discussion_turn_limit": 20,
                                           "discussion_duration_seconds": 600}).json()
    sid = s["id"]
    assert s["discussion_paused_at"] is None
    r = client.patch(f"/api/sessions/{sid}/discussion", json={"turn_limit": 30})
    assert r.status_code == 200, r.text
    assert r.json()["discussion_turn_limit"] == 30 and r.json()["discussion_duration_seconds"] == 600   # kept
    r = client.patch(f"/api/sessions/{sid}/discussion", json={"duration_minutes": 1440}).json()
    assert r["discussion_turn_limit"] == 30 and r["discussion_duration_seconds"] == 86400
    r = client.patch(f"/api/sessions/{sid}/discussion", json={"turn_limit": None, "duration_minutes": 1}).json()
    assert r["discussion_turn_limit"] is None and r["discussion_duration_seconds"] == 60
    r = client.patch(f"/api/sessions/{sid}/discussion", json={"duration_minutes": None}).json()
    assert r["discussion_turn_limit"] is None and r["discussion_duration_seconds"] is None
    assert client.patch(f"/api/sessions/{sid}/discussion", json={}).status_code == 200
    for bad in ({"turn_limit": 0}, {"turn_limit": 201}, {"duration_minutes": 0}, {"duration_minutes": 1441},
                {"turn_limit": "5"}, {"turn_limit": 1.5}, {"turn_limit": True}):
        r = client.patch(f"/api/sessions/{sid}/discussion", json=bad)
        assert r.status_code == 422 and r.json()["error"] == "invalid", bad
    claude = client.post("/api/sessions", json={"path": topic}).json()
    r = client.patch(f"/api/sessions/{claude['id']}/discussion", json={"turn_limit": 3})
    assert r.status_code == 400 and r.json()["error"] == "unsupported"
    assert client.patch("/api/sessions/nope/discussion", json={"turn_limit": 3}).status_code == 404


def test_the_service_checks_the_ranges_too(mx):
    from maxxing.sessions import service
    from maxxing.sessions.service import SessionError
    s = service.create_session("", provider="discussion")
    for kw in ({"turn_limit": 0}, {"turn_limit": 201}, {"duration_s": 59}, {"duration_s": 86401},
               {"turn_limit": True}, {"duration_s": 90.0}):
        with pytest.raises(SessionError) as e:
            service.update_discussion(s["id"], **kw)
        assert e.value.status == 400 and e.value.code == "bad_limit"
    assert service.update_discussion(s["id"], duration_s=90)["discussion_duration_seconds"] == 90


def test_resume_continues_the_period_once_the_limit_is_raised(client, topic, mx, monkeypatch):
    _fake_codex(mx, monkeypatch)
    s = client.post("/api/sessions", json={"path": topic, "provider": "discussion", "message": "NOTOOL",
                                           "discussion_turn_limit": 1}).json()
    sid = s["id"]
    s = _paused(client, sid)
    assert s["discussion_turns"] == 1 and s["discussion_pause_reason"] == "limit"
    assert abs(s["discussion_paused_at"] - time.time()) < 30                  # the runner's limit pause
    # raised above what the period used: Resume continues it (1 -> 3 replies), no new period
    assert client.patch(f"/api/sessions/{sid}/discussion", json={"turn_limit": 3}).json()["debate_paused"]
    resumed = client.post(f"/api/sessions/{sid}/discussion/resume").json()
    assert resumed["discussion_paused_at"] is None and resumed["discussion_turns"] == 1
    wait_for(lambda: any(e.get("text") == "Codex reply" for e in all_events(client, sid)), 20)
    s = _paused(client, sid)
    assert s["discussion_turns"] == 3 and s["discussion_pause_reason"] == "limit" and s["discussion_paused_at"]
    # lowered under it (still reached): Resume starts a new period with the new limit
    client.patch(f"/api/sessions/{sid}/discussion", json={"turn_limit": 2})
    assert client.post(f"/api/sessions/{sid}/discussion/resume").json()["discussion_turns"] == 0
    s = _paused(client, sid)
    assert s["discussion_turns"] == 2
    client.post(f"/api/sessions/{sid}/stop")


def test_pause_time_is_set_by_both_pauses_and_cleared_on_resume_and_stop(mx):
    from maxxing.sessions import service, store
    s = service.create_session("", provider="discussion")
    sid = s["id"]
    store.update(sid, debate_active=True, discussion_started=time.time() - 5, discussion_turns=2)
    before = time.time()
    s = service.pause_debate(sid)
    assert s["discussion_pause_reason"] == "user" and before <= s["discussion_paused_at"] <= time.time()
    at = s["discussion_paused_at"]
    assert service.pause_debate(sid)["discussion_paused_at"] == at             # pausing again keeps the first time
    s = service.resume_debate(sid)                                              # nothing queued: no runner
    assert s["discussion_paused_at"] is None and s["discussion_turns"] == 2   # a pause button never resets
    service.pause_debate(sid)
    service.stop(sid)
    assert service.get_session(sid)["discussion_paused_at"] is None


@pytest.mark.parametrize(("turns", "limit", "elapsed", "duration", "after"), [
    (20, 20, 0, None, 0),        # still reached: a new period
    (20, 30, 0, None, 20),       # raised: the period continues
    (20, None, 0, None, 20),     # limit removed: continues
    (3, 30, 700, 600, 0),        # the duration is still reached
    (3, 30, 500, 900, 3),        # the duration was raised
])
def test_a_limit_pause_resets_the_counters_only_while_a_limit_is_reached(mx, turns, limit, elapsed, duration, after):
    from maxxing.sessions import service, store
    sid = service.create_session("", provider="debate")["id"]
    store.update(sid, debate_paused=True, discussion_pause_reason="limit", discussion_turns=turns,
                 discussion_elapsed=elapsed, discussion_turn_limit=limit, discussion_duration_seconds=duration,
                 discussion_paused_at=time.time())
    s = service.resume_debate(sid)
    assert s["discussion_turns"] == after and not s["debate_paused"] and s["discussion_paused_at"] is None
