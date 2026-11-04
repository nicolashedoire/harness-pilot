"""Recurring tasks: a task with a `repeat` that is marked done gets its next occurrence, once."""
import datetime as dt
import json

from maxxing.api import tasks

D = dt.date


def _next(repeat, base, today=None):
    return tasks._next_due(tasks._norm_repeat(repeat), D.fromisoformat(base), D.fromisoformat(today or base))


def test_next_dates():
    assert _next({"every": "daily"}, "2026-03-02") == D(2026, 3, 3)
    # done late: the next one is after today, not already overdue
    assert _next({"every": "daily"}, "2026-03-02", "2026-03-05") == D(2026, 3, 6)
    # done early: the next one follows the due date
    assert _next({"every": "daily"}, "2026-03-10", "2026-03-05") == D(2026, 3, 11)
    # weekly on Monday and Thursday (0 = Sunday); 2026-03-02 is a Monday
    assert _next({"every": "weekly", "days": [1, 4]}, "2026-03-02") == D(2026, 3, 5)
    assert _next({"every": "weekly", "days": [1, 4]}, "2026-03-05") == D(2026, 3, 9)
    assert _next({"every": "weekly", "days": []}, "2026-03-04") == D(2026, 3, 11)     # no days: its own weekday
    assert _next({"every": "monthly"}, "2026-01-31") == D(2026, 2, 28)
    assert _next({"every": "monthly", "day": 31}, "2026-02-28") == D(2026, 3, 31)      # the 31st comes back
    assert _next({"every": "monthly"}, "2026-12-15") == D(2027, 1, 15)
    assert tasks._norm_repeat({"every": "yearly"}) is None and tasks._norm_repeat("daily") is None
    assert tasks._norm_repeat({"every": "weekly", "days": [4, 1, 1, 9, True, "2"]}) == {"every": "weekly", "days": [1, 4]}


def test_done_recurring_task_gets_its_next_occurrence_once(client, mx, monkeypatch):
    monkeypatch.setattr(tasks, "_today", lambda: D(2026, 3, 2))
    proj = client.post("/api/tasks/projects", json={"name": "Home", "color": "blue"}).json()
    t = client.post("/api/tasks", json={
        "title": "Water the plants", "notes": "balcony", "priority": 2, "due": "2026-03-02", "labels": ["home"],
        "project_id": proj["id"], "remind_at": "2026-03-02T08:30",
        "repeat": {"every": "weekly", "days": [1, 4]}}).json()
    assert t["repeat"] == {"every": "weekly", "days": [1, 4]}
    done = client.patch(f"/api/tasks/{t['id']}", json={"status": "done"}).json()
    assert done["status"] == "done" and done["repeat"] is None          # the recurrence moved on
    rest = [x for x in client.get("/api/tasks").json()["tasks"] if x["id"] != t["id"]]
    (nxt,) = rest
    assert nxt["status"] == "todo" and nxt["due"] == "2026-03-05" and nxt["remind_at"] == "2026-03-05T08:30"
    assert (nxt["title"], nxt["notes"], nxt["priority"], nxt["labels"], nxt["project_id"]) == \
        ("Water the plants", "balcony", 2, ["home"], proj["id"])
    assert nxt["repeat"] == {"every": "weekly", "days": [1, 4]} and nxt["done_at"] is None
    # reopened and done again: no second occurrence
    client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"})
    client.patch(f"/api/tasks/{t['id']}", json={"status": "done"})
    assert len(client.get("/api/tasks").json()["tasks"]) == 2
    # the series goes on from the new one, also through the bulk route
    r = client.post("/api/tasks/bulk", json={"ids": [nxt["id"]], "patch": {"status": "done"}}).json()
    assert r["updated"] == 1
    dues = sorted(x["due"] for x in client.get("/api/tasks").json()["tasks"] if x["status"] == "todo")
    assert dues == ["2026-03-09"]


def test_repeat_validation_and_clearing(client, mx, monkeypatch):
    monkeypatch.setattr(tasks, "_today", lambda: D(2026, 3, 2))
    t = client.post("/api/tasks", json={"title": "Report", "repeat": {"every": "monthly"}}).json()
    assert t["repeat"] == {"every": "monthly"}
    for bad in ({"every": "weekly"}, {"every": "weekly", "days": [7]}, {"every": "monthly", "day": 32}):
        r = client.patch(f"/api/tasks/{t['id']}", json={"repeat": bad})
        assert r.status_code == 400 and r.json()["error"] == "invalid_repeat", bad
    assert client.patch(f"/api/tasks/{t['id']}", json={"repeat": {"every": "fortnightly"}}).status_code == 422
    # no due date: the next one is counted from today, and keeps the day of the month
    client.patch(f"/api/tasks/{t['id']}", json={"status": "done"})
    (nxt,) = [x for x in client.get("/api/tasks").json()["tasks"] if x["status"] == "todo"]
    assert nxt["due"] == "2026-04-02" and nxt["repeat"] == {"every": "monthly", "day": 2}
    assert client.patch(f"/api/tasks/{nxt['id']}", json={"repeat": None}).json()["repeat"] is None
    client.patch(f"/api/tasks/{nxt['id']}", json={"status": "done"})
    assert [x["status"] for x in client.get("/api/tasks").json()["tasks"]] == ["done", "done"]


def test_task_marked_done_in_the_file_repeats_on_the_next_pass(mx, monkeypatch):
    monkeypatch.setattr(tasks, "_today", lambda: D(2026, 3, 2))
    (mx["ws"] / "tasks.json").write_text(json.dumps({"version": 1, "projects": [], "tasks": [
        {"id": "t_aaaaaa", "title": "Backup", "status": "done", "due": "2026-03-01", "repeat": {"every": "daily"},
         "my_field": 1},
        {"id": "t_bbbbbb", "title": "Plain", "status": "done"}]}))
    (new,) = tasks.apply_recurrences()
    assert tasks.apply_recurrences() == []
    data = json.loads((mx["ws"] / "tasks.json").read_text())
    by = {t["id"]: t for t in data["tasks"]}
    assert by["t_aaaaaa"]["repeat"] is None and by["t_aaaaaa"]["my_field"] == 1
    assert by[new]["due"] == "2026-03-03" and by[new]["status"] == "todo" and "my_field" not in by[new]
