"""Token and cost statistics over the sessions (Settings -> Stats). See docs/dev/API.md#stats.

Every turn adds its usage to the session meta (`tokens`, `days`: sessions/store.add_usage). Sessions
created before those counters existed are backfilled once from their log (the raw Claude `result`
lines), then kept current by the runner. A running session is never backfilled (its last result
would be counted twice): it is counted from its log without saving, until it is idle.

Codex turns recorded before cached input was split out (their result has no `cache_creation_input_tokens` and no
`total_cost_usd`, and its `input_tokens` still held the cache reads, counted again as `cache_read`) are recalculated
once per session from the log: the double-counted part leaves `tokens.input` and the day totals (`usage_fixes`).
Codex reports no cost and no plan limits in its turn events: `cost_usd` is Claude's own estimate only.
"""
from __future__ import annotations

import json
import math
import threading
import time

from .sessions import store

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "data": None}
CACHE_S = 20.0


CODEX_SESSIONS = ('codex', 'discussion', 'debate')     # the sessions where a Codex turn can have run


def _codex_overcount(ev: dict) -> int:
    """The tokens a Codex turn from before the cached-input split counted twice (0 for any other result)."""
    usage = ev.get("usage")
    if (ev.get("type") != "result" or not isinstance(usage, dict) or "cache_creation_input_tokens" in usage
            or "total_cost_usd" in ev):
        return 0
    return min(_int(usage.get("input_tokens")), _int(usage.get("cache_read_input_tokens")))


def _scan_log(sid: str, codex: bool = False) -> dict:
    tk = store.empty_tokens()
    try:
        with open(store.log_path(sid), "rb") as f:
            for raw in f:
                if b'"result"' not in raw or b'"usage"' not in raw:
                    continue
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(ev, dict) or ev.get("type") != "result" or not isinstance(ev.get("usage"), dict):
                    continue
                for k, src in store.TOKEN_KEYS:
                    tk[k] += _int(ev["usage"].get(src))
                if codex:
                    tk["input"] -= _codex_overcount(ev)
    except OSError:
        pass
    return tk


def _recount_codex(sid: str, m: dict) -> dict | None:
    """Once per Codex / discussion session: remove from its counters the cached tokens its older Codex turns counted
    twice. Returns the fix recorded in the meta ({turns, tokens}), None when the session needs none."""
    fixes = m.get("usage_fixes") if isinstance(m.get("usage_fixes"), dict) else {}
    if isinstance(fixes.get("codex_cached"), dict):
        return fixes["codex_cached"]
    if m.get("provider") not in CODEX_SESSIONS:
        return None
    turns, total, per_day = 0, 0, {}
    try:
        with open(store.log_path(sid), "rb") as f:
            for raw in f:
                if b'"result"' not in raw or b'cache_read_input_tokens' not in raw or b'cache_creation_input' in raw:
                    continue
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                over = _codex_overcount(ev) if isinstance(ev, dict) else 0
                if over:
                    turns, total = turns + 1, total + over
                    at = ev.get("mx_at")
                    if _finite(at):
                        day = time.strftime("%Y-%m-%d", time.localtime(at))
                        per_day[day] = per_day.get(day, 0) + over
    except OSError:
        return None
    fix = {"turns": turns, "tokens": total}
    try:
        with store.edit(sid) as cur:
            done = cur.get("usage_fixes") if isinstance(cur.get("usage_fixes"), dict) else {}
            if isinstance(done.get("codex_cached"), dict):      # another request recalculated it meanwhile
                return done["codex_cached"]
            if isinstance(cur.get("tokens"), dict):              # else the backfill (_scan_log) leaves them out
                cur["tokens"]["input"] = max(0, _int(cur["tokens"].get("input")) - total)
            days = cur.get("days") if isinstance(cur.get("days"), dict) else {}
            for day, over in per_day.items():
                if isinstance(days.get(day), dict):
                    days[day]["tokens"] = max(0, _int(days[day].get("tokens")) - over)
            cur["usage_fixes"] = {**done, "codex_cached": fix}
    except (KeyError, OSError):
        return None
    return fix



def _int(v) -> int:
    """A counter from a meta or a log; anything that is not a number (hand edit, other tool) counts as 0."""
    try:
        return int(v or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _float(v) -> float:
    try:
        f = float(v or 0)
    except (TypeError, ValueError):
        return 0.0
    return f if math.isfinite(f) else 0.0


def _tokens(sid: str, m: dict) -> dict:
    if isinstance(m.get("tokens"), dict):
        return {k: _int(m["tokens"].get(k)) for k, _ in store.TOKEN_KEYS}
    turns = _int(m.get("turns"))
    tk = _scan_log(sid, codex=m.get("provider") in CODEX_SESSIONS)
    if m.get("state") != "running":
        try:
            with store.edit(sid) as cur:
                # A turn that ran during the scan may be missing from `tk`: keep it unsaved, rescan next time.
                if (not isinstance(cur.get("tokens"), dict) and cur.get("state") != "running"
                        and _int(cur.get("turns")) == turns):
                    cur["tokens"] = tk
        except (KeyError, OSError):
            pass
    return tk


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _when(v):
    """A date of a meta (Unix seconds or ISO text); anything else (NaN, a list...) would break the JSON answer."""
    return v if isinstance(v, str) or _finite(v) else None


def _project_of(path: str) -> str:
    parts = (path or "").split("/")
    return parts[1] if len(parts) >= 2 and parts[0] == "projects" else ""


def _add(acc: dict, tk: dict, cost: float, turns: int) -> None:
    for k in tk:
        acc[k] = acc.get(k, 0) + tk[k]
    acc["total"] = acc.get("total", 0) + sum(tk.values())
    acc["cost_usd"] = round(acc.get("cost_usd", 0.0) + cost, 6)
    acc["turns"] = acc.get("turns", 0) + turns
    acc["sessions"] = acc.get("sessions", 0) + 1


def _median(values: list[float]) -> float | None:
    v = sorted(values)
    if not v:
        return None
    mid = len(v) // 2
    return round(v[mid] if len(v) % 2 else (v[mid - 1] + v[mid]) / 2, 3)


def compute() -> dict:
    totals: dict = {}
    projects: dict[str, dict] = {}
    topics: dict[str, dict] = {}
    days: dict[str, dict] = {}
    sessions = []
    starts: list[float] = []
    firsts: list[float] = []
    providers = {name: {**store.empty_tokens(), 'total': 0, 'turns': 0} for name in ('claude', 'codex')}
    corrected = {"turns": 0, "tokens": 0}
    for sid in store.list_ids():
        m = store.read_cached(sid)          # shared, never mutated here: unchanged metas are not parsed again
        if m is None:
            continue
        fix = _recount_codex(sid, m)
        if fix is not None:
            corrected["turns"] += _int(fix.get("turns"))
            corrected["tokens"] += _int(fix.get("tokens"))
            fixes = m.get("usage_fixes")
            if not (isinstance(fixes, dict) and isinstance(fixes.get("codex_cached"), dict)):
                m = store.read(sid) or m    # just recalculated: count the corrected meta
        tk = _tokens(sid, m)
        cost = _float(m.get("cost_usd"))
        turns = _int(m.get("turns"))
        latency = m.get("latency")
        for pair in latency if isinstance(latency, list) else []:
            if isinstance(pair, list) and pair and _finite(pair[0]):
                starts.append(float(pair[0]))
                if len(pair) > 1 and _finite(pair[1]):
                    firsts.append(float(pair[1]))
        path = m.get("path") if isinstance(m.get("path"), str) else ""
        _add(totals, tk, cost, turns)
        tracked = m.get('provider_usage') if isinstance(m.get('provider_usage'), dict) else {}
        for name in tracked:
            if isinstance(name, str) and name.startswith('plugin:') and len(name) <= 64:
                providers.setdefault(name, {**store.empty_tokens(), 'total': 0, 'turns': 0,
                    'name': m.get('provider_name') or name})
        for name, acc in providers.items():
            p = tracked.get(name) if isinstance(tracked.get(name), dict) else {}
            for key, _ in store.TOKEN_KEYS:
                acc[key] += _int(p.get(key))
            acc['turns'] += _int(p.get('turns'))
        _add(projects.setdefault(_project_of(path), {"name": _project_of(path)}), tk, cost, turns)
        _add(topics.setdefault(path, {"path": path}), tk, cost, turns)
        for day, d in (m.get("days") if isinstance(m.get("days"), dict) else {}).items():
            if isinstance(d, dict):
                cur = days.setdefault(day, {"date": day, "tokens": 0, "cost_usd": 0.0})
                cur["tokens"] += _int(d.get("tokens"))
                cur["cost_usd"] = round(cur["cost_usd"] + _float(d.get("cost")), 6)
        title = m.get("title") if isinstance(m.get("title"), str) else ""
        sessions.append({"id": sid, "title": title or "Untitled", "path": path,
                         "archived": bool(m.get("archived")), "updated": _when(m.get("updated")) or _when(m.get("created")),
                         **tk, "total": sum(tk.values()), "cost_usd": round(cost, 6), "turns": turns})
    by_total = lambda x: (x.get("total", 0), x.get("cost_usd", 0))  # noqa: E731
    sessions.sort(key=by_total, reverse=True)
    for p in providers.values():
        p['total'] = sum(p[k] for k, _ in store.TOKEN_KEYS)
    return {
        "totals": totals or {**store.empty_tokens(), "total": 0, "cost_usd": 0.0, "turns": 0, "sessions": 0},
        "projects": sorted(projects.values(), key=by_total, reverse=True),
        "topics": sorted(topics.values(), key=by_total, reverse=True),
        "sessions": sessions[:100],
        "days": [days[k] for k in sorted(days)][-store.DAYS_KEPT:],
        "providers": providers,
        "unattributed_turns": max(0, int(totals.get('turns', 0)) - sum(p['turns'] for p in providers.values())),
        "corrected": corrected,
        # recent turns of every session: seconds until Claude Code's first event / its first answer
        "latency": {"start_s": _median(starts), "first_answer_s": _median(firsts), "turns": len(starts)},
        "at": time.time(),
    }


def tokens(force: bool = False) -> dict:
    with _lock:
        if force or _cache["data"] is None or time.time() - _cache["at"] > CACHE_S:
            _cache["data"], _cache["at"] = compute(), time.time()
        return _cache["data"]
