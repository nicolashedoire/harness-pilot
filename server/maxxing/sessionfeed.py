"""Session events in the notifications feed (built-in source "sessions"), registered by api/feed.startup on
sessions.service.on_session_stop:

- a session (not a cron job's) stops running -> `session.done` (success) or `session.failed` (error), folded per
  session (group `session:<id>`); a done resolves that session's pending failure. A mixed-team worker on its team
  assignment (`team_turn`) stays out: the team notifies once, when its coordinator's synthesis ends;
- a Claude Code + Codex discussion / debate paused by its turn or duration limit -> `discussion.paused` (warning,
  group `discussion:<id>`, actions Resume + Open), resolved by sessions.service when it runs again (resume, a new
  message, Stop, deletion).

Telegram rule of the source: "off" by default (sessions are mirrored to Telegram already). See docs/dev/API.md#feed.
"""
from __future__ import annotations

import asyncio
import logging
from urllib.parse import quote

from . import feed

log = logging.getLogger("maxxing.feed")

SUMMARY_KINDS = ("compact", "handoff", "seed")     # a summary turn ended: nothing to tell (its failure still is)


def session_url(s: dict) -> str:
    return f"/sessions?path={quote(str(s.get('path') or ''), safe='')}&session={s.get('id', '')}"


async def on_stop(session: dict) -> None:
    """sessions.service.on_session_stop callback (event loop): the feed write runs in a thread."""
    await asyncio.to_thread(record, session)


def _limits(s: dict) -> tuple[int, int | None, int, int | None]:
    def num(v) -> int | None:
        try:
            return int(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None
    return (num(s.get("discussion_turns")) or 0, num(s.get("discussion_turn_limit")),
            int(float(s.get("discussion_elapsed") or 0)), num(s.get("discussion_duration_seconds")))


def record(s: dict) -> dict | None:
    """Post what a stopped session means for the feed. Never raises; returns the event (or None)."""
    try:
        return _record(s)
    except Exception:  # noqa: BLE001 - the feed never breaks the session watcher
        log.exception("feed: session event of %s failed", s.get("id"))
        return None


def _record(s: dict) -> dict | None:
    if s.get("cron") or s.get("source") == "cron":   # cron runs report as cron.succeeded / cron.failed
        return None
    if s.get("team_turn"):                            # a team worker: its coordinator reports for the whole team
        return None
    sid = str(s.get("id") or "")
    if not sid:
        return None
    title = str(s.get("title") or "Untitled")
    provider = str(s.get("provider") or "claude")
    url = session_url(s)
    open_session = feed.link("open_session", "Open", url)
    base = {"session_id": sid, "title": title, "path": str(s.get("path") or ""), "provider": provider}
    if provider in ("discussion", "debate") and s.get("debate_paused") and s.get("discussion_pause_reason") == "limit":
        turns, turn_limit, elapsed, duration_limit = _limits(s)
        by_turns = bool(turn_limit) and turns >= turn_limit
        why = (f"The turn limit was reached ({turns} turns)." if by_turns
               else f"The time limit was reached ({max(1, elapsed // 60)} min).")
        return feed.system(f"Discussion paused: {title}", why, "warning", "sessions", url, group=f"discussion:{sid}",
                           kind="discussion.paused",
                           params={**base, "turns": turns, "turn_limit": turn_limit, "duration_s": elapsed,
                                   "duration_limit_s": duration_limit},
                           actions=[feed.post_action("resume", "Resume", f"/api/sessions/{sid}/discussion/resume"),
                                    open_session])
    if s.get("state") == "error":
        err = str(s.get("error") or "The turn failed")
        return feed.system(f"Session failed: {title}", err, "error", "sessions", url, group=f"session:{sid}",
                           kind="session.failed", params={**base, "error": err[:300]}, actions=[open_session])
    last = s.get("last_turn") if isinstance(s.get("last_turn"), dict) else {}
    if (last.get("kind") or "user") in SUMMARY_KINDS:
        return None
    feed.system_resolve("sessions", f"session:{sid}")  # it works again: its pending failure is over
    return feed.system(f"Session finished: {title}", str(s.get("last_text") or ""), "success", "sessions", url,
                       group=f"session:{sid}", kind="session.done",
                       params={**base, "turns": int(s.get("turns") or 0)}, actions=[open_session])
