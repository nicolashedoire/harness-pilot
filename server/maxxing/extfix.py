""""Ask for a fix" on a broken extension: one message for the agent, sent where the extension was made.

The session that made an extension is the Atelier's provenance first (the session that proposed the active version,
maxxing.atelier `origin_session`); else the one recorded when an agent runs `pilot ext check <id>` from a harness-pilot
turn (`$MAXXING_SESSION`, see cmd_ext): `<state>/extension-origins.json` = `{id: {session, at}}`. The first session is
kept while it exists and is not archived; otherwise the next one that checks the extension takes its place.

`ask(id, error)` sends `prompt()` to that session (queued behind a running turn), or opens a session in the Harness topic
(`system/harness`, `smartupdate.update_topic_path()`) when none is recorded, it is gone or archived, or it refuses the
message (a team at work). `target(id)` says which it will be, for the line under the button.

The prompt (English, "Answer me in French." when the UI is French, like `smartupdate.fix_prompt`) names the extension
and its folder, what broke (the error the user saw, the load error, the runtime errors since its files last changed),
the files involved (absolute paths: the extension's own files and those its stacks name) and how to work (the skill,
`pilot ext check <id> --json` before and after).
"""
from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

from . import config, exterrors, extensions

ORIGINS = "extension-origins.json"
ERRORS_IN_PROMPT = 3
FILES_IN_PROMPT = 12
_SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")
_lock = threading.Lock()


def _path() -> Path:
    return config.STATE / ORIGINS


def _origins() -> dict:
    d = config.read_json(_path(), {})
    return d if isinstance(d, dict) else {}


def _live(sid: str | None) -> dict | None:
    """The session `sid` if it exists and is not archived."""
    if not sid or not _SID_RE.match(sid):
        return None
    from .sessions import service
    try:
        s = service.get_session(sid)
    except Exception:  # noqa: BLE001 - a damaged meta counts as gone here
        return None
    return s if s and not s.get("archived") else None


def record_origin(eid: str, sid: str | None) -> bool:
    """`sid` made (or is fixing) `eid`: kept unless another live session is already recorded. True when stored."""
    sid = (sid or "").strip()
    if not _live(sid):
        return False
    with _lock:
        data = _origins()
        old = (data.get(eid) or {}).get("session")
        if old == sid or _live(old):
            return False
        data[eid] = {"session": sid, "at": time.time()}
        config.write_json(_path(), data)
        return True


def origin(eid: str, data: dict | None = None) -> dict | None:
    """The session that made `eid` while it is live: {id, title, path}. The Atelier's provenance (the session that
    proposed the active version) first, then the session recorded by `pilot ext check`."""
    from . import atelier
    s = _live(atelier.origin_session(eid)) or _live(((data if data is not None else _origins()).get(eid) or {})
                                                    .get("session"))
    return {"id": s["id"], "title": s.get("title") or "", "path": s.get("path") or ""} if s else None


def origins(ids: list[str]) -> dict[str, dict | None]:
    """origin() of several extensions, reading the file once."""
    data = _origins()
    return {eid: origin(eid, data) for eid in ids}


# ---- the message ----------------------------------------------------------------------------------------------------
def _files(ext: extensions.Extension, errors: list[dict]) -> list[str]:
    """Absolute paths of the files to look at: the manifest, the code of its kind, the files its stacks name."""
    d = ext.dir
    names = ["block.json"] if ext.type == "block" else ["manifest.json"]
    if ext.type == "block":
        names.append(str((ext.block or {}).get("entry") or "block.html"))
    names += ["api.py", "page.js", "widget.html"]
    for e in errors:
        names += re.findall(r"([A-Za-z0-9_][\w./-]*\.(?:py|m?js|html|css|json))(?::\d+)", e.get("stack") or "")
    out: list[str] = []
    root = d.resolve()
    for n in names:
        try:
            p = (d / n).resolve(strict=True)
            p.relative_to(root)
        except (OSError, ValueError):
            continue
        if p.is_file() and str(p) not in out:
            out.append(str(p))
    return out[:FILES_IN_PROMPT]


def _when(at: Any) -> str:
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(float(at)))
    except (TypeError, ValueError):
        return ""


def _clean(error: dict | None, eid: str) -> dict | None:
    if not isinstance(error, dict) or not str(error.get("message") or "").strip():
        return None
    return {"where": "seen", "message": exterrors._text(error.get("message"), exterrors.MESSAGE_MAX).strip(),
            "stack": exterrors.trim_stack(error.get("stack") or "", eid), "at": None, "count": 1}


def prompt(ext: extensions.Extension, seen: dict | None = None) -> str:
    """The message of "Ask for a fix" for `ext`; `seen` = the error the user is looking at (from the UI)."""
    errors: list[dict] = []
    if ext.error:
        errors.append({"where": "load", "message": ext.error, "stack": "", "at": None, "count": 1})
    errors += exterrors.recent(ext.id, ext.dir)[:ERRORS_IN_PROMPT]
    shown = _clean(seen, ext.id)                   # the one on screen, unless it is one of the recorded ones already
    if shown and not any(shown["message"] in (e["message"], f"Unhandled rejection: {e['message']}") or
                         e["message"] in shown["message"] for e in errors):
        errors.insert(1 if ext.error else 0, shown)
    kind = {"widget": "HTML widget" if ext.has_html else "dashboard widget", "page": "page",
            "block": "conversation block plugin", "agent": "agent engine"}.get(ext.type, ext.type)
    lines = [f"My {kind} extension `{ext.id}` (\"{ext.label()}\", folder {ext.dir}) is broken. Fix it.", "",
             "What broke:"]
    for e in errors or [{"where": "seen", "message": "(no error message was recorded)", "stack": ""}]:
        head = {"load": "does not load", "seen": "the error I see", "card": "card()", "api": "handle() of its API",
                "widget": "in the widget", "page": "in the page"}.get(e["where"], e["where"])
        when = _when(e.get("at")) if e["where"] not in ("load", "seen") else ""
        count = f", {e['count']} times" if int(e.get("count") or 1) > 1 else ""
        lines.append(f"- {head}{f' ({when}{count})' if when else ''}: {e['message']}")
        lines += [f"    {x}" for x in (e.get("stack") or "").splitlines()[:6]]
    files = _files(ext, errors)
    if files:
        lines += ["", "Files:", *[f"- {f}" for f in files]]
    skill = "pilot-blocks" if ext.type == "block" else "pilot-widgets-pages"
    lines += ["", f"Use the skill {skill}. Run `pilot ext check {ext.id} --json` first (its `runtime_errors` list what "
                  f"broke while I used it), then fix it in its draft folder (`pilot ext draft {ext.id}` prints it: a copy "
                  f"of what runs), check it with `pilot ext check {ext.id} --dir <that folder>` until it exits 0 and "
                  f"propose it with `pilot ext propose {ext.id} --summary \"...\"` (I approve it in the Atelier), then "
                  "tell me in two or three plain sentences what was wrong and what you changed."]
    from .smartupdate import _reply_in
    return "\n".join(lines) + _reply_in()


# ---- where it goes --------------------------------------------------------------------------------------------------
def target(eid: str) -> dict:
    """{"session": {id, title, path}} (the session that made it) or {"topic": "<the Harness topic path>"}."""
    from .smartupdate import update_topic_path
    o = origin(eid)
    return {"session": o} if o else {"topic": update_topic_path()}


def deliver(sid: str | None, text: str, title: str) -> dict:
    """Send `text` to the live session `sid` (queued behind a running turn), else open a session in the Harness topic
    -> {session, reused: bool, queued: bool}. Raises sessions.service.SessionError when no session opens. Also used by
    the Atelier's "Request a change" (api/atelier)."""
    from .sessions import service
    from .smartupdate import update_topic_path
    if _live(sid):
        try:
            out = service.send_message(sid, text, source="web")
            return {"session": out.get("session") or service.get_session(sid), "reused": True,
                    "queued": bool(out.get("queued"))}
        except service.SessionError:
            pass                                       # a team at work, a session that went away: a new one
    s = service.create_session(update_topic_path(), message=text, title=title[:120], source="web")
    return {"session": s, "reused": False, "queued": False}


def ask(ext: extensions.Extension, seen: dict | None = None) -> dict:
    """Send the fix request -> {session, reused: bool}. Raises sessions.service.SessionError when no session opens."""
    o = origin(ext.id)
    out = deliver(o["id"] if o else None, prompt(ext, seen), f"Fix the extension {ext.label()}")
    return {"session": out["session"], "reused": out["reused"]}
