"""Colour themes (palettes) of the web app: structural validation of a Theme object.

Mirror of web/src/lib/theme/validate.ts (format and rules: docs/dev/DESIGN.md "Themes"), without the colour maths:
the server keeps only what it understands and refuses unsafe values; derivation of the missing tokens and the
contrast report stay in the browser. Used by PUT /api/settings/look (the palette that follows the user on every
device); a theme is public once stored (GET /api/auth/state returns the look before sign-in).
"""
from __future__ import annotations

import json
import re

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
