"""Notifications feed: events from the system (cron runs, sessions, updates, backups, sign-ins, health), from webhooks
(Stripe, Shopify, GitHub, generic JSON) and from any script (`pilot feed post`), shown on the dashboard and the
notifications page, optionally posted to the Telegram "Notifications" thread and pushed to browsers (push.py).
See docs/user/24-feed.md and docs/dev/API.md#feed-notifications.

Storage: <state>/feed.db (sqlite3, WAL) - written by the server and by CLI processes (cron runs).
An event: {id, at, source, level, title, body, url, count, read, kind, params, actions, category, pending,
resolved_at, first_at}. `kind` is a stable dotted key (KINDS) and `params` the values of its translation: `title` /
`body` stay the English fallback. `dedupe` makes a post idempotent per source (a webhook delivered twice); `group`
folds repeats into one row while it is unread and not resolved ("Cron jobs succeeded x12", its `occurrences` kept for
the detail view). A warning / error that is unread and not resolved is *pending* ("needs attention"); its producer
resolves it when the problem goes away (`resolve(source, group)`). Events older than RETENTION_DAYS are removed.

Telegram routing (config `feed`): per kind rule (`kind_rules`), else per source rule (`rules`): "off" | "silent" |
"loud" | "auto" (default). Auto goes by level: error -> loud, warning -> silent, info / success -> off. The built-in
sources that already have their own Telegram thread or are mirrored there (crons, security, system, sessions) default
to "off".
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from . import bus, config

log = logging.getLogger("maxxing.feed")

LEVELS = ("info", "success", "warning", "error")
PROBLEM_LEVELS = ("warning", "error")              # the levels that can be pending / resolved
RULES = ("auto", "off", "silent", "loud")
RETENTION_DAYS = 30
GROUP_WINDOW_S = 24 * 3600
TITLE_MAX, BODY_MAX = 200, 4000
SOURCE_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,39}$")
KIND_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
PARAM_RE = re.compile(r"^[a-z_][a-z0-9_]{0,31}$")
ACTION_ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
PARAMS_MAX, PARAM_TEXT_MAX = 20, 500
ACTIONS_MAX, LABEL_MAX = 4, 60
OCCURRENCES_MAX, OCCURRENCE_BODY_MAX = 20, 300
# Built-in sources: they already report in their own Telegram thread (Crons; Alerts: gateway.alert / system_alert),
# or are mirrored there (sessions).
BUILTIN = {"crons": "Cron jobs", "system": "harness-pilot", "security": "Sign-ins", "sessions": "Sessions"}
OWN_THREAD = {"crons", "system", "security", "sessions"}
CATEGORIES = ("sessions", "crons", "system", "webhooks")
_CATEGORY = {"sessions": "sessions", "crons": "crons", "system": "system", "security": "system", "infra": "system"}
# `post` actions: only built-in producers make them, and only for these server routes (the web runs them as POST).
POST_ACTIONS = (re.compile(r"^/api/crons/[A-Za-z0-9_-]{1,64}/run$"),
                re.compile(r"^/api/sessions/[A-Za-z0-9-]{1,64}/discussion/resume$"))
# kind -> (source, typical level). Source "" = the webhook kinds (any hook name; not reserved). The kinds of a built-in
# source (sessions, crons, system, security, infra) are reserved: an external post cannot use them.
KINDS: dict[str, tuple[str, str]] = {
    "session.done": ("sessions", "success"),
    "session.failed": ("sessions", "error"),
    "discussion.paused": ("sessions", "warning"),
    "cron.succeeded": ("crons", "success"),
    "cron.failed": ("crons", "error"),
    "cron.caught_up": ("crons", "info"),
    "update.available": ("system", "info"),
    "update.attention": ("system", "warning"),
    "update.review": ("system", "info"),
    "update.started": ("system", "info"),
    "update.broken": ("system", "warning"),
    "claude.updated": ("system", "success"),
    "claude.update_failed": ("system", "error"),
    "deps.vulnerable": ("system", "warning"),
    "deps.update_failed": ("system", "warning"),
    "health.issue": ("system", "warning"),
    "pr_queue.merged": ("system", "success"),
    "pr_queue.review": ("system", "warning"),
    "companion.ready": ("system", "warning"),
    "companion.empty": ("system", "info"),
    "companion.error": ("system", "warning"),
    "mission.review": ("system", "warning"),
    "mission.completed": ("system", "info"),
    "task.reminder": ("system", "warning"),
    "atelier.proposed": ("system", "warning"),
    "atelier.activated": ("system", "success"),
    "signin.ok": ("security", "info"),
    "signin.failed": ("security", "warning"),
    "signin.denied": ("security", "warning"),
    "webhook.refused": ("security", "warning"),
    "backup.restore_held": ("security", "warning"),
    "extension.legacy_secrets": ("security", "info"),
    "extension.legacy_network": ("security", "info"),
    "instance_backup.copy_failed": ("system", "error"),
    "instance_backup.failed": ("system", "error"),
    "infra.down": ("infra", "error"),
    "infra.up": ("infra", "success"),
    "infra.cert_expiring": ("infra", "warning"),
    "infra.domain_expiring": ("infra", "warning"),
    "webhook.test": ("", "info"),
    "stripe.sale": ("", "success"),
    "stripe.payment": ("", "success"),
    "stripe.refund": ("", "warning"),
    "stripe.payment_failed": ("", "error"),
    "stripe.dispute": ("", "error"),
    "stripe.subscription_created": ("", "success"),
    "stripe.subscription_cancelled": ("", "warning"),
    "stripe.event": ("", "info"),
    "shopify.order_created": ("", "success"),
    "shopify.order_paid": ("", "success"),
    "shopify.order_cancelled": ("", "warning"),
    "shopify.refund": ("", "warning"),
    "shopify.stock": ("", "info"),
    "shopify.event": ("", "info"),
    "github.ping": ("", "success"),
    "github.push": ("", "info"),
    "github.pull_request": ("", "info"),
    "github.issue": ("", "info"),
    "github.workflow": ("", "success"),
    "github.release": ("", "success"),
    "github.star": ("", "info"),
    "github.event": ("", "info"),
    "custom": ("", "info"),
}

_lock = threading.Lock()
_ready: set[str] = set()


class FeedError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# ---- storage -------------------------------------------------------------------------------
def db_path() -> Path:
    return config.state_dir() / "feed.db"


def _conn() -> sqlite3.Connection:
    path = db_path()
    key = str(path)
    try:
        return _open(path, key)
    except sqlite3.DatabaseError as e:
        if key in _ready or not _damaged(e):
            raise                                      # busy, disk full, too many files...: never set a good base aside
    # Unreadable feed.db (not a database, corrupted): set it aside and start a fresh one, or the feed and every
    # system notification (crons, updates, sign-ins) would fail from now on.
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for suffix in ("", "-wal", "-shm"):
        try:
            os.replace(f"{path}{suffix}", f"{path}.damaged-{stamp}{suffix}")
        except OSError:
            pass
    log.warning("feed.db was unreadable: moved to feed.db.damaged-%s, starting a new feed", stamp)
    return _open(path, key)


def _damaged(e: sqlite3.DatabaseError) -> bool:
    """The file itself is broken (not a passing error such as a lock, a full disk or too many open files)."""
    text = str(e).lower()
    return "not a database" in text or "malformed" in text or "corrupt" in text


# Columns added after the first schema (2.0.0a108 and older have only the first line's): an older feed.db gets them
# with ALTER TABLE on its first open; its rows read as kind "custom", no params / actions, never resolved, not quiet.
_ADDED = (("kind", "TEXT NOT NULL DEFAULT 'custom'"), ("params", "TEXT NOT NULL DEFAULT '{}'"),
          ("actions", "TEXT NOT NULL DEFAULT '[]'"), ("resolved_at", "REAL"), ("first_at", "REAL"),
          ("occurrences", "TEXT NOT NULL DEFAULT '[]'"), ("quiet", "INTEGER NOT NULL DEFAULT 0"))


def _migrate(c: sqlite3.Connection) -> None:
    have = {r[1] for r in c.execute("PRAGMA table_info(events)")}
    for name, decl in _ADDED:
        if name in have:
            continue
        try:
            c.execute(f"ALTER TABLE events ADD COLUMN {name} {decl}")
        except sqlite3.OperationalError as e:          # another process (a cron run) added it meanwhile
            if "duplicate column" not in str(e).lower():
                raise
    c.execute("CREATE INDEX IF NOT EXISTS events_grp ON events(source, grp)")
    c.commit()


def _open(path: Path, key: str) -> sqlite3.Connection:
    if not Path(path).exists():
        os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))     # private from the first byte
    c = sqlite3.connect(path, timeout=10)
    c.row_factory = sqlite3.Row
    if key not in _ready:
        with _lock:
            try:
                c.execute("PRAGMA journal_mode=WAL")
            except sqlite3.DatabaseError:
                c.close()
                raise
            c.executescript("""
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    at REAL NOT NULL, source TEXT NOT NULL, level TEXT NOT NULL,
                    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
                    dedupe TEXT, grp TEXT, count INTEGER NOT NULL DEFAULT 1, read INTEGER NOT NULL DEFAULT 0,
                    kind TEXT NOT NULL DEFAULT 'custom', params TEXT NOT NULL DEFAULT '{}',
                    actions TEXT NOT NULL DEFAULT '[]', resolved_at REAL, first_at REAL,
                    occurrences TEXT NOT NULL DEFAULT '[]', quiet INTEGER NOT NULL DEFAULT 0);
                CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe ON events(source, dedupe) WHERE dedupe IS NOT NULL;
                CREATE INDEX IF NOT EXISTS events_at ON events(at);
                CREATE INDEX IF NOT EXISTS events_src ON events(source, read);
            """)
            _migrate(c)
            _ready.add(key)
    return c


_ID_MAX = 2**63 - 1                                                   # SQLite INTEGER


def _id(v) -> int | None:
    """An event id SQLite can hold, else None (a bigger int raises OverflowError: a 500)."""
    v = int(v)
    return v if -_ID_MAX <= v <= _ID_MAX else None


def _json(text: Any, want: type) -> Any:
    try:
        v = json.loads(text) if isinstance(text, str) else None
    except ValueError:
        v = None
    return v if isinstance(v, want) else want()


def category(source: str) -> str:
    """The type filter of the UI: sessions, crons, system (system, security, infra), webhooks (everything else)."""
    return _CATEGORY.get(source, "webhooks")


def _row(r: sqlite3.Row, detail: bool = False) -> dict:
    read, resolved = bool(r["read"]), r["resolved_at"]
    ev = {"id": r["id"], "at": r["at"], "source": r["source"], "level": r["level"], "title": r["title"],
          "body": r["body"], "url": r["url"], "count": r["count"], "read": read,
          "kind": r["kind"] or "custom", "params": _json(r["params"], dict), "actions": _json(r["actions"], list),
          "category": category(r["source"]),
          "pending": r["level"] in PROBLEM_LEVELS and not read and resolved is None,
          "resolved_at": resolved, "first_at": r["first_at"] or r["at"], "quiet": bool(r["quiet"])}
    if detail:
        occ = _json(r["occurrences"], list)
        ev["occurrences"] = occ or [_occurrence(r["at"], r["title"], r["body"], ev["params"])]
    return ev


def _occurrence(at: float, title: str, body: str, params: dict) -> dict:
    return {"at": at, "title": title, "body": (body or "")[:OCCURRENCE_BODY_MAX], "params": params}


def clean_source(source: str | None) -> str:
    s = re.sub(r"[^a-z0-9_.-]+", "-", (source or "custom").strip().lower()).strip("-.")[:40] or "custom"
    if not SOURCE_RE.match(s):
        raise FeedError(400, "bad_source", "Source: letters, digits, - _ . (max 40)")
    return s


def clean_kind(kind: str | None, trusted: bool = False) -> str:
    k = (kind or "custom").strip().lower()
    if not KIND_RE.match(k):
        raise FeedError(400, "bad_kind", "Kind: lowercase letters, digits, . _ - (max 64)")
    if not trusted and KINDS.get(k, ("",))[0]:
        raise FeedError(400, "bad_kind", f"{k!r} is a built-in kind")
    return k


def clean_params(params: Any, strict: bool = True) -> dict:
    """`params` of an event: <= 20 names, values string (<= 500 chars) / number / boolean / null. `strict` (external
    posts) refuses anything else with 400 bad_params; built-in producers get theirs coerced (never lose the event)."""
    if params is None:
        return {}
    if not isinstance(params, dict) or (strict and len(params) > PARAMS_MAX):
        if strict:
            raise FeedError(400, "bad_params", f"params: an object of at most {PARAMS_MAX} names")
        return {}
    out: dict = {}
    for k, v in list(params.items())[:PARAMS_MAX]:
        if not isinstance(k, str) or not PARAM_RE.match(k):
            if strict:
                raise FeedError(400, "bad_params", f"params: bad name {str(k)[:40]!r}")
            continue
        if v is None or isinstance(v, bool):
            out[k] = v
        elif isinstance(v, int):
            out[k] = v if abs(v) <= 2**53 else str(v)  # JavaScript numbers
        elif isinstance(v, float):
            out[k] = v if math.isfinite(v) else None   # NaN / Infinity: not valid JSON
        elif isinstance(v, str):
            out[k] = _utf8(v)[:PARAM_TEXT_MAX]
        elif strict:
            raise FeedError(400, "bad_params", f"params.{k}: string, number, boolean or null")
        else:
            out[k] = _utf8(str(v))[:PARAM_TEXT_MAX]
    return out


def _app_or_https(url: str) -> bool:
    """An app path ("/crons?job=..."), not another site dressed as one ("//host", "/\\host"), or an https:// URL."""
    return bool(re.match(r"^/(?![/\\])", url) or re.match(r"^https://\S+$", url))


def clean_actions(actions: Any, trusted: bool = False, strict: bool = True) -> list[dict]:
    """[{id, label, type: "link"|"post", url}]. `post` only when `trusted` (built-in producers) and only for
    POST_ACTIONS; `link` only to an app path or an https:// URL. `strict` raises 400 bad_action, else drops."""
    if not actions:
        return []
    if not isinstance(actions, list):
        if strict:
            raise FeedError(400, "bad_action", "actions: a list")
        return []
    out: list[dict] = []
    for a in actions:
        try:
            if not isinstance(a, dict):
                raise ValueError("Action: {id, label, type, url}")
            aid = str(a.get("id") or "").strip()
            label = " ".join(_utf8(str(a.get("label") or "")).split())[:LABEL_MAX]
            typ = a.get("type") or "link"
            url = _utf8(str(a.get("url") or "")).strip()
            if not ACTION_ID_RE.match(aid) or not label:
                raise ValueError("Action: an id ([a-z0-9_-], max 32) and a label")
            if len(url) > 1000:
                raise ValueError("Action: url too long")
            if typ == "post":
                if not trusted:
                    raise ValueError("Only link actions can be given")
                if not any(p.match(url) for p in POST_ACTIONS):
                    raise ValueError("This action cannot be posted")
            elif typ == "link":
                if not _app_or_https(url):
                    raise ValueError("A link action opens an app path (/...) or an https:// URL")
            else:
                raise ValueError('Action type: "link" or "post"')
            out.append({"id": aid, "label": label, "type": typ, "url": url})
        except ValueError as e:
            if strict:
                raise FeedError(400, "bad_action", str(e)) from None
    if len(out) > ACTIONS_MAX:
        if strict:
            raise FeedError(400, "bad_action", f"At most {ACTIONS_MAX} actions")
        out = out[:ACTIONS_MAX]
    return out


# ---- write ---------------------------------------------------------------------------------
def _utf8(s: str | None) -> str | None:
    """A lone surrogate (JSON "\\ud800" is valid) cannot be stored by SQLite: replaced by "?"."""
    return s.encode("utf-8", "replace").decode("utf-8") if isinstance(s, str) else s


def _dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def post(title: str, body: str = "", level: str = "info", source: str = "custom", url: str = "",
         dedupe: str | None = None, group: str | None = None, notify: bool = True, *, kind: str | None = "custom",
         params: dict | None = None, actions: list | None = None, trusted: bool = False) -> dict | None:
    """Add an event. Returns it, or None when `dedupe` says it was already posted. `trusted` = a built-in producer of
    this server (reserved kinds, `post` actions, lenient params); everything external is not. `notify=False` = quiet:
    the new row is neither sent to Telegram nor pushed (column `quiet`; a fold keeps the flag of the row it grows)."""
    title, body, url = _utf8(title), _utf8(body), _utf8(url)
    dedupe, group = (_utf8(str(v)) if v else v for v in (dedupe, group))
    title = " ".join((title or "").split())[:TITLE_MAX]
    if not title:
        raise FeedError(400, "empty", "An event needs a title")
    if level not in LEVELS:
        raise FeedError(400, "bad_level", f"Level: {', '.join(LEVELS)}")
    source = clean_source(source)
    kind = clean_kind(kind, trusted)
    params = clean_params(params, strict=not trusted)
    acts = clean_actions(actions, trusted, strict=not trusted)
    body = (body or "").strip()[:BODY_MAX]
    url = (url or "").strip()[:1000]
    # an app path ("/sessions?...") or a web address; "//host" and "/\\host" are other sites dressed as app paths
    if url and not (re.match(r"^/(?![/\\])", url) or re.match(r"^https?://", url)):
        url = ""
    now = time.time()
    with _conn() as c:
        if dedupe:
            dedupe = str(dedupe)[:200]
            if c.execute("SELECT 1 FROM events WHERE source=? AND dedupe=?", (source, dedupe)).fetchone():
                return None
        row = None
        if group:
            row = c.execute("SELECT * FROM events WHERE source=? AND grp=? AND read=0 AND level=? AND at>? "
                            "AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
                            (source, group, level, now - GROUP_WINDOW_S)).fetchone()
        if row is not None:
            occ = _json(row["occurrences"], list) or [_occurrence(row["at"], row["title"], row["body"],
                                                                  _json(row["params"], dict))]
            occ = [_occurrence(now, title, body, params)] + occ[:OCCURRENCES_MAX - 1]
            c.execute("UPDATE events SET count=count+1, at=?, title=?, body=?, url=?, kind=?, params=?, actions=?, "
                      "occurrences=? WHERE id=?",
                      (now, title, body, url, kind, _dumps(params), _dumps(acts), _dumps(occ), row["id"]))
            ev = _row(c.execute("SELECT * FROM events WHERE id=?", (row["id"],)).fetchone())
            grouped = True
        else:
            try:
                cur = c.execute("INSERT INTO events(at, source, level, title, body, url, dedupe, grp, kind, params, "
                                "actions, first_at, quiet) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (now, source, level, title, body, url, dedupe, group, kind, _dumps(params),
                                 _dumps(acts), now, 0 if notify else 1))
            except sqlite3.IntegrityError:             # the same dedupe key inserted by a concurrent request
                if dedupe:
                    return None
                raise
            ev = _row(c.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone())
            grouped = False
            if cur.lastrowid % 50 == 0:
                c.execute("DELETE FROM events WHERE at<?", (now - RETENTION_DAYS * 86400,))
    bus.invalidate("feed")
    if notify and not grouped:
        _to_telegram(ev)
    return ev


def resolve(source: str, group: str) -> int:
    """The problem behind a group went away (the cron job succeeded, the discussion resumed, the secret was set):
    its warning / error rows not yet resolved get `resolved_at` (no longer pending). Returns how many."""
    with _conn() as c:
        n = c.execute("UPDATE events SET resolved_at=? WHERE source=? AND grp=? AND resolved_at IS NULL "
                      "AND level IN ('warning', 'error')", (time.time(), source, _utf8(str(group)))).rowcount
    if n:
        bus.invalidate("feed")
    return n


def system_resolve(source: str, group: str) -> int:
    """resolve() for built-in producers: never raises (returns 0)."""
    try:
        return resolve(source, group)
    except Exception:  # noqa: BLE001
        log.exception("feed: could not resolve %s/%s", source, group)
        return 0


def resolve_ids(ids: list[int]) -> int:
    """Resolved by hand (POST /api/feed/resolve). Returns the pending count."""
    with _conn() as c:
        c.executemany("UPDATE events SET resolved_at=? WHERE id=? AND resolved_at IS NULL",
                      [(time.time(), i) for i in map(_id, ids[:500]) if i is not None])
    bus.invalidate("feed")
    return pending_count()


# ---- read ----------------------------------------------------------------------------------
_PENDING_SQL = "level IN ('warning', 'error') AND read=0 AND resolved_at IS NULL"


def list_events(source: str | None = None, unread: bool = False, before: int | None = None,
                limit: int = 50, *, category: str | None = None, kind: str | None = None,
                pending: bool = False) -> dict:
    limit = max(1, min(int(limit or 50), 200))
    where, args = ["at>?"], [time.time() - RETENTION_DAYS * 86400]
    if source:
        where.append("source=?")
        args.append(source)
    if category:
        if category not in CATEGORIES:
            raise FeedError(400, "bad_category", f"Category: {', '.join(CATEGORIES)}")
        mapped = sorted(_CATEGORY)
        if category == "webhooks":
            where.append(f"source NOT IN ({','.join('?' * len(mapped))})")
            args += mapped
        else:
            mine = [s for s in mapped if _CATEGORY[s] == category]
            where.append(f"source IN ({','.join('?' * len(mine))})")
            args += mine
    if kind:
        where.append("kind=?")
        args.append(kind)
    if unread:
        where.append("read=0")
    if pending:
        where.append(_PENDING_SQL)
    if before:
        where.append("id<?")
        args.append(min(max(int(before), -_ID_MAX), _ID_MAX))
    with _conn() as c:
        rows = c.execute(f"SELECT * FROM events WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?",
                         (*args, limit + 1)).fetchall()
    return {"events": [_row(r) for r in rows[:limit]], "more": len(rows) > limit, **counts()}


_counts: dict = {}


def _db_stamp(path: Path) -> tuple:
    out = []
    for suffix in ("", "-wal"):
        try:
            st = os.stat(f"{path}{suffix}")
        except OSError:
            st = None
        # An empty WAL is re-created by every new connection: only a WAL holding pages says something changed.
        out.append((st.st_mtime_ns, st.st_size, st.st_ino) if st and (st.st_size or not suffix) else None)
    return tuple(out)


def _aggregate(c: sqlite3.Connection, cutoff: float) -> list[dict]:
    """One row per (source, kind) of the last RETENTION_DAYS, the most recent first; `level` = of its latest event."""
    rows = c.execute(f"SELECT source, kind, level, COUNT(*) total, SUM(read=0) unread, SUM({_PENDING_SQL}) pending, "
                     "MAX(at) last FROM events WHERE at>? GROUP BY source, kind ORDER BY last DESC", (cutoff,)).fetchall()
    return [{"source": r["source"], "kind": r["kind"] or "custom", "level": r["level"], "total": r["total"],
             "unread": r["unread"] or 0, "pending": r["pending"] or 0} for r in rows]


def _groups() -> list[dict]:
    """_aggregate() of the whole journal is linear in its size, so the result is kept until feed.db (or its WAL)
    changes - written by this process or another one - or a minute passes (retention)."""
    path = db_path()
    with _conn() as c:
        key = (str(path), _db_stamp(path), int(time.time() // 60))
        hit = _counts.get(key[0])
        if hit and hit[0] == key:
            return [dict(x) for x in hit[1]]
        groups = _aggregate(c, time.time() - RETENTION_DAYS * 86400)
    _counts[key[0]] = (key, groups)
    return [dict(x) for x in groups]


def _blank() -> dict:
    return {"total": 0, "unread": 0, "pending": 0}


def counts(groups: list[dict] | None = None) -> dict:
    """{unread, pending, sources: [{source, total, unread, pending}], categories: {<category>: {total, unread,
    pending}}, kinds: {<kind>: {...}}} over the last RETENTION_DAYS."""
    groups = _groups() if groups is None else groups
    sources: dict[str, dict] = {}
    cats = {c: _blank() for c in CATEGORIES}
    kinds: dict[str, dict] = {}
    for g in groups:
        for d in (sources.setdefault(g["source"], {"source": g["source"], **_blank()}),
                  cats[category(g["source"])], kinds.setdefault(g["kind"], _blank())):
            for k in ("total", "unread", "pending"):
                d[k] += g[k]
    srcs = list(sources.values())
    return {"unread": sum(s["unread"] for s in srcs), "pending": sum(s["pending"] for s in srcs),
            "sources": srcs, "categories": cats, "kinds": kinds}


def source_counts() -> list[dict]:
    """Per-source totals for the chips (cached, see _groups)."""
    return counts()["sources"]


def unread_count() -> int:
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM events WHERE read=0 AND at>?",
                         (time.time() - RETENTION_DAYS * 86400,)).fetchone()[0]


def pending_count() -> int:
    with _conn() as c:
        return c.execute(f"SELECT COUNT(*) FROM events WHERE {_PENDING_SQL} AND at>?",
                         (time.time() - RETENTION_DAYS * 86400,)).fetchone()[0]


_STAMP_SQL = "SELECT MAX(id), SUM(read), SUM(count), COUNT(resolved_at) FROM events"


def _stamp_of(r: Any) -> tuple:
    return tuple(int(v or 0) for v in r)


def last_id() -> tuple:
    """Changes on new events, folds, reads and resolutions (what the UI must refetch for)."""
    with _conn() as c:
        return _stamp_of(c.execute(_STAMP_SQL).fetchone())


def max_id() -> int:
    with _conn() as c:
        return int(c.execute("SELECT MAX(id) FROM events").fetchone()[0] or 0)


def new_since(after: int, limit: int = 50) -> list[dict]:
    """Rows added after id `after` (oldest first): what push.dispatch() sends."""
    with _conn() as c:
        rows = c.execute("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?", (int(after), int(limit))).fetchall()
    return [_row(r) for r in rows]


_watch_lock = threading.Lock()
_watch: dict = {"ident": None, "conn": None, "version": None, "last": (0, 0, 0, 0)}


def watch_id() -> tuple:
    """last_id() for the watcher that tells the UI about events written by other processes and sends new rows to
    Web Push (a pass every few seconds). The read goes through one connection kept open (opened again when feed.db
    is replaced), and the events are read again only when its `PRAGMA data_version` says a commit was made since the
    last pass. Not the files' size / mtime: SQLite writes (and syncs) the WAL frames before it publishes the commit,
    and a restarted WAL is rewritten in place, so the files can look unchanged after a commit the previous pass
    did not see (that event then waited for the next write)."""
    path = db_path()
    with _watch_lock:
        try:
            ident: tuple | None = (str(path), os.stat(path).st_ino)
        except OSError:
            ident = None
        c = _watch["conn"]
        if ident is None or ident != _watch["ident"] or c is None:
            if c is not None:
                c.close()
            _watch.update(conn=None, ident=None, version=None)
            _conn().close()                             # creates / repairs the database and its table
            c = sqlite3.connect(path, timeout=10, check_same_thread=False)    # used under _watch_lock only
            _watch.update(conn=c, ident=ident)
        try:
            # first the version, then the rows: a commit in between is read now and once more next pass, never lost
            version = c.execute("PRAGMA data_version").fetchone()[0]
            if version == _watch["version"]:
                return _watch["last"]
            r = c.execute(_STAMP_SQL).fetchone()
        except sqlite3.Error:
            c.close()
            _watch.update(conn=None, ident=None, version=None)
            raise
        last = _stamp_of(r)
        _watch.update(version=version, last=last)
        return last


def mark_read(ids: list[int] | None = None, source: str | None = None, everything: bool = False) -> int:
    with _conn() as c:
        if everything:
            c.execute("UPDATE events SET read=1 WHERE read=0")
        elif source:
            c.execute("UPDATE events SET read=1 WHERE read=0 AND source=?", (source,))
        elif ids:
            c.executemany("UPDATE events SET read=1 WHERE id=?", [(i,) for i in map(_id, ids[:500]) if i is not None])
    bus.invalidate("feed")
    return unread_count()


def delete(event_id: int) -> None:
    if _id(event_id) is None:
        return
    with _conn() as c:
        c.execute("DELETE FROM events WHERE id=?", (int(event_id),))
    bus.invalidate("feed")


def get(event_id: int, detail: bool = False) -> dict | None:
    """One event; `detail` adds its `occurrences` (newest first; the event itself when never folded)."""
    if _id(event_id) is None:
        return None
    with _conn() as c:
        r = c.execute("SELECT * FROM events WHERE id=?", (int(event_id),)).fetchone()
    return _row(r, detail) if r else None


# ---- settings ------------------------------------------------------------------------------
def settings() -> dict:
    f = config.load_config().get("feed") or {}
    rules = {k: v for k, v in (f.get("rules") or {}).items() if v in RULES}
    kind_rules = {k: v for k, v in (f.get("kind_rules") or {}).items() if v in RULES and isinstance(k, str)}
    return {"telegram": f.get("telegram", True) is not False, "rules": rules, "kind_rules": kind_rules,
            "hooks": list(f.get("hooks") or [])}


def _clean_rules(rules: dict, key: Any) -> dict:
    clean = {}
    for k, v in rules.items():
        if v not in RULES:
            raise FeedError(400, "bad_rule", f"Rule: {', '.join(RULES)}")
        if v != "auto":
            clean[key(k)] = v
    return clean


def save_settings(telegram: bool | None = None, rules: dict | None = None, hooks: list | None = None,
                  kind_rules: dict | None = None) -> dict:
    with config._lock:
        cfg = config.load_config()
        f = dict(cfg.get("feed") or {})
        if telegram is not None:
            f["telegram"] = bool(telegram)
        if rules is not None:
            f["rules"] = _clean_rules(rules, clean_source)
        if kind_rules is not None:
            f["kind_rules"] = _clean_rules(kind_rules, lambda k: clean_kind(k, trusted=True))
        if hooks is not None:
            f["hooks"] = hooks
        cfg["feed"] = f
        config.save_config(cfg)
    bus.invalidate("feed")
    return settings()


def default_rule(source: str, level: str, s: dict | None = None) -> str:
    """What "auto" gives for an event of `source` / `level` when its kind has no rule: "off", "silent" or "loud"."""
    s = s or settings()
    r = s["rules"].get(source, "auto")
    if r != "auto":
        return r
    if source in OWN_THREAD:
        return "off"
    return {"error": "loud", "warning": "silent"}.get(level, "off")


def rule_for(source: str, level: str, s: dict | None = None, kind: str | None = None) -> str:
    """Effective Telegram rule of an event: its kind's rule, else its source's, else by level ("off" for the
    built-in sources that have their own thread)."""
    s = s or settings()
    r = (s.get("kind_rules") or {}).get(kind or "", "auto")
    if r != "auto":
        return r
    return default_rule(source, level, s)


def event_kinds(s: dict | None = None) -> list[dict]:
    """The rows of the settings matrix: every built-in kind, then the other kinds seen in the last 30 days."""
    s = s or settings()
    out = []
    for kind, (source, level) in KINDS.items():
        out.append({"kind": kind, "category": category(source) if source else "webhooks", "source": source,
                    "level": level, "builtin": True})
    seen: dict[str, dict] = {}
    for g in _groups():                                # most recent first
        if g["kind"] not in KINDS and g["kind"] not in seen:
            seen[g["kind"]] = {"kind": g["kind"], "category": category(g["source"]), "source": g["source"],
                               "level": g["level"], "builtin": False}
    out += seen.values()
    for k in out:
        k.update(rule=s["kind_rules"].get(k["kind"], "auto"), default=default_rule(k["source"], k["level"], s),
                 own_thread=k["source"] in OWN_THREAD)
    return out


def _to_telegram(ev: dict) -> None:
    try:
        s = settings()
        if not s["telegram"]:
            return
        r = rule_for(ev["source"], ev["level"], s, ev.get("kind"))
        if r == "off":
            return
        from .telegram import gateway
        gateway.feed_notify(ev, loud=(r == "loud"))
    except Exception:  # noqa: BLE001 - Telegram is optional
        log.exception("feed: telegram post failed")


def system(title: str, body: str = "", level: str = "info", source: str = "system", url: str = "",
           group: str | None = None, dedupe: str | None = None, *, kind: str = "custom", params: dict | None = None,
           actions: list | None = None) -> dict | None:
    """Built-in events: never raise (the feed must not break a cron run, an update or a sign-in). Returns the
    event (None when `dedupe` says it was already posted, or it could not be recorded)."""
    try:
        return post(title, body, level, source, url, dedupe=dedupe, group=group, kind=kind, params=params,
                    actions=actions, trusted=True)
    except Exception:  # noqa: BLE001
        log.exception("feed: could not record %r", title)
        return None


def link(action_id: str, label: str, url: str) -> dict:
    """A `link` action (built-in producers)."""
    return {"id": action_id, "label": label, "type": "link", "url": url}


def post_action(action_id: str, label: str, url: str) -> dict:
    """A `post` action (built-in producers; `url` must match POST_ACTIONS)."""
    return {"id": action_id, "label": label, "type": "post", "url": url}
