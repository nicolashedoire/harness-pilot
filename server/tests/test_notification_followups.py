"""Notifications follow-ups: changing the limits of a Claude Code + Codex discussion, its pause time, per-source push
preferences and quiet feed posts (docs/dev/API.md#sessions, #feed-notifications, #web-push)."""
from __future__ import annotations

import json
import sqlite3
import time

import httpx
import pytest

from conftest import all_events, wait_for
from maxxing import config, feed, push
from test_notifications import _b64, _decrypt, _ua_keys


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
    assert s["discussion_elapsed"] >= 5                                         # the period's running time
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


# ---- quiet posts ------------------------------------------------------------------------------------------------
def test_quiet_posts_skip_telegram_but_land_in_the_feed(client, mx, monkeypatch):
    from maxxing import cli
    sent_tg: list[str] = []
    monkeypatch.setattr(feed, "_to_telegram", lambda ev: sent_tg.append(ev["title"]))
    q = client.post("/api/feed", json={"title": "Nightly report ready", "source": "report", "quiet": True}).json()
    assert q["event"]["quiet"] is True
    assert cli.main(["feed", "post", "Stock checked", "--source", "stock", "--level", "error", "--quiet"]) == 0
    loud = client.post("/api/feed", json={"title": "Disk almost full", "source": "report", "level": "error"}).json()
    assert loud["event"]["quiet"] is False
    assert sent_tg == ["Disk almost full"]
    assert {e["title"]: e["quiet"] for e in client.get("/api/feed").json()["events"]} == {
        "Nightly report ready": True, "Stock checked": True, "Disk almost full": False}


def test_quiet_rows_are_never_pushed(mx, monkeypatch, capsys):
    from maxxing import cli
    _, pub, auth = _ua_keys()
    push.subscribe("https://fcm.example.com/send/phone", {"p256dh": pub, "auth": _b64(auth)}, "Phone",
                   {"levels": ["info", "success", "warning", "error"],
                    "sources": {"stock": {"enabled": True, "sound": True}}})
    got: list[httpx.Request] = []
    monkeypatch.setattr(push, "http_transport", httpx.MockTransport(lambda r: got.append(r) or httpx.Response(201)))
    push.prime()
    feed.post("Nightly report ready", source="report", notify=False)
    assert cli.main(["feed", "post", "Stock checked", "--source", "stock", "--level", "error", "--quiet"]) == 0
    feed.post("Disk almost full", source="report", level="error")
    assert push.dispatch() == 1 and len(got) == 1                          # only the one that was not quiet
    assert not push.wants(None, {"level": "error", "quiet": True})


def test_an_older_feed_db_gets_the_quiet_column(mx):
    path = config.state_dir() / "feed.db"
    with sqlite3.connect(path) as c:                    # the schema of the notifications rebuild, before `quiet`
        c.executescript("""
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at REAL NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL,
                title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
                dedupe TEXT, grp TEXT, count INTEGER NOT NULL DEFAULT 1, read INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'custom', params TEXT NOT NULL DEFAULT '{}',
                actions TEXT NOT NULL DEFAULT '[]', resolved_at REAL, first_at REAL,
                occurrences TEXT NOT NULL DEFAULT '[]');
        """)
        c.execute("INSERT INTO events(at, source, level, title) VALUES (?, 'mail', 'info', 'Old row')", (time.time(),))
    feed._ready.discard(str(path))
    assert [e["quiet"] for e in feed.list_events()["events"]] == [False]
    assert feed.post("New quiet row", notify=False)["quiet"] is True


# ---- per-source push preferences --------------------------------------------------------------------------------
def test_push_prefs_per_source_api(client, mx):
    _, pub, auth = _ua_keys()
    sub = {"endpoint": "https://push.example.com/send/src", "keys": {"p256dh": pub, "auth": _b64(auth)}}
    created = client.post("/api/push/subscriptions", json={**sub, "prefs": {"sources": {
        "shop": {"enabled": False, "sound": True}, "deploy.bot": True}}}).json()
    assert created["prefs"]["sources"] == {"shop": {"enabled": False, "sound": True},
                                           "deploy.bot": {"enabled": True, "sound": True}}
    sid = created["id"]
    p = client.patch(f"/api/push/subscriptions/{sid}", json={"prefs": {"levels": ["error"]}}).json()
    assert p["prefs"]["sources"]["shop"] == {"enabled": False, "sound": True}            # left out: kept
    p = client.patch(f"/api/push/subscriptions/{sid}", json={"prefs": {"sources": {"mail": {"enabled": True,
                                                                                         "sound": False}}}}).json()
    assert p["prefs"]["sources"] == {"mail": {"enabled": True, "sound": False}}           # given: replaced
    for prefs in ({"sources": {"Bad Name": True}}, {"sources": {"x": "yes"}}, {"sources": ["shop"]},
                  {"sources": {"x": {"enabled": True, "volume": 1}}},
                  {"sources": {f"s{i}": True for i in range(push.PREF_KINDS_MAX + 1)}}):
        r = client.patch(f"/api/push/subscriptions/{sid}", json={"prefs": prefs})
        assert r.status_code == 400 and r.json()["error"] == "bad_prefs", prefs
    # a push.json written before `sources` existed reads back with an empty map
    data = json.loads((mx["state"] / "push.json").read_text())
    data["subs"][0]["prefs"].pop("sources")
    (mx["state"] / "push.json").write_text(json.dumps(data))
    assert client.get("/api/push").json()["subscriptions"][0]["prefs"]["sources"] == {}


def test_a_source_entry_decides_before_the_kind_and_the_level():
    prefs = {"levels": ["warning", "error"], "sound": True,
             "kinds": {"stripe.sale": {"enabled": True, "sound": True}, "cron.failed": {"enabled": True, "sound": False}},
             "sources": {"shop-b": {"enabled": False, "sound": True}, "shop-a": {"enabled": True, "sound": False},
                         "mail": {"enabled": True, "sound": True}}}
    sale_b = {"kind": "stripe.sale", "source": "shop-b", "level": "success"}
    sale_a = {"kind": "stripe.sale", "source": "shop-a", "level": "success"}
    assert not push.wants(prefs, sale_b)                                   # unticked source: muted, kind ignored
    assert push.wants(prefs, sale_a) and not push.sound(prefs, sale_a)     # ticked, silent
    assert push.wants(prefs, {"kind": "custom", "source": "mail", "level": "info"})   # info, but its source is on
    assert push.wants(prefs, {"kind": "cron.failed", "source": "crons", "level": "error"})
    assert not push.sound(prefs, {"kind": "cron.failed", "source": "crons", "level": "error"})
    assert push.wants(prefs, {"kind": "custom", "source": "other", "level": "error"})  # no entry: by level
    assert not push.wants(prefs, {"kind": "custom", "source": "other", "level": "info"})


def test_dispatch_follows_the_source_preferences(mx, monkeypatch):
    priv, pub, auth = _ua_keys()
    push.subscribe("https://fcm.example.com/send/phone", {"p256dh": pub, "auth": _b64(auth)}, "Phone",
                   {"sources": {"shop": {"enabled": True, "sound": True}, "noisy": {"enabled": False, "sound": True},
                                "deploy": {"enabled": True, "sound": False}}})
    got: list[httpx.Request] = []
    monkeypatch.setattr(push, "http_transport", httpx.MockTransport(lambda r: got.append(r) or httpx.Response(201)))
    push.prime()
    feed.post("Sale: 49.00 EUR", source="shop", level="success", kind="stripe.sale")   # info level, source on
    feed.post("Something broke", source="noisy", level="error")                        # error, source off
    feed.post("Deployed", source="deploy", level="info")                               # on, silent
    assert push.dispatch() == 2
    sent = [json.loads(_decrypt(r.content, priv, auth)) for r in got]
    assert [(d["source"], d["silent"]) for d in sent] == [("shop", False), ("deploy", True)]
