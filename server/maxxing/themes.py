"""Colour themes (palettes) of the web app: structural validation of a Theme object.

Mirror of web/src/lib/theme/validate.ts (format and rules: docs/dev/DESIGN.md "Themes"), without the colour maths:
the server keeps only what it understands and refuses unsafe values; derivation of the missing tokens and the
contrast report stay in the browser. Used by PUT /api/settings/look (the palette that follows the user on every
device); a theme is public once stored (GET /api/auth/state returns the look before sign-in).

Also the user's saved themes ("My themes", `<state>/themes.json`, next to the `look` of config.json: private, signed
in only), the theme file a session wrote (`latest_file`, the theme generator of Settings -> Appearance) and the themes
sent in Team chats (team.py): every theme from a file, a model, a pasted code or another server goes through
clean_theme() before it is stored or returned.
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import threading
import time
from pathlib import Path

SCHEMA = 1
BASES = ("zinc", "graphite", "marine", "custom")
ACCENTS = ("blue", "clay", "violet", "green", "amber", "rose")
BUTTONS = ("accent", "neutral")
TINTS = ("neutral", "tinted")
TOKENS = (
    "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary",
    "primary-foreground", "action", "action-foreground", "secondary", "secondary-foreground", "muted",
    "muted-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground", "success", "warning",
    "border", "input", "ring", "sidebar", "sidebar-border", "overlay",
)
LIMITS = {"name": 60, "description": 280, "author": 60, "bytes": 16384, "color": 64}

_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?"
_PART = rf"{_NUM}(?:%|deg)?"
_SEP = r"(?:\s*,\s*|\s+)"
_FUNC = re.compile(rf"^(rgba?|hsla?|oklch)\(\s*{_PART}{_SEP}{_PART}{_SEP}{_PART}(?:\s*[,/]\s*{_NUM}%?)?\s*\)$", re.I)
_HEX = re.compile(r"^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$", re.I)
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f<>]")


class ThemeError(ValueError):
    pass


def is_color(v: object) -> bool:
    """Hex, rgb(a), hsl(a) or oklch with numbers only - never url(), var(), keywords or anything else."""
    if not isinstance(v, str) or len(v) > LIMITS["color"]:
        return False
    v = v.strip()
    return bool(_HEX.match(v) or _FUNC.match(v))


def _text(v: object, n: int) -> str:
    return " ".join(_CONTROL.sub("", v).split())[:n] if isinstance(v, str) else ""


def _hex(v: str) -> str:
    """#rrggbb of a hex colour (the browser normalises the other notations to it)."""
    h = v.strip().lower()[1:]
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    return "#" + h[:6]


def clean_theme(data: object) -> dict:
    """A valid Theme dict from `data` (unknown keys dropped, defaults filled). Raises ThemeError on unsafe or
    unusable input: not an object, too big, another schema, a token value that is not a colour."""
    if not isinstance(data, dict):
        raise ThemeError("a theme is an object")
    if len(json.dumps(data, ensure_ascii=False).encode()) > LIMITS["bytes"]:
        raise ThemeError(f"a theme is {LIMITS['bytes']} bytes at most")
    if data.get("schema", SCHEMA) != SCHEMA:
        raise ThemeError(f"theme schema {data.get('schema')!r} is not supported (expected {SCHEMA})")
    accent = data.get("accent", "blue")
    if accent not in ACCENTS:
        if not is_color(accent):
            raise ThemeError("accent: a named accent or a colour")
        accent = _hex(accent) if accent.strip().startswith("#") else accent.strip()
    out = {
        "schema": SCHEMA,
        "id": data["id"] if isinstance(data.get("id"), str) and _ID.match(data["id"]) else "custom",
        "name": _text(data.get("name"), LIMITS["name"]),
        "base": data.get("base") if data.get("base") in BASES else "zinc",
        "accent": accent,
        "buttons": data.get("buttons") if data.get("buttons") in BUTTONS else "accent",
        "tint": data.get("tint") if data.get("tint") in TINTS else "neutral",
        "tokens": {"light": {}, "dark": {}},
    }
    for key in ("description", "author"):
        v = _text(data.get(key), LIMITS[key])
        if v:
            out[key] = v
    tokens = data.get("tokens") if isinstance(data.get("tokens"), dict) else {}
    for mode in ("light", "dark"):
        values = tokens.get(mode) if isinstance(tokens.get(mode), dict) else {}
        for k, v in values.items():
            if k not in TOKENS:
                continue
            if not is_color(v):
                raise ThemeError(f"tokens.{mode}.{k}: not a colour")
            out["tokens"][mode][k] = v.strip()
    return out


def legacy_theme(accent: str, tint: str, keep: dict | None = None) -> dict:
    """The palette of an accent + tint (clients before palettes), keeping the base and buttons of `keep`."""
    keep = keep or {}
    return {"schema": SCHEMA, "id": "custom", "name": "", "base": keep.get("base", "zinc"),
            "accent": accent if accent in ACCENTS else "blue", "buttons": keep.get("buttons", "accent"),
            "tint": tint if tint in TINTS else "neutral", "tokens": {"light": {}, "dark": {}}}


def nearest_accent(theme: dict) -> str:
    """The named accent shown to clients that do not know palettes (the browser computes the exact one)."""
    a = theme.get("accent")
    return a if a in ACCENTS else "blue"


# ---- the user's saved themes ("My themes") ---------------------------------------------------------------------
SAVED_MAX = 50                                  # themes kept (a theme is LIMITS["bytes"] at most: <= ~800 KB in all)
SOURCES = ("created", "imported", "received", "custom")   # by the theme generator, a file / code, Team, the settings
_SAVED_ID = re.compile(r"^th_[0-9a-f]{10}$")
_SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")   # a session UUID
_saved_lock = threading.RLock()


class ThemeNotFound(LookupError):
    pass


class ThemeLimit(ValueError):
    pass


def _saved_path() -> Path:
    from . import config
    return config.state_dir() / "themes.json"


def _when(v: object) -> float:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return f if math.isfinite(f) else 0.0


def _entry(e: object) -> dict | None:
    """A stored entry as served, or None when it is unusable (an edited file never breaks the list)."""
    if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not _SAVED_ID.match(e["id"]):
        return None
    try:
        theme = clean_theme(e.get("theme"))
    except ThemeError:
        return None
    out = {"id": e["id"], "theme": theme, "source": e.get("source") if e.get("source") in SOURCES else "imported",
           "from": _text(e.get("from"), LIMITS["author"]), "saved": _when(e.get("saved"))}
    if isinstance(e.get("session"), str) and _SESSION_ID.match(e["session"]):
        out["session"] = e["session"]
    return out


def saved() -> list[dict]:
    """The saved themes, newest first: [{id, theme, source, from, saved}]."""
    from . import config
    data = config.read_json(_saved_path(), {})
    items = data.get("themes") if isinstance(data, dict) else None
    out = [x for x in (_entry(e) for e in (items if isinstance(items, list) else [])) if x]
    return out[:SAVED_MAX]


def _write(items: list[dict]) -> None:
    from . import bus, config
    config.write_json(_saved_path(), {"themes": items}, mode=0o600)
    bus.invalidate("themes")


def _colours(t: dict) -> tuple:
    return (t["base"], t["accent"], t["buttons"], t["tint"], json.dumps(t["tokens"], sort_keys=True))


def save_theme(theme: object, source: str = "imported", frm: str = "", session: str | None = None) -> dict:
    """Keep a theme (validated). The same colours already kept -> that entry, nothing added. ThemeError: not a
    usable theme; ThemeLimit: SAVED_MAX reached. `session`: the theme generator's session that made it (`created`
    only; the Atelier shows it as the theme's origin)."""
    clean = clean_theme(theme)
    if source not in SOURCES:
        raise ThemeError(f"source: {', '.join(SOURCES)}")
    with _saved_lock:
        items = saved()
        same = next((e for e in items if _colours(e["theme"]) == _colours(clean)), None)
        if same:
            return same
        if len(items) >= SAVED_MAX:
            raise ThemeLimit(f"{SAVED_MAX} saved themes at most: delete one first")
        entry = {"id": "th_" + secrets.token_hex(5), "theme": clean, "source": source,
                 "from": _text(frm, LIMITS["author"]), "saved": time.time()}
        if source == "created" and isinstance(session, str) and _SESSION_ID.match(session):
            entry["session"] = session
        _write([entry] + items)
        return entry


def rename_theme(tid: str, name: str) -> dict:
    name = _text(name, LIMITS["name"])
    if not name:
        raise ThemeError("a name is needed")
    with _saved_lock:
        items = saved()
        entry = next((e for e in items if e["id"] == tid), None)
        if entry is None:
            raise ThemeNotFound(tid)
        if entry["theme"]["name"] != name:
            entry["theme"]["name"] = name
            _write(items)
        return entry


def delete_theme(tid: str) -> None:
    with _saved_lock:
        items = saved()
        left = [e for e in items if e["id"] != tid]
        if len(left) == len(items):
            raise ThemeNotFound(tid)
        _write(left)


# ---- the theme file a session wrote (theme generator) ------------------------------------------------------------
THEME_SUFFIX = ".theme.json"


def latest_file(folder: Path, since: float) -> dict:
    """The newest `*.theme.json` written in `folder` (or its `themes/` sub-folder) at or after `since`, validated:
    {theme, file, at}. Regular files only (no symbolic link), LIMITS["bytes"] at most. ThemeNotFound when there is
    none; ThemeError when it is not a usable theme (not JSON, too big, unsafe values)."""
    best: tuple[Path, float] | None = None
    for d in (folder, folder / "themes"):
        if d.is_symlink() or not d.is_dir():
            continue
        for p in d.iterdir():
            if not p.name.endswith(THEME_SUFFIX) or p.is_symlink():
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            if not p.is_file() or st.st_mtime < since:
                continue
            if best is None or st.st_mtime > best[1]:
                best = (p, st.st_mtime)
    if best is None:
        raise ThemeNotFound("no theme file")
    p, mtime = best
    try:
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as f:
            raw = f.read(LIMITS["bytes"] + 1)
    except OSError as e:
        raise ThemeError(f"{p.name}: unreadable ({e.strerror})") from None
    if len(raw) > LIMITS["bytes"]:
        raise ThemeError(f"{p.name}: a theme file is {LIMITS['bytes']} bytes at most")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ThemeError(f"{p.name}: not JSON") from None
    return {"theme": clean_theme(data), "file": p.name, "at": mtime}
