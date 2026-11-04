"""Notifications overhaul: event kinds + params, actions, pending / resolved, session events, per-kind Telegram rules,
health issues in the feed, Web Push (docs/dev/API.md#feed-notifications, #web-push)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sqlite3
import stat
import time

import httpx
import pytest

from conftest import all_events, wait_for, wait_idle
from maxxing import config, feed, feedhooks, health, push


def _events(client, **params) -> list[dict]:
    return client.get("/api/feed", params=params).json()["events"]


# ---- storage ---------------------------------------------------------------------------------------------------
def test_an_old_feed_db_is_migrated_and_its_rows_stay_readable(mx):
    path = config.state_dir() / "feed.db"
    with sqlite3.connect(path) as c:                    # the schema of 2.0.0a108
        c.executescript("""
            CREATE TABLE events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at REAL NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL,
                title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
                dedupe TEXT, grp TEXT, count INTEGER NOT NULL DEFAULT 1, read INTEGER NOT NULL DEFAULT 0);
            CREATE UNIQUE INDEX events_dedupe ON events(source, dedupe) WHERE dedupe IS NOT NULL;
        """)
        c.execute("INSERT INTO events(at, source, level, title, grp) VALUES (?, 'crons', 'error', 'Cron failed: x', NULL)",
                  (time.time(),))
        c.execute("INSERT INTO events(at, source, level, title, grp) VALUES (?, 'crons', 'success', 'Cron jobs succeeded', 'ok')",
                  (time.time(),))
    feed._ready.discard(str(path))
    r = feed.list_events()
    old = {e["title"]: e for e in r["events"]}
    assert old["Cron failed: x"]["kind"] == "custom" and old["Cron failed: x"]["params"] == {}
    assert old["Cron failed: x"]["actions"] == [] and old["Cron failed: x"]["pending"] is True
    assert old["Cron failed: x"]["first_at"] == old["Cron failed: x"]["at"] and old["Cron failed: x"]["resolved_at"] is None
    assert r["pending"] == 1 and r["categories"]["crons"] == {"total": 2, "unread": 2, "pending": 1}
    # an old unread row of a group keeps folding (and starts its occurrences)
    ev = feed.system("Cron jobs succeeded", "b", "success", "crons", group="ok", kind="cron.succeeded",
                     params={"name": "b"})
    assert ev["count"] == 2 and ev["kind"] == "cron.succeeded"
    assert [o["params"] for o in feed.get(ev["id"], detail=True)["occurrences"]] == [{"name": "b"}, {}]
    feed._ready.discard(str(path))                      # opening again: nothing to add
    assert feed.get(ev["id"])["count"] == 2


# ---- kinds, params, actions --------------------------------------------------------------------------------------
def test_external_posts_kinds_params_and_link_actions(client, mx):
    ok = client.post("/api/feed", json={"title": "Deploy done", "source": "deploy", "kind": "deploy.done",
                                        "params": {"site": "blog", "n": 3, "ok": True, "none": None},
                                        "actions": [{"id": "open", "label": "Open", "url": "https://blog.example.com"},
                                                    {"id": "logs", "label": "Logs", "type": "link", "url": "/files?path=x"}]})
    assert ok.status_code == 200, ok.text
    ev = ok.json()["event"]
    assert ev["kind"] == "deploy.done" and ev["params"] == {"site": "blog", "n": 3, "ok": True, "none": None}
    assert [a["type"] for a in ev["actions"]] == ["link", "link"] and ev["category"] == "webhooks"
    assert client.post("/api/feed", json={"title": "x"}).json()["event"]["kind"] == "custom"
    bad = [
        ({"kind": "cron.failed"}, "bad_kind"),                     # a built-in kind is reserved
        ({"kind": "Bad Kind"}, "bad_kind"),
        ({"params": {"Bad-Name": 1}}, "bad_params"),
        ({"params": {"x": [1, 2]}}, "bad_params"),
        ({"params": {f"p{i}": i for i in range(21)}}, "bad_params"),
        ({"actions": [{"id": "go", "label": "Go", "type": "post", "url": "/api/crons/c_1/run"}]}, "bad_action"),
        ({"actions": [{"id": "go", "label": "Go", "url": "//evil.example.com"}]}, "bad_action"),
        ({"actions": [{"id": "go", "label": "Go", "url": "/\\evil.example.com"}]}, "bad_action"),
        ({"actions": [{"id": "go", "label": "Go", "url": "http://plain.example.com"}]}, "bad_action"),
        ({"actions": [{"id": "go", "label": "Go", "url": "javascript:alert(1)"}]}, "bad_action"),
        ({"actions": [{"id": "Go!", "label": "Go", "url": "/x"}]}, "bad_action"),
        ({"actions": [{"id": f"a{i}", "label": "Go", "url": "/x"} for i in range(5)]}, "bad_action"),
    ]
    for extra, code in bad:
        r = client.post("/api/feed", json={"title": "x", **extra})
        assert r.status_code == 400 and r.json()["error"] == code, (extra, r.text)
    # webhook kinds are not reserved (just a name for the translations)
    assert client.post("/api/feed", json={"title": "Sale", "kind": "stripe.sale"}).status_code == 200


def test_post_actions_only_from_built_in_producers_and_only_allow_listed():
    acts = [feed.post_action("rerun", "Run again", "/api/crons/c_ab12/run"),
            feed.post_action("resume", "Resume", "/api/sessions/0f8e7d6c-aaaa-bbbb-cccc-111122223333/discussion/resume"),
            feed.post_action("boom", "Delete", "/api/sessions/x"),                       # not allow-listed
            feed.post_action("other", "Other", "/api/crons/c_ab12/run?x=1")]
    kept = feed.clean_actions(acts, trusted=True, strict=False)
    assert [a["id"] for a in kept] == ["rerun", "resume"]
    assert feed.clean_actions(acts[:1], trusted=False, strict=False) == []
    with pytest.raises(feed.FeedError):
        feed.clean_actions(acts[:1], trusted=False, strict=True)


def test_cron_failures_fold_per_job_and_a_success_resolves_them(client, mx):
    from maxxing import crons
    bad = client.post("/api/crons", json={"name": "Nightly", "schedule": "0 3 * * *", "type": "shell",
                                           "command": "echo oops >&2; exit 3"}).json()
    other = client.post("/api/crons", json={"name": "Other", "schedule": "0 3 * * *", "type": "shell",
                                             "command": "exit 1"}).json()
    run1, run2 = crons.run_job(bad["id"]), crons.run_job(bad["id"])
    crons.run_job(other["id"])
    fails = _events(client, kind="cron.failed")
    mine = next(e for e in fails if e["params"]["cron_id"] == bad["id"])
    assert len(fails) == 2 and mine["count"] == 2 and mine["pending"] and mine["level"] == "error"
    assert mine["params"] == {"cron_id": bad["id"], "name": "Nightly", "run_id": run2["id"],
                              "duration_s": run2["duration_s"], "code": 3}
    assert mine["url"] == f"/crons?job={bad['id']}"
    assert mine["actions"] == [
        {"id": "open_run", "label": "Open the run", "type": "link", "url": f"/crons?job={bad['id']}&run={run2['id']}"},
        {"id": "rerun", "label": "Run again", "type": "post", "url": f"/api/crons/{bad['id']}/run"}]
    detail = client.get(f"/api/feed/{mine['id']}").json()["event"]
    assert [o["params"]["run_id"] for o in detail["occurrences"]] == [run2["id"], run1["id"]]
    assert detail["first_at"] < detail["at"] and "oops" in detail["occurrences"][0]["body"]
    assert client.get("/api/feed/999999").status_code == 404
    assert client.get("/api/feed/summary").json()["kinds"]["cron.failed"]["pending"] == 2
    # the job works again: its failure is resolved (still unread), the other job's stays pending
    crons.update_job(bad["id"], {"command": "echo fine"})
    crons.run_job(bad["id"])
    mine = client.get(f"/api/feed/{mine['id']}").json()["event"]
    assert mine["resolved_at"] and not mine["pending"] and not mine["read"]
    assert [e["params"]["cron_id"] for e in _events(client, pending=1)] == [other["id"]]
    ok = _events(client, kind="cron.succeeded")[0]
    assert ok["params"]["name"] == "Nightly" and ok["category"] == "crons"
    # a new failure after the resolution starts a new row
    crons.update_job(bad["id"], {"command": "exit 2"})
    crons.run_job(bad["id"])
    rows = [e for e in _events(client, kind="cron.failed") if e["params"]["cron_id"] == bad["id"]]
    assert [(e["count"], e["pending"]) for e in rows] == [(1, True), (2, False)]


def test_pending_filter_counts_resolve_and_read(client, mx):
    a = feed.system("Disk", level="warning", source="system", group="g1", kind="health.issue")
    b = feed.post("Stock low", level="warning", source="shop")
    feed.post("Fyi", level="info", source="shop")
    feed.system("Back", level="success", source="infra", kind="infra.up")
    r = client.get("/api/feed", params={"pending": 1}).json()
    assert {e["id"] for e in r["events"]} == {a["id"], b["id"]} and r["pending"] == 2 and r["unread"] == 4
    assert r["categories"] == {"sessions": {"total": 0, "unread": 0, "pending": 0},
                               "crons": {"total": 0, "unread": 0, "pending": 0},
                               "system": {"total": 2, "unread": 2, "pending": 1},
                               "webhooks": {"total": 2, "unread": 2, "pending": 1}}
    assert [e["source"] for e in _events(client, category="system")] == ["infra", "system"]
    assert [e["source"] for e in _events(client, category="webhooks")] == ["shop", "shop"]
    assert client.get("/api/feed", params={"category": "nope"}).status_code == 400
    s = client.get("/api/feed/summary").json()
    assert s["pending"] == 2 and s["kinds"]["custom"] == {"total": 2, "unread": 2, "pending": 1}
    assert client.post("/api/feed/resolve", json={"ids": [a["id"]]}).json() == {"pending": 1}
    assert client.post("/api/feed/read", json={"ids": [b["id"]]}).json() == {"unread": 3, "pending": 0}
    assert feed.resolve("system", "g1") == 0                   # already resolved
    assert feed.resolve("shop", "nothing") == 0


def test_the_watcher_value_changes_on_folds_and_resolutions(mx):
    feed.system("Fail", level="error", source="crons", group="failed:c1", kind="cron.failed")
    first = feed.watch_id()
    feed.system("Fail", level="error", source="crons", group="failed:c1", kind="cron.failed")     # a fold
    second = feed.watch_id()
    assert second != first and second == feed.last_id()
    feed.resolve("crons", "failed:c1")
    assert feed.watch_id() not in (first, second)


# ---- Telegram rules per kind ---------------------------------------------------------------------------------------
def test_kind_rules_take_precedence_over_source_rules(client, mx, monkeypatch):
    sent = []
    from maxxing.telegram import gateway
    monkeypatch.setattr(gateway, "feed_notify", lambda ev, loud=False: sent.append((ev["title"], loud)))
    s = client.get("/api/feed/settings").json()
    assert s["kinds"] == ["stripe", "shopify", "github", "generic"] and s["kind_rules"] == {}
    kinds = {k["kind"]: k for k in s["event_kinds"]}
    assert list(kinds)[:3] == ["session.done", "session.failed", "discussion.paused"]
    assert kinds["session.done"] == {"kind": "session.done", "category": "sessions", "source": "sessions",
                                     "level": "success", "builtin": True, "rule": "auto", "default": "off",
                                     "own_thread": True}
    assert kinds["stripe.payment_failed"]["default"] == "loud" and kinds["stripe.refund"]["default"] == "silent"
    assert {"sessions", "crons", "system", "security"} <= {x["source"] for x in s["sources"] if x["own_thread"]}
    s = client.put("/api/feed/settings", json={"kind_rules": {"cron.failed": "loud", "deploy.done": "silent"},
                                               "rules": {"crons": "silent"}}).json()
    assert s["kind_rules"] == {"cron.failed": "loud", "deploy.done": "silent"}
    kinds = {k["kind"]: k for k in s["event_kinds"]}
    assert kinds["cron.failed"]["rule"] == "loud" and kinds["cron.succeeded"]["default"] == "silent"
    feed.system("Cron failed: a", level="error", source="crons", kind="cron.failed")       # kind rule: loud
    feed.system("Cron jobs succeeded", level="success", source="crons", kind="cron.succeeded")   # source rule: silent
    feed.post("Deploy done", source="deploy", kind="deploy.done")                          # custom kind rule
    feed.post("Other", source="deploy")                                                    # auto: info -> off
    assert sent == [("Cron failed: a", True), ("Cron jobs succeeded", False), ("Deploy done", False)]
    seen = {k["kind"]: k for k in client.get("/api/feed/settings").json()["event_kinds"]}
    assert seen["deploy.done"]["builtin"] is False and seen["deploy.done"]["category"] == "webhooks"
    # merged; "auto" removes an entry
    s = client.put("/api/feed/settings", json={"kind_rules": {"cron.failed": "auto"}}).json()
    assert s["kind_rules"] == {"deploy.done": "silent"}
    assert next(x for x in s["sources"] if x["source"] == "crons")["rule"] == "silent"
    assert client.put("/api/feed/settings", json={"kind_rules": {"x": "maybe"}}).status_code == 400
    assert client.put("/api/feed/settings", json={"kind_rules": {"Bad Kind": "off"}}).status_code == 400


# ---- webhooks ------------------------------------------------------------------------------------------------------
def test_webhook_refused_is_pending_until_the_secret_is_set(client, mx):
    h = feedhooks.create("stripe-live", "stripe")
    tok = h["url"].rsplit("/", 1)[1]
    assert feedhooks.deliver(tok, {}, b'{"type": "charge.succeeded"}') == (401, {"error": "secret_required"})
    feedhooks.deliver(tok, {}, b'{"type": "charge.succeeded"}')
    ev = _events(client, kind="webhook.refused")[0]
    assert ev["pending"] and ev["count"] == 2 and ev["source"] == "security" and ev["category"] == "system"
    assert ev["params"] == {"hook_id": h["id"], "name": "stripe-live", "service": "stripe"}
    assert ev["actions"] == [{"id": "add_secret", "label": "Add the secret", "type": "link",
                              "url": f"/settings/notifications?hook={h['id']}"}]
    assert client.patch(f"/api/feed/hooks/{h['id']}", json={"secret": "whsec_x"}).status_code == 200
    assert not _events(client, kind="webhook.refused")[0]["pending"]
    h2 = feedhooks.create("shop2", "shopify")
    feedhooks.deliver(h2["url"].rsplit("/", 1)[1], {}, b"{}")
    assert len(_events(client, pending=1)) == 1
    client.delete(f"/api/feed/hooks/{h2['id']}")
    assert _events(client, pending=1) == []


def _sign_stripe(secret: str, body: bytes) -> dict:
    t = str(int(time.time()))
    sig = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return {"Stripe-Signature": f"t={t},v1={sig}"}


def test_webhook_events_get_kinds_and_generic_actions_are_links_only(client, mx):
    st = feedhooks.create("shop-stripe", "stripe", "whsec_k")
    body = json.dumps({"id": "evt_1", "type": "checkout.session.completed", "data": {"object": {
        "amount_total": 4900, "currency": "eur", "customer_details": {"email": "a@example.com"}}}}).encode()
    assert feedhooks.deliver(st["url"].rsplit("/", 1)[1], _sign_stripe("whsec_k", body), body)[0] == 200
    sale = _events(client, source="shop-stripe")[0]
    assert sale["kind"] == "stripe.sale" and sale["params"] == {"amount": "49.00 EUR", "email": "a@example.com"}
    gh = feedhooks.create("gh", "github", "ghs")
    body = json.dumps({"action": "completed", "repository": {"full_name": "acme/blog"},
                       "workflow_run": {"name": "CI", "conclusion": "failure", "head_branch": "main"}}).encode()
    hd = {"X-GitHub-Event": "workflow_run", "X-GitHub-Delivery": "d1",
          "X-Hub-Signature-256": "sha256=" + hmac.new(b"ghs", body, hashlib.sha256).hexdigest()}
    assert feedhooks.deliver(gh["url"].rsplit("/", 1)[1], hd, body)[0] == 200
    run = _events(client, source="gh")[0]
    assert run["kind"] == "github.workflow" and run["level"] == "error" and run["pending"]
    assert run["params"] == {"repo": "acme/blog", "workflow": "CI", "conclusion": "failure", "branch": "main"}
    gen = feedhooks.create("gen", "generic")
    body = json.dumps({"title": "Backup done", "kind": "cron.failed", "actions": [
        {"id": "open", "label": "Open", "url": "https://backup.example.com/runs/1"},
        {"id": "bad", "label": "Bad", "type": "post", "url": "/api/crons/c_1/run"},
        {"id": "far", "label": "Far", "url": "//evil.example.com"}]}).encode()
    assert feedhooks.deliver(gen["url"].rsplit("/", 1)[1], {}, body)[0] == 200
    ev = _events(client, source="gen")[0]
    assert ev["kind"] == "custom" and [a["id"] for a in ev["actions"]] == ["open"]
    test_ev = client.post(f"/api/feed/hooks/{gen['id']}/test").json()["event"]
    assert test_ev["kind"] == "webhook.test" and test_ev["params"] == {"name": "gen"}


# ---- sessions --------------------------------------------------------------------------------------------------
def test_session_events_done_failed_and_cron_sessions_stay_out(client, topic, mx):
    from maxxing.sessions import service
    s = client.post("/api/sessions", json={"path": topic, "message": "hello NOTOOL"}).json()
    wait_idle(client, s["id"])
    done = wait_for(lambda: _events(client, kind="session.done"))[0]
    assert done["source"] == "sessions" and done["category"] == "sessions" and done["level"] == "success"
    assert done["params"]["session_id"] == s["id"] and done["params"]["provider"] == "claude"
    assert done["params"]["turns"] == 1 and done["params"]["path"] == topic
    assert done["actions"][0]["id"] == "open_session" and f"session={s['id']}" in done["actions"][0]["url"]
    client.post(f"/api/sessions/{s['id']}/messages", json={"text": "FAIL please"})
    wait_idle(client, s["id"])
    failed = wait_for(lambda: _events(client, kind="session.failed"))[0]
    assert failed["pending"] and failed["params"]["error"]
    client.post(f"/api/sessions/{s['id']}/messages", json={"text": "again NOTOOL"})
    wait_idle(client, s["id"])
    wait_for(lambda: _events(client, kind="session.done")[0]["count"] == 2)
    assert not client.get(f"/api/feed/{failed['id']}").json()["event"]["pending"]     # works again: resolved
    cron = service.create_session(topic, message="cron run NOTOOL", source="cron", cron=True)
    wait_idle(client, cron["id"])
    time.sleep(0.5)
    assert all(e["params"].get("session_id") != cron["id"] for e in _events(client, category="sessions"))


def test_a_discussion_paused_by_its_limit_is_pending_until_resumed(client, topic, mx, monkeypatch):
    fake = mx["tmp"] / "codex-limit"
    fake.write_text('''#!/usr/bin/env python3
import json,sys
sys.stdin.read()
print(json.dumps({"type":"thread.started","thread_id":"limit-thread"}),flush=True)
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"Codex reply"}}),flush=True)
print(json.dumps({"type":"turn.completed","usage":{}}),flush=True)
''')
    fake.chmod(0o755)
    monkeypatch.setenv("MAXXING_CODEX_BIN", str(fake))
    s = client.post("/api/sessions", json={"path": topic, "provider": "discussion", "message": "NOTOOL",
                                           "discussion_turn_limit": 1}).json()
    sid = s["id"]
    wait_for(lambda: (x := client.get(f"/api/sessions/{sid}").json())["state"] == "idle" and x["debate_paused"], 15)
    ev = wait_for(lambda: _events(client, kind="discussion.paused"))[0]
    assert ev["pending"] and ev["level"] == "warning" and ev["source"] == "sessions"
    assert ev["params"]["turns"] == 1 and ev["params"]["turn_limit"] == 1 and ev["params"]["provider"] == "discussion"
    assert "turn limit" in ev["body"]
    resume = ev["actions"][0]
    assert resume == {"id": "resume", "label": "Resume", "type": "post",
                      "url": f"/api/sessions/{sid}/discussion/resume"}
    assert not _events(client, kind="session.done")                    # the pause is the event, not a "done"
    assert client.post(resume["url"]).status_code == 200                # what the web does with a post action
    assert not client.get(f"/api/feed/{ev['id']}").json()["event"]["pending"]
    wait_for(lambda: any(e.get("text") == "Codex reply" for e in all_events(client, sid)), 15)


def test_session_stops_seen_by_the_watcher(mx, monkeypatch):
    """on_session_stop: running -> idle seen across passes, a turn run between two passes, a failed start."""
    from maxxing.sessions import service, store
    monkeypatch.setattr(store, "runner_alive", lambda sid, meta: True)    # "running" without a real runner
    monkeypatch.setattr(service, "_known", {})
    seen: list[str] = []
    s = service.create_session("", title="Watched")                       # no message: never ran
    service._scan(True, [])
    stops: list[dict] = []
    store.update(s["id"], state="running", turns=0)
    service._scan(True, stops)
    store.update(s["id"], state="idle", turns=1, last_turn={"kind": "user"})
    service._scan(True, stops)
    seen += [x["id"] for x in stops]
    assert seen == [s["id"]] and stops[0]["last_turn"] == {"kind": "user"} and "discussion_elapsed" in stops[0]
    stops.clear()
    store.update(s["id"], turns=2)                                         # ran and ended between two passes
    service._scan(True, stops)
    store.update(s["id"], state="error", error="spawn failed")             # failed to start
    service._scan(True, stops)
    assert len(stops) == 2 and stops[1]["state"] == "error"


# ---- health ----------------------------------------------------------------------------------------------------
def test_health_issues_become_pending_events_until_they_go_away(mx):
    disk = {"level": "warn", "code": "disk_full", "text": "Disk 91 % full (8.2 GB free)", "id": "aaa111"}
    auth = {"level": "error", "code": "claude_auth", "text": "Claude is not connected", "id": "bbb222"}
    skipped = [{"level": "warn", "code": "cron_failed", "text": 'Scheduled job "x" failed', "id": "ccc"},
               {"level": "info", "code": "claude_auth", "text": "Codex is ready", "id": "ddd"}]
    health._to_feed([disk, auth, *skipped])
    health._to_feed([disk, auth, *skipped])                               # still there: not posted again
    evs = {e["params"]["issue_id"]: e for e in feed.list_events(kind="health.issue")["events"]}
    assert set(evs) == {"aaa111", "bbb222"} and evs["aaa111"]["count"] == 1
    assert evs["aaa111"]["level"] == "warning" and evs["bbb222"]["level"] == "error" and evs["aaa111"]["pending"]
    assert evs["bbb222"]["actions"][0]["url"] == "/settings/claude" and evs["aaa111"]["params"]["code"] == "disk_full"
    health._to_feed([auth])                                               # the disk issue is gone
    evs = {e["params"]["issue_id"]: e for e in feed.list_events(kind="health.issue")["events"]}
    assert not evs["aaa111"]["pending"] and evs["aaa111"]["resolved_at"] and evs["bbb222"]["pending"]
    health._to_feed([disk, auth])                                         # back: a new event
    assert len(feed.list_events(kind="health.issue")["events"]) == 3


def test_collect_feeds_the_issues(mx, monkeypatch):
    monkeypatch.setattr(health, "disk", lambda path=None: {"total": 100e9, "free": 2e9, "pct": 98.0})
    health.collect(force=True)
    assert any(e["params"]["code"] == "disk_full" for e in feed.list_events(kind="health.issue")["events"])


# ---- CLI -------------------------------------------------------------------------------------------------------
def test_cli_post_with_kind_params_and_links(mx, capsys):
    from maxxing import cli
    assert cli.main(["feed", "post", "Backup offsite done", "--kind", "backup.offsite", "--param", "size=3 GB",
                     "--link", "Open=https://backup.example.com", "--json"]) == 0
    ev = json.loads(capsys.readouterr().out)["event"]
    assert ev["kind"] == "backup.offsite" and ev["params"] == {"size": "3 GB"}
    assert ev["actions"] == [{"id": "link-1", "label": "Open", "type": "link", "url": "https://backup.example.com"}]
    assert cli.main(["feed", "post", "x", "--link", "Go=//evil.example.com"]) == 2
    assert cli.main(["feed", "post", "x", "--kind", "cron.failed"]) == 2
    feed.post("Careful", level="warning", source="mail")
    assert cli.main(["feed", "list", "--pending"]) == 0
    out = capsys.readouterr().out
    assert "! " in out and "Careful" in out and "need attention" in out


# ---- Web Push --------------------------------------------------------------------------------------------------
def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _ua_keys():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return priv, _b64(pub), os.urandom(16)


def _decrypt(body: bytes, ua_priv, auth: bytes) -> bytes:
    """What the browser does (RFC 8291)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    as_pub, ct = body[21:21 + idlen], body[21 + idlen:]
    assert rs == 4096 and idlen == 65
    ua_pub = ua_priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = ua_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    h = lambda k, d: hmac.new(k, d, hashlib.sha256).digest()  # noqa: E731
    ikm = h(h(auth, shared), b"WebPush: info\x00" + ua_pub + as_pub + b"\x01")
    prk = h(salt, ikm)
    plain = AESGCM(h(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]).decrypt(
        h(prk, b"Content-Encoding: nonce\x00\x01")[:12], ct, None)
    assert plain.endswith(b"\x02")
    return plain[:-1]


def test_encryption_matches_the_rfc_8291_example():
    from cryptography.hazmat.primitives.asymmetric import ec
    as_priv = ec.derive_private_key(int.from_bytes(push._b64d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"),
                                    ec.SECP256R1())
    body = push.encrypt(b"When I grow up, I want to be a watermelon",
                        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
                        "BTBZMqHH6r4Tts7J_aSIgg", salt=push._b64d("DGv6ra1nlYgDCS1FRnbzlw"), private_key=as_priv)
    assert _b64(body) == ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6"
                          "TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qul"
                          "cy4a-fN")


def test_push_subscriptions_api_and_vapid_key(client, mx):
    r = client.get("/api/push").json()
    assert r["available"] is True and r["subscriptions"] == [] and len(push._b64d(r["public_key"])) == 65
    key_file = mx["state"] / "push-vapid.json"
    assert stat.S_IMODE(key_file.stat().st_mode) == 0o600
    assert client.get("/api/push").json()["public_key"] == r["public_key"]          # made once
    _, p256dh, auth = _ua_keys()
    sub = {"endpoint": "https://push.example.com/send/abc", "expirationTime": None,
           "keys": {"p256dh": p256dh, "auth": _b64(auth)}}
    created = client.post("/api/push/subscriptions", json={**sub, "label": "Phone"}).json()
    assert created["label"] == "Phone"
    assert created["prefs"] == {"levels": ["warning", "error"], "sound": True, "kinds": {}}
    again = client.post("/api/push/subscriptions", json={**sub, "prefs": {"kinds": {
        "session.done": {"enabled": True, "sound": False}, "cron.succeeded": True}}}).json()
    assert again["id"] == created["id"] and again["label"] == "Phone"
    assert again["prefs"] == {"levels": ["warning", "error"], "sound": True, "kinds": {
        "session.done": {"enabled": True, "sound": False}, "cron.succeeded": {"enabled": True, "sound": True}}}
    assert stat.S_IMODE((mx["state"] / "push.json").stat().st_mode) == 0o600
    p = client.patch(f"/api/push/subscriptions/{created['id']}", json={"prefs": {"levels": ["error"],
                                                                               "sound": False}}).json()
    assert p["prefs"]["levels"] == ["error"] and p["prefs"]["sound"] is False
    assert p["prefs"]["kinds"]["session.done"] == {"enabled": True, "sound": False}
    for bad in ({**sub, "endpoint": "http://push.example.com/x"}, {**sub, "keys": {"p256dh": "AAAA", "auth": _b64(auth)}},
                {**sub, "keys": {"p256dh": p256dh, "auth": "AAAA"}}, {"endpoint": sub["endpoint"]}):
        r = client.post("/api/push/subscriptions", json=bad)
        assert r.status_code == 400 and r.json()["error"] == "bad_subscription", bad
    for prefs in ({"levels": ["loud"]}, {"kinds": {"x": "yes"}}, {"kinds": {"x": {"enabled": 1}}},
                  {"kinds": {"x": {"enabled": True, "volume": 3}}}, {"sound": "loud"}, "all"):
        r = client.patch(f"/api/push/subscriptions/{created['id']}", json={"prefs": prefs})
        assert r.status_code == 400 and r.json()["error"] == "bad_prefs"
    assert client.patch("/api/push/subscriptions/nope", json={"label": "x"}).status_code == 404
    assert client.post("/api/push/subscriptions/nope/test").status_code == 404
    assert client.delete(f"/api/push/subscriptions/{created['id']}").json() == {"ok": True}
    assert client.get("/api/push").json()["subscriptions"] == []


def test_dispatch_encrypts_signs_filters_and_drops_gone_subscriptions(mx, monkeypatch):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    config.update_config(public_url="https://ui.example.com")
    phone_priv, phone_pub, phone_auth = _ua_keys()
    laptop_priv, laptop_pub, laptop_auth = _ua_keys()
    phone = push.subscribe("https://fcm.example.com/send/phone", {"p256dh": phone_pub, "auth": _b64(phone_auth)},
                           "Phone", {"kinds": {"session.done": {"enabled": True, "sound": False},
                                               "infra.down": {"enabled": False, "sound": True}}})
    laptop = push.subscribe("https://updates.example.net/push/laptop", {"p256dh": laptop_pub,
                                                                        "auth": _b64(laptop_auth)}, "Laptop")
    got: list[httpx.Request] = []
    gone = {"laptop": False}

    def handler(request: httpx.Request) -> httpx.Response:
        got.append(request)
        if "laptop" in str(request.url) and gone["laptop"]:
            return httpx.Response(410)
        return httpx.Response(201)
    monkeypatch.setattr(push, "http_transport", httpx.MockTransport(handler))
    feed.post("Before the start", level="error", source="mail")
    push.prime()                                                          # rows already there are never pushed
    assert push.dispatch() == 0 and got == []
    feed.post("Fyi", level="info", source="mail")                        # nobody wants info
    feed.system("Session finished: Blog", "Done.", "success", "sessions", "/sessions?session=1",
                kind="session.done", params={"title": "Blog"})          # the phone wants this kind
    fail = feed.system("Cron failed: Nightly", "exit 3", "error", "crons", "/crons?job=c_1", kind="cron.failed",
                       params={"name": "Nightly"}, actions=[feed.post_action("rerun", "Run again", "/api/crons/c_1/run")])
    assert push.dispatch() == 3                                           # done -> phone; failed -> phone + laptop
    assert push.dispatch() == 0                                           # nothing new
    by_target = {}
    for req in got:
        assert req.headers["content-encoding"] == "aes128gcm" and req.headers["ttl"] == str(push.TTL_S)
        priv, auth = (phone_priv, phone_auth) if "phone" in str(req.url) else (laptop_priv, laptop_auth)
        data = json.loads(_decrypt(req.content, priv, auth))
        by_target.setdefault("phone" if "phone" in str(req.url) else "laptop", []).append(data)
        # VAPID: an ES256 JWT for the push service's origin, signed by the server's key
        token, key = req.headers["authorization"].removeprefix("vapid t=").split(", k=")
        head, claims, sig = token.split(".")
        claims_d = json.loads(push._b64d(claims))
        assert claims_d["aud"] == f"{req.url.scheme}://{req.url.host}" and claims_d["exp"] > time.time()
        assert claims_d["sub"] == "https://ui.example.com"
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), push._b64d(key))
        raw = push._b64d(sig)
        pub.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                   f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
        assert key == push.public_key()
    assert [(d["kind"], d["silent"]) for d in by_target["phone"]] == [("session.done", True), ("cron.failed", False)]
    assert [(d["kind"], d["silent"]) for d in by_target["laptop"]] == [("cron.failed", False)]
    data = by_target["laptop"][0]
    assert data["id"] == fail["id"] and data["params"] == {"name": "Nightly"} and data["level"] == "error"
    assert data["tag"] == f"feed-{fail['id']}" and data["actions"][0]["id"] == "rerun" and data["url"] == "/crons?job=c_1"
    assert [r.headers["urgency"] for r in got] == ["normal", "high", "high"]
    assert {s["id"]: s["last_ok"] is not None for s in push.subscriptions()} == {phone["id"]: True, laptop["id"]: True}
    feed.system("Down: blog", level="error", source="infra", kind="infra.down")    # the phone turned this kind off
    n = len(got)
    push.dispatch()
    assert len(got) == n + 1 and "laptop" in str(got[-1].url)
    # the laptop unsubscribed: the push service answers 410, the subscription is dropped
    gone["laptop"] = True
    feed.post("Payment failed", level="error", source="stripe")
    push.dispatch()
    assert [s["id"] for s in push.subscriptions()] == [phone["id"]]
    assert push.test(phone["id"]) == {"ok": True, "status": 201}
    assert json.loads(_decrypt(got[-1].content, phone_priv, phone_auth))["kind"] == "push.test"


def test_dispatch_drains_more_than_one_batch(mx, monkeypatch):
    _, pub, auth = _ua_keys()
    push.subscribe("https://fcm.example.com/send/phone", {"p256dh": pub, "auth": _b64(auth)}, "Phone")
    got: list[httpx.Request] = []
    monkeypatch.setattr(push, "http_transport", httpx.MockTransport(lambda r: got.append(r) or httpx.Response(201)))
    monkeypatch.setattr(push, "DISPATCH_BATCH", 2)
    push.prime()
    for i in range(5):                                                    # more than a batch, one feed change
        feed.post(f"Failed {i}", level="error", source="mail")
    assert push.dispatch() == 5 and len(got) == 5                         # the watcher may not call again
    assert push.dispatch() == 0


def test_a_long_event_still_fits_a_push_message(mx):
    ev = feed.post("x" * 200, "y" * 4000, "error", "mail", params={f"p{i}": "z" * 500 for i in range(20)})
    data = push.payload(ev)
    assert len(data) <= push.PAYLOAD_MAX and json.loads(data)["title"].startswith("x")
