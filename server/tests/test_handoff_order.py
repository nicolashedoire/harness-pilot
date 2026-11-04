"""Hand-off: a message sent to the continuation before its summary arrives runs AFTER the summary seed."""
from __future__ import annotations

import json
import os
import time

from maxxing.sessions import service, store
from conftest import wait_for, wait_idle


def _prompts(mx) -> list[str]:
    f = mx["fake_dir"] / "calls.jsonl"
    return [json.loads(x)["prompt"] for x in f.read_text().splitlines()] if f.exists() else []


def _first(prompts: list[str], pred) -> int:
    return next(i for i, p in enumerate(prompts) if pred(p))


def test_the_summary_seed_runs_before_a_message_sent_meanwhile(client, topic, mx, monkeypatch):
    """The UI shows the new session at once: what the user types there waits for the summary, then follows it."""
    s = client.post("/api/sessions", json={"path": topic, "message": "first NOTOOL"}).json()
    wait_idle(client, s["id"])
    monkeypatch.setenv("FAKE_CLAUDE_DELAY", "0.4")       # the summary turn takes a few seconds, like a real one
    new = client.post(f"/api/sessions/{s['id']}/handoff").json()
    r = client.post(f"/api/sessions/{new['id']}/messages", json={"text": "next question NOTOOL"}).json()
    assert r["queued"] is True
    wait_for(lambda: (store.read(s["id"]) or {}).get("archived"), 40)
    n = wait_idle(client, new["id"], 40)
    assert n["turns"] == 2 and "handoff_pending" not in store.read(new["id"])
    prompts = _prompts(mx)
    seed = _first(prompts, lambda p: p.startswith("Context carried over"))
    mine = _first(prompts, lambda p: "next question" in p)
    assert seed < mine, "the user's message ran in an empty thread, before the hand-off summary"


def test_a_failed_summary_releases_the_waiting_message(client, topic, mx, monkeypatch):
    """Stopping the summary turn (or its failure) never keeps the continuation's messages waiting."""
    s = client.post("/api/sessions", json={"path": topic, "message": "first NOTOOL"}).json()
    wait_idle(client, s["id"])
    monkeypatch.setenv("FAKE_CLAUDE_DELAY", "0.5")
    new = client.post(f"/api/sessions/{s['id']}/handoff").json()
    client.post(f"/api/sessions/{new['id']}/messages", json={"text": "next question NOTOOL"})
    wait_for(lambda: (store.read(s["id"]) or {}).get("pid"), 10)
    client.post(f"/api/sessions/{s['id']}/stop")
    n = wait_idle(client, new["id"], 30)
    assert n["turns"] == 1 and "handoff_pending" not in store.read(new["id"])
    assert any("next question" in p for p in _prompts(mx))
    assert not store.read(s["id"]).get("archived")              # the old session is kept


def test_the_hold_expires_when_the_summary_never_comes(client, topic, mx):
    """A summary whose runner died never comes: after HANDOFF_HOLD_S the watcher lets the messages run."""
    meta = store.new_meta(topic, "orphan (cont.)")
    meta["handoff_pending"] = time.time()
    store.create(meta)
    sid = meta["id"]
    assert service.send_message(sid, "still there? NOTOOL")["queued"] is True
    service._scan(True)
    assert store.read(sid)["state"] == "idle" and len(store.read(sid)["queue"]) == 1    # still held
    store.update(sid, handoff_pending=time.time() - service.HANDOFF_HOLD_S - 1)
    wait_for(lambda: store.read(sid).get("turns") == 1, 20)          # the session watcher released it
    m = store.read(sid)
    assert "handoff_pending" not in m and not m.get("queue")


def test_an_expired_hold_is_ignored_by_a_new_message(client, topic, mx):
    """A message to a continuation whose hold expired starts at once."""
    meta = store.new_meta(topic, "late (cont.)")
    meta["handoff_pending"] = time.time() - service.HANDOFF_HOLD_S - 1
    store.create(meta)
    assert service.send_message(meta["id"], "hello NOTOOL")["queued"] is False
    assert wait_idle(client, meta["id"])["turns"] == 1


def test_a_save_in_the_same_timestamp_tick_is_seen(mx, monkeypatch):
    """Meta saves are atomic renames, but two within one timestamp tick (1 to 10 ms on Linux) keep the mtime, and the
    second can get the inode number the first freed, at the same size: the watcher must still see it. Here the hold of
    a continuation cut short right after a pass (its summary will never come): the queued message must not wait for
    HANDOFF_HOLD_S. Once settled, an unchanged meta is not read again."""
    for name in ("_known", "_checked", "_damaged", "_held"):
        monkeypatch.setattr(service, name, {})
    released: list[str] = []
    monkeypatch.setattr(service, "release_handoff", released.append)
    meta = store.new_meta("", "orphan (cont.)")
    meta["handoff_pending"] = float(int(time.time()))
    store.create(meta)
    sid, path = meta["id"], store.meta_path(meta["id"])
    assert service.send_message(sid, "still there? NOTOOL")["queued"] is True
    service._scan(True)
    assert released == [] and sid in service._held                   # held
    before = os.stat(path)
    m = json.loads(path.read_text())
    m["handoff_pending"] -= service.HANDOFF_HOLD_S + 100            # expired, same length: the size is kept
    with open(path, "r+") as f:                                        # same inode
        f.write(json.dumps(m, ensure_ascii=False))
        f.truncate()
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))       # same tick
    after = os.stat(path)
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns)
    service._scan(True)
    assert released == [sid]                                          # seen: the queued message runs

    service._held.clear()
    os.utime(path, ns=(after.st_atime_ns, after.st_mtime_ns - 10**10))   # 10 s later: settled
    service._scan(True)
    reads: list[str] = []
    real = store.read
    monkeypatch.setattr(store, "read", lambda s: reads.append(s) or real(s))
    for _ in range(3):
        service._scan(True)
    assert reads == []
