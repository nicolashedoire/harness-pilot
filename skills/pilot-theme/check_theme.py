#!/usr/bin/env python3
"""Check a `*.theme.json` before handing it to the user (skill pilot-theme). Standard library only.

    python3 check_theme.py ember.theme.json

Mirrors the rules of the app (web/src/lib/theme/validate.ts normalizeTheme, server maxxing/themes.py clean_theme):
structure, colours only, size; then the WCAG contrast of every pair of CONTRAST_PAIRS whose two tokens are set
explicitly in a mode (the tokens the app derives are checked by the app itself). Exit code 0 = usable, 1 = fix it.
"""
from __future__ import annotations

import json
import math
import re
import sys

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
PAIRS = (
    ("foreground", "background", 4.5), ("foreground", "sidebar", 4.5), ("card-foreground", "card", 4.5),
    ("popover-foreground", "popover", 4.5), ("muted-foreground", "background", 4.5), ("muted-foreground", "card", 4.5),
    ("muted-foreground", "muted", 4.5), ("muted-foreground", "sidebar", 4.5), ("secondary-foreground", "secondary", 4.5),
    ("accent-foreground", "accent", 4.5), ("primary-foreground", "primary", 4.5), ("action-foreground", "action", 4.5),
    ("destructive-foreground", "destructive", 4.5), ("primary", "background", 4.5), ("primary", "card", 4.5),
    ("destructive", "background", 4.5), ("destructive", "popover", 4.5), ("ring", "background", 3.0),
    ("primary", "sidebar", 3.0), ("success", "background", 3.0), ("warning", "background", 3.0),
)
FIXED_BY_APP = ("primary-foreground", "action-foreground", "destructive-foreground")

_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?"
_PART = rf"({_NUM})(%|deg)?"
_SEP = r"(?:\s*,\s*|\s+)"
_FUNC = re.compile(rf"^(rgba?|hsla?|oklch)\(\s*{_PART}{_SEP}{_PART}{_SEP}{_PART}(?:\s*[,/]\s*({_NUM})(%)?)?\s*\)$", re.I)
_HEX = re.compile(r"^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$", re.I)
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")


def _clamp(x: float) -> float:
    return min(1.0, max(0.0, x))


def parse(v: object) -> tuple[float, float, float, float] | None:
    """(r, g, b, alpha) in sRGB 0..1, or None when it is not a colour the app accepts."""
    if not isinstance(v, str) or len(v) > LIMITS["color"]:
        return None
    v = v.strip()
    if _HEX.match(v):
        h = v[1:]
        if len(h) <= 4:
            h = "".join(c * 2 for c in h)
        n = [int(h[i:i + 2], 16) / 255 for i in range(0, len(h), 2)]
        return (n[0], n[1], n[2], n[3] if len(n) == 4 else 1.0)
    m = _FUNC.match(v)
    if not m:
        return None
    fn = m.group(1).lower()
    (p1, u1), (p2, u2), (p3, u3) = (float(m.group(2)), m.group(3)), (float(m.group(4)), m.group(5)), (float(m.group(6)), m.group(7))
    a = 1.0 if m.group(8) is None else _clamp(float(m.group(8)) / (100 if m.group(9) else 1))
    if fn.startswith("rgb"):
        f = [(p / 100 if u == "%" else p / 255) for p, u in ((p1, u1), (p2, u2), (p3, u3))]
        return (_clamp(f[0]), _clamp(f[1]), _clamp(f[2]), a)
    if fn.startswith("hsl"):
        h, s, li = (p1 % 360) / 360, _clamp(p2 / 100), _clamp(p3 / 100)
        q = li * (1 + s) if li < 0.5 else li + s - li * s
        p = 2 * li - q

        def hue(t: float) -> float:
            t %= 1
            return p + (q - p) * 6 * t if t < 1 / 6 else q if t < 1 / 2 else p + (q - p) * (2 / 3 - t) * 6 if t < 2 / 3 else p
        return (hue(h + 1 / 3), hue(h), hue(h - 1 / 3), a)
    # oklch: L (0..1 or %), C, H (deg)
    L = p1 / 100 if u1 == "%" else p1
    C = p2 / 100 * 0.4 if u2 == "%" else p2
    H = math.radians(p3)
    A, B = C * math.cos(H), C * math.sin(H)
    l_, m_, s_ = L + 0.3963377774 * A + 0.2158037573 * B, L - 0.1055613458 * A - 0.0638541728 * B, L - 0.0894841775 * A - 1.2914855480 * B
    l3, m3, s3 = l_ ** 3, m_ ** 3, s_ ** 3
    lin = (4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
           -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
           -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3)

    def gamma(x: float) -> float:
        x = _clamp(x)
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
    return (gamma(lin[0]), gamma(lin[1]), gamma(lin[2]), a)


def _over(top, bottom):
    a = top[3]
    return (top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1.0)


def _lum(c) -> float:
    def lin(x: float) -> float:
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])


def contrast(fg: str, bg: str) -> float:
    """WCAG 2 ratio, like the app: a translucent background over black, a translucent text over its background."""
    f, b = parse(fg), parse(bg)
    if not f or not b:
        return 0.0
    if b[3] < 1:
        b = _over(b, (0.0, 0.0, 0.0, 1.0))
    if f[3] < 1:
        f = _over(f, b)
    x, y = _lum(f), _lum(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def check(text: str) -> tuple[list[str], list[str], list[str]]:
    """-> (errors, contrast failures, notes)."""
    errors: list[str] = []
    fails: list[str] = []
    notes: list[str] = []
    if len(text.encode("utf-8")) > LIMITS["bytes"]:
        return [f"the file is over {LIMITS['bytes']} bytes"], fails, notes
    try:
        data = json.loads(text)
    except ValueError as e:
        return [f"not JSON: {e}"], fails, notes
    if not isinstance(data, dict):
        return ["a theme is a JSON object"], fails, notes
    known = {"schema", "id", "name", "description", "author", "base", "accent", "buttons", "tint", "tokens"}
    for k in data:
        if k not in known:
            notes.append(f"unknown key {k!r} is dropped by the app")
    if data.get("schema", SCHEMA) != SCHEMA:
        errors.append(f"schema must be {SCHEMA}")
    if not isinstance(data.get("id"), str) or not _ID.match(data["id"]):
        errors.append("id: lowercase letters, digits and dashes, 48 characters at most")
    for key in ("name", "description", "author"):
        v = data.get(key)
        if v is None:
            continue
        if not isinstance(v, str):
            errors.append(f"{key} must be text")
        elif len(v) > LIMITS[key]:
            errors.append(f"{key}: {LIMITS[key]} characters at most")
        elif re.search(r"[\x00-\x1f\x7f<>]", v):
            notes.append(f"{key}: control characters and < > are removed by the app")
    if not data.get("name"):
        notes.append("no name: give the theme a short name")
    for key, values in (("base", BASES), ("buttons", BUTTONS), ("tint", TINTS)):
        if key in data and data[key] not in values:
            errors.append(f"{key}: one of {', '.join(values)}")
    accent = data.get("accent", "blue")
    if accent not in ACCENTS and parse(accent) is None:
        errors.append("accent: a named accent (" + ", ".join(ACCENTS) + ") or a colour such as #e8915a")
    tokens = data.get("tokens", {})
    if not isinstance(tokens, dict):
        errors.append("tokens: an object {light: {...}, dark: {...}}")
        tokens = {}
    for k in tokens:
        if k not in ("light", "dark"):
            notes.append(f"tokens.{k} is dropped (only light and dark)")
    for mode in ("light", "dark"):
        own = tokens.get(mode) or {}
        if not isinstance(own, dict):
            errors.append(f"tokens.{mode} must be an object")
            continue
        for k, v in own.items():
            if k not in TOKENS:
                notes.append(f"tokens.{mode}.{k} is not a token: dropped by the app")
            elif parse(v) is None:
                errors.append(f"tokens.{mode}.{k}: {v!r} is not a colour (hex, rgb(), hsl(), oklch() only)")
        derived = 0
        for fg, bg, minimum in PAIRS:
            if fg not in own or bg not in own:
                derived += 1
                continue
            if parse(own[fg]) is None or parse(own[bg]) is None:
                continue
            r = contrast(own[fg], own[bg])
            if r < minimum:
                line = f"{mode}: {fg} on {bg} = {r:.2f}:1, {minimum}:1 needed"
                (notes if fg in FIXED_BY_APP else fails).append(line + (" (the app would replace it by black or white)" if fg in FIXED_BY_APP else ""))
        if own and derived:
            notes.append(f"{mode}: {derived} pairs use derived tokens (checked by the app)")
    if data.get("buttons") == "neutral" and any(k in (tokens.get(m) or {}) for m in ("light", "dark") for k in ("action", "action-foreground")):
        notes.append("buttons is neutral: explicit action tokens still win over it - drop them for monochrome buttons")
    return errors, fails, notes


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: check_theme.py <file.theme.json>", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as f:
            text = f.read(LIMITS["bytes"] + 1024)
    except (OSError, UnicodeDecodeError) as e:
        print(f"ERROR cannot read {argv[1]}: {e}")
        return 1
    errors, fails, notes = check(text)
    for e in errors:
        print(f"ERROR {e}")
    for e in fails:
        print(f"CONTRAST {e}")
    for n in notes:
        print(f"note  {n}")
    if errors or fails:
        return 1
    print("OK: the app will accept this theme")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
