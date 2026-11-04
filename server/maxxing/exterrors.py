"""Runtime errors of extensions: what broke while the user used a widget or a page, kept for the agent that fixes it.

Recorded by the browser (`POST /api/extensions/{id}/errors`: an uncaught error or rejected promise in an HTML widget's
frame or in a page) and by the server itself (an exception of `card()` on the dashboard, of `handle()` behind
`/api/ext/<id>/...`). `<state>/extension-errors.json` = `{id: [{where, message, stack, at, count, sig}]}`, newest
first, at most `KEEP` per extension; the same `where` + `message` as the newest one only bumps its `count` and `at`.

`sig` = the newest modification time of the extension's files when the error was recorded: `recent()` returns only
the errors recorded since the files last changed (an agent's fix makes the old ones go away by itself); `clear()`
forgets them all. Reports from the browser are rate-limited per extension and in total (`allow()`).
"""
from __future__ import annotations

import os
import re
import threading
import time
import traceback
from collections import deque
from pathlib import Path

from . import config

FILE = "extension-errors.json"
KEEP = 10                      # errors kept per extension
MESSAGE_MAX = 500
STACK_LINES = 6
LINE_MAX = 240
WHERE = ("widget", "page", "card", "api")
CLIENT_WHERE = ("widget", "page")
RATE_WINDOW_S = 60.0
RATE_PER_EXT = 20              # browser reports per extension per minute
RATE_TOTAL = 120               # browser reports per minute, every extension together

_lock = threading.Lock()
_hits: dict[str, deque] = {}


def _path() -> Path:
    return config.STATE / FILE


def _load() -> dict:
    d = config.read_json(_path(), {})
    return d if isinstance(d, dict) else {}


def files_sig(ext_dir: Path) -> int:
    """Newest mtime (ns) of the extension's files, top level and one folder down (hidden ones skipped)."""
    newest = 0
    try:
        entries = list(ext_dir.iterdir())
    except OSError:
        return 0
    for p in entries:
        if p.name.startswith("."):
            continue
        try:
            kids = list(p.iterdir()) if p.is_dir() else [p]
            for q in kids:
                if not q.name.startswith(".") and q.is_file():
                    newest = max(newest, q.stat().st_mtime_ns)
        except OSError:
            continue
    return newest


def allow(eid: str, now: float | None = None) -> bool:
    """May the browser report one more error of `eid` now? (sliding windows, per extension and in total)"""
    now = time.time() if now is None else now
    with _lock:
        queues = [(_hits.setdefault(eid, deque()), RATE_PER_EXT), (_hits.setdefault("*", deque()), RATE_TOTAL)]
        for q, cap in queues:
            while q and now - q[0] > RATE_WINDOW_S:
                q.popleft()
            if len(q) >= cap:
                return False
        for q, _ in queues:
            q.append(now)
        return True


def _text(s: object, cap: int) -> str:
    s = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(s if s is not None else ""))
    return s if len(s) <= cap else s[: cap - 1] + "…"


def trim_stack(stack: object, eid: str, frame_offset: int = 0) -> str:
    """At most STACK_LINES short lines, the app's own addresses made relative: `https://host/ext/<id>/@17/page.js:12:5`
    -> `page.js:12:5` (the version segment and a query left out); a widget frame's positions become widget.html's (`frame_offset` = the lines the server serves
    before widget.html)."""
    pre = re.escape(f"/ext/{eid}/")
    frame_re = re.compile(r"(?:https?://[^/\s)]+)?" + pre + r"widget-frame(?:#[^:\s)]*)?:(\d+):(\d+)")
    file_re = re.compile(r"(?:https?://[^/\s)]+)?" + pre + r"(?:@[^/\s)]+/)?([^?#:\s)]+)(?:\?[^:\s)]*)?")

    def frame(m: re.Match) -> str:
        line = int(m.group(1)) - frame_offset
        return f"widget.html:{line}:{m.group(2)}" if line > 0 else f"widget-frame:{m.group(1)}:{m.group(2)}"
    out = []
    for raw in str(stack or "").splitlines():
        s = raw.strip()
        if not s:
            continue
        s = file_re.sub(r"\1", frame_re.sub(frame, s))
        s = re.sub(r"https?://[^/\s)]+(?=/)", "", s)          # any other address of the app: its path
        out.append(_text(s, LINE_MAX))
        if len(out) >= STACK_LINES:
            break
    return "\n".join(out)


def ext_frames(exc: BaseException, ext_dir: Path, keep: int = 5) -> list[str]:
    """The frames of an exception inside the extension's folder, innermost last: `api.py:12 in card: x = d["k"]`."""
    root = str(ext_dir.resolve())
    out = []
    for fr in traceback.extract_tb(exc.__traceback__):
        try:
            p = str(Path(fr.filename).resolve())
        except OSError:
            continue
        if p.startswith(root + os.sep):
            out.append(f"{os.path.relpath(p, root)}:{fr.lineno} in {fr.name}" + (f": {fr.line}" if fr.line else ""))
    return out[-keep:]


def record(eid: str, ext_dir: Path, where: str, message: object, stack: object = "", at: float | None = None) -> dict:
    """Add one error (or bump the newest one when it is the same) -> the stored entry. Blocking (writes state)."""
    if where not in WHERE:
        raise ValueError(f"where must be one of {', '.join(WHERE)}")
    msg = _text(message, MESSAGE_MAX).strip() or "Error"
    item = {"where": where, "message": msg, "stack": str(stack or ""), "at": time.time() if at is None else at,
            "count": 1, "sig": files_sig(ext_dir)}
    with _lock:
        data = _load()
        rows = [r for r in data.get(eid) or [] if isinstance(r, dict)]
        top = rows[0] if rows else None
        if top and top.get("where") == where and top.get("message") == msg and top.get("sig") == item["sig"]:
            top.update(at=item["at"], stack=item["stack"] or top.get("stack", ""), count=int(top.get("count") or 1) + 1)
            item = top
        else:
            rows.insert(0, item)
        data[eid] = rows[:KEEP]
        config.write_json(_path(), data)
    return item


def recent(eid: str, ext_dir: Path, data: dict | None = None) -> list[dict]:
    """The errors recorded since the extension's files last changed, newest first (without `sig`)."""
    rows = (data if data is not None else _load()).get(eid) or []
    sig = files_sig(ext_dir)
    return [{k: r.get(k) for k in ("where", "message", "stack", "at", "count")}
            for r in rows if isinstance(r, dict) and r.get("sig") == sig]


def all_recent(exts: list) -> dict[str, list[dict]]:
    """recent() of each extension, reading the file once."""
    data = _load()
    return {e.id: recent(e.id, e.dir, data) for e in exts} if data else {}


def clear(eid: str) -> bool:
    """Forget the errors of `eid`. True when there were some."""
    with _lock:
        data = _load()
        if eid not in data:
            return False
        del data[eid]
        config.write_json(_path(), data)
        return True
