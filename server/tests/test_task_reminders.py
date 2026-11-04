"""Task reminders: `remind_at` on a task posts one `task.reminder` notification when it comes, never twice (restarts
included), and the notification stops needing attention once the task is done or its reminder changes."""
import datetime as dt
import json
from zoneinfo import ZoneInfo

from maxxing import config, feed
from maxxing.api import tasks


def _reminders():
    return feed.list_events(kind="task.reminder")["events"]


def _at(local: str, zone: str = "UTC") -> float:
    return dt.datetime.fromisoformat(local).replace(tzinfo=ZoneInfo(zone)).timestamp()


def _write(mx, items):
    (mx["ws"] / "tasks.json").write_text(json.dumps({"version": 1, "projects": [], "tasks": items}))


def test_remind_at_is_validated_and_kept(client, mx):
    t = client.post("/api/tasks", json={"title": "Call", "remind_at": "2026-05-04T09:30"}).json()
    assert t["remind_at"] == "2026-05-04T09:30"
    for bad in ("2026-05-04", "2026-05-04 09:30", "2026-13-04T09:30", "2026-05-04T25:00", "tomorrow"):
        r = client.patch(f"/api/tasks/{t['id']}", json={"remind_at": bad})
        assert r.status_code == 400 and r.json()["error"] == "invalid_remind_at", bad
    assert client.patch(f"/api/tasks/{t['id']}", json={"remind_at": None}).json()["remind_at"] is None
    plain = client.post("/api/tasks", json={"title": "No reminder"}).json()
    assert plain["remind_at"] is None
    # written by hand: anything that is not a local date and time is read as no reminder
    _write(mx, [{"id": "t_hand01", "title": "x", "remind_at": 1767225600},
                {"id": "t_hand02", "title": "y", "remind_at": "2026-05-04T09:30"}])
    got = {x["id"]: x["remind_at"] for x in client.get("/api/tasks").json()["tasks"]}
    assert got == {"t_hand01": None, "t_hand02": "2026-05-04T09:30"}


def test_reminder_fires_once_when_due_and_survives_a_restart(mx):
    config.save_config({**config.load_config(), "timezone": "Europe/Paris"})
    _write(mx, [{"id": "t_aaaaaa", "title": "Call the accountant", "due": "2026-01-16", "remind_at": "2026-01-15T09:00"},
                {"id": "t_bbbbbb", "title": "Later", "remind_at": "2026-01-15T10:00"},
                {"id": "t_cccccc", "title": "Already done", "status": "done", "remind_at": "2026-01-15T08:00"}])
    due = _at("2026-01-15T09:00", "Europe/Paris")                  # 08:00 UTC
    assert tasks.check_reminders(due - 1) == []
    assert tasks.check_reminders(due) == ["t_aaaaaa"]
    assert tasks.check_reminders(due + 60) == []                    # already reminded
    (ev,) = _reminders()
    assert ev["source"] == "system" and ev["level"] == "warning" and ev["pending"]
    assert ev["url"] == "/tasks?task=t_aaaaaa" and ev["title"] == "Reminder: Call the accountant"
    assert ev["params"] == {"task_id": "t_aaaaaa", "title": "Call the accountant", "remind_at": "2026-01-15T09:00",
                            "due": "2026-01-16"}
    assert [a["id"] for a in ev["actions"]] == ["open"]
    # the app restarts: what was sent is on disk, nothing is posted again
    saved = json.loads(tasks.reminders_path().read_text())
    assert saved == {"t_aaaaaa": {"remind_at": "2026-01-15T09:00", "resolved": False}}
    assert tasks.check_reminders(due + 120) == [] and len(_reminders()) == 1
    # killed between the post and the record: the dedupe key keeps it single
    tasks.reminders_path().unlink()
    assert tasks.check_reminders(due + 180) == ["t_aaaaaa"] and len(_reminders()) == 1
    assert "t_aaaaaa" in json.loads(tasks.reminders_path().read_text())
    # the app was off at 10:00: the missed reminder comes when it is back
    assert tasks.check_reminders(due + 7200) == ["t_bbbbbb"] and len(_reminders()) == 2


def test_done_task_or_new_reminder_resolves_it(client, mx):
    # far in the future: the server's own reminder loop (real clock) never gets there first
    t = client.post("/api/tasks", json={"title": "Pay the invoice", "remind_at": "2099-02-01T08:00"}).json()
    other = client.post("/api/tasks", json={"title": "Renew", "remind_at": "2099-02-01T08:00"}).json()
    now = _at("2099-02-01T08:00")
    assert sorted(tasks.check_reminders(now)) == sorted([t["id"], other["id"]])
    assert all(e["pending"] for e in _reminders())
    client.patch(f"/api/tasks/{t['id']}", json={"status": "done"})
    assert tasks.check_reminders(now + 60) == []
    pending = {e["params"]["task_id"]: e["pending"] for e in _reminders()}
    assert pending == {t["id"]: False, other["id"]: True}
    # reopened with the same reminder: not reminded again
    client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"})
    assert tasks.check_reminders(now + 120) == []
    # a new reminder: the old notification is resolved, the new one comes when due
    client.patch(f"/api/tasks/{other['id']}", json={"remind_at": "2099-02-02T08:00"})
    assert tasks.check_reminders(now + 180) == []
    assert not any(e["pending"] for e in _reminders())
    assert tasks.check_reminders(_at("2099-02-02T08:00")) == [other["id"]]
    assert len(_reminders()) == 3
    # a deleted task is forgotten
    client.delete(f"/api/tasks/{other['id']}")
    tasks.check_reminders(_at("2099-02-02T08:01"))
    assert other["id"] not in json.loads(tasks.reminders_path().read_text())


def test_no_reminder_while_integrations_are_paused(mx):
    _write(mx, [{"id": "t_dddddd", "title": "x", "remind_at": "2026-01-01T00:00"}])
    config.save_config({**config.load_config(), "integrations_paused": True})
    assert tasks.check_reminders(_at("2026-01-02T00:00")) == [] and _reminders() == []
    config.save_config({**config.load_config(), "integrations_paused": False})
    assert tasks.check_reminders(_at("2026-01-02T00:00")) == ["t_dddddd"]


def test_corrupt_file_reminds_nothing(mx):
    (mx["ws"] / "tasks.json").write_text("{not json")
    assert tasks.check_reminders() == []
