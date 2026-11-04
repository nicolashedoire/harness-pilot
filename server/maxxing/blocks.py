"""Conversation blocks: rich content an agent puts in its answer as a fenced code block.

    ```chart
    {"kind": "line", "series": [{"name": "Orders", "points": [["Mon", 12], ["Tue", 18]]}]}
    ```

The info string names the block type, the body is JSON checked against that type's schema (a few types also take
raw text: terminal, diff, app). The web app draws it (web/src/features/blocks); anything invalid or unknown falls
back to its raw data and the reason. See docs/dev/API.md#conversation-blocks.

Every block type is a *plugin*:
- built-ins (BUILTINS below): drawn by the app itself, can be turned off (config `blocks.disabled`), never removed;
- block extensions: `<workspace>/extensions/<id>/block.json` (+ `block.html`), drawn in a sandboxed frame without
  same-origin access; network only to the hosts its manifest declares, after the user's consent
  (config `blocks.consent`), enforced by the frame's own Content-Security-Policy. Enabled / disabled like any
  extension (config `extensions.disabled`).

Agents only propose the enabled types (the user's own CLAUDE.md files are never touched):
- Claude Code: the product skill `pilot-blocks` is rendered with the enabled list - in its description (listed in
  every prompt) and its body - at install (`cmd_core._skill_vars`) and again by `sync_agent_files()` when it changes;
- Codex: `sync_agent_files()` writes the list to `<state>/blocks/agents.md`, which `sessions/codex.workspace_context`
  adds to the shared context of every turn;
- both: the full schemas in `<state>/blocks/reference.md`.
"""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from . import config

# ---- limits ------------------------------------------------------------------------------------------------------
MANIFEST_MAX = 64 * 1024          # block.json
SCHEMA_MAX = 64 * 1024            # schema (inline or schema.json)
ENTRY_MAX = 512 * 1024            # block.html
DATA_MAX = 512 * 1024             # a block's JSON body (also enforced by the web app)
SCHEMA_DEPTH = 12
MAX_RENDERS = 8
MAX_HOSTS = 8
GRANT_TTL_S = 3600

TYPE_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}\Z")
ENTRY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html\Z")
SCHEMA_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json\Z")
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
HOST_RE = re.compile(rf"^(?:\*\.)?{_LABEL}(?:\.{_LABEL})+(?::\d{{1,5}})?\Z")
CATEGORIES = ("data", "code", "media", "interactive", "organisation", "other")
# Fence languages a plugin may not claim: a JSON object in them is ordinary code (or an app feature).
RESERVED_TYPES = {"json", "jsonc", "json5", "js", "javascript", "ts", "typescript", "text", "txt", "plain", "md",
                  "markdown", "html", "xml", "yaml", "yml", "toml", "mermaid", "git", "infra", "block", "code"}


# ---- built-in block types ----------------------------------------------------------------------------------------
def _s(n: int = 200) -> dict:
    return {"type": "string", "maxLength": n}


_NUM_OR_STR = {"type": ["number", "string"]}
_TONE = {"enum": ["ok", "warn", "error"]}
_HEAD = {"title": _s(), "source": _s(300)}

BUILTINS: list[dict[str, Any]] = [
    {"type": "chart", "icon": "chart-line", "category": "data", "pin": True,
     "hint": "Numbers over time or across categories (line or bar), with a chart / table switch and CSV / PNG export.",
     "fields": '{kind?: "line"|"bar", series: [{name, points: [[x, y]]}] (1-6 series), unit?, title?, source?}',
     "schema": {"type": "object", "required": ["series"], "properties": {
         **_HEAD, "kind": {"enum": ["line", "bar"]}, "unit": _s(20),
         "series": {"type": "array", "minItems": 1, "maxItems": 6, "items": {
             "type": "object", "required": ["name", "points"], "properties": {
                 "name": _s(80),
                 "points": {"type": "array", "maxItems": 1000, "items": {
                     "type": "array", "minItems": 2, "maxItems": 2, "items": [_NUM_OR_STR, {"type": "number"}]}}}}}}}},
    {"type": "table", "icon": "table", "category": "data", "pin": True,
     "hint": "Tabular data the user can sort, filter and export as CSV.",
     "fields": '{columns: [label | {label, type?: "text"|"number"|"percent"|"delta"|"bar", unit?, align?}], '
               'rows: [[cell]], title?, source?, page_size?}',
     "schema": {"type": "object", "required": ["columns", "rows"], "properties": {
         **_HEAD, "page_size": {"type": "integer", "minimum": 1, "maximum": 500},
         "columns": {"type": "array", "minItems": 1, "maxItems": 40, "items": {"anyOf": [
             _s(120),
             {"type": "object", "required": ["label"], "properties": {
                 "label": _s(120), "align": {"enum": ["left", "right", "center"]}, "unit": _s(20),
                 "type": {"enum": ["text", "number", "percent", "delta", "bar"]}}}]}},
         "rows": {"type": "array", "maxItems": 5000, "items": {
             "type": "array", "maxItems": 40, "items": {"type": ["string", "number", "boolean", "null"]}}}}}},
    {"type": "stats", "icon": "gauge", "category": "data", "pin": True,
     "hint": "A few key figures (KPIs), each with an optional change and tone.",
     "fields": '{items: [{label, value, unit?, delta?, hint?, tone?: "ok"|"warn"|"error"}] (1-12), title?}',
     "schema": {"type": "object", "required": ["items"], "properties": {
         **_HEAD, "items": {"type": "array", "minItems": 1, "maxItems": 12, "items": {
             "type": "object", "required": ["label", "value"], "properties": {
                 "label": _s(80), "value": _NUM_OR_STR, "unit": _s(20), "delta": _NUM_OR_STR, "hint": _s(120),
                 "tone": _TONE}}}}}},
    {"type": "list", "icon": "list", "category": "data", "pin": True,
     "hint": "A short list of items with an optional value, status, icon or link (grid: tiles).",
     "fields": '{items: [{title, subtitle?, value?, status?: "ok"|"warn"|"error", icon?, href?}], grid?, title?}',
     "schema": {"type": "object", "required": ["items"], "properties": {
         **_HEAD, "grid": {"type": "boolean"}, "items": {"type": "array", "maxItems": 200, "items": {
             "type": "object", "required": ["title"], "properties": {
                 "title": _s(200), "subtitle": _s(300), "value": _NUM_OR_STR, "status": _TONE,
                 "icon": _s(40), "href": _s(2000)}}}}}},
    {"type": "timeline", "icon": "calendar-range", "category": "data", "pin": True,
     "hint": "Events on a time axis, one lane per thing (jobs, deploys, runs).",
     "fields": '{lanes: [{name, sub?, events: [{at: unix seconds|ISO date, state?: "ok"|"error"|"running"|"planned", '
               'label?}]}], start?, end?, now?, title?}',
     "schema": {"type": "object", "required": ["lanes"], "properties": {
         **_HEAD, "start": _NUM_OR_STR, "end": _NUM_OR_STR, "now": _NUM_OR_STR,
         "lanes": {"type": "array", "minItems": 1, "maxItems": 30, "items": {
             "type": "object", "required": ["name", "events"], "properties": {
                 "name": _s(80), "sub": _s(120), "events": {"type": "array", "maxItems": 500, "items": {
                     "type": "object", "required": ["at"], "properties": {
                         "at": _NUM_OR_STR, "label": _s(120),
                         "state": {"enum": ["ok", "error", "running", "planned"]}}}}}}}}}},
    {"type": "progress", "icon": "percent", "category": "data", "pin": True,
     "hint": "Progress or quota bars (value out of max).",
     "fields": '{items: [{label, value, max, unit?, hint?, format?: "percent"|"fraction"}]} or one {label, value, max}',
     "schema": {"type": "object", "anyOf": [{"required": ["items"]}, {"required": ["label", "value", "max"]}],
                "properties": {
                    **_HEAD, "label": _s(120), "value": {"type": "number"}, "max": {"type": "number"},
                    "unit": _s(20), "hint": _s(200), "format": {"enum": ["percent", "fraction"]},
                    "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
                        "type": "object", "required": ["label", "value", "max"], "properties": {
                            "label": _s(120), "value": {"type": "number"}, "max": {"type": "number"},
                            "unit": _s(20), "hint": _s(200), "format": {"enum": ["percent", "fraction"]}}}}}}},
    {"type": "terminal", "icon": "terminal", "category": "code", "raw": "output",
     "hint": "A command and its output with the exit code (the body may also be the raw output).",
     "fields": "{output, command?, exit_code?, duration_ms?, cwd?, title?} or raw text",
     "schema": {"type": "object", "required": ["output"], "properties": {
         **_HEAD, "output": _s(200_000), "command": _s(2000), "exit_code": {"type": "integer"},
         "duration_ms": {"type": "number", "minimum": 0}, "cwd": _s(500)}}},
    {"type": "diff", "icon": "file-diff", "category": "code", "raw": "diff",
     "hint": "A code change as a unified diff (the body may also be the raw diff).",
     "fields": "{diff, path?, title?} or a raw unified diff",
     "schema": {"type": "object", "required": ["diff"], "properties": {
         **_HEAD, "diff": _s(200_000), "path": _s(1000)}}},
    {"type": "file", "icon": "image", "category": "media",
     "hint": "Files of this server shown inline: image, PDF, video, audio or document, by absolute path in the files root.",
     "fields": "{path, caption?, title?} or {items: [{path, caption?}] (gallery, up to 24)}",
     "schema": {"type": "object", "anyOf": [{"required": ["path"]}, {"required": ["items"]}], "properties": {
         **_HEAD, "path": _s(4096), "caption": _s(300), "items": {"type": "array", "minItems": 1, "maxItems": 24,
                                                                  "items": {"type": "object", "required": ["path"],
                                                                            "properties": {"path": _s(4096),
                                                                                           "caption": _s(300)}}}}}},
    {"type": "link", "icon": "link", "category": "media",
     "hint": "A web page, repository or ticket you refer to, as a card (no fetch: give its title and description).",
     "fields": "{url, title?, description?, site?}",
     "schema": {"type": "object", "required": ["url"], "properties": {
         "url": _s(2000), "title": _s(200), "description": _s(500), "site": _s(80)}}},
    {"type": "form", "icon": "sliders-horizontal", "category": "interactive",
     "hint": "Ask several questions at once (choices, numbers, dates); the answers come back as the user's next message.",
     "fields": '{fields: [{id, label, type: "text"|"textarea"|"number"|"select"|"choice"|"multi"|"checkbox"|"range"|'
               '"date"|"time", options?, min?, max?, step?, unit?, default?, required?, placeholder?, hint?}], '
               'title?, description?, submit?}',
     "schema": {"type": "object", "required": ["fields"], "properties": {
         **_HEAD, "description": _s(500), "submit": _s(40),
         "fields": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
             "type": "object", "required": ["id", "label", "type"], "properties": {
                 "id": _s(40), "label": _s(120), "hint": _s(200), "placeholder": _s(120), "unit": _s(20),
                 "type": {"enum": ["text", "textarea", "number", "select", "choice", "multi", "checkbox", "range",
                                   "date", "time"]},
                 "options": {"type": "array", "maxItems": 30, "items": {"anyOf": [
                     _s(120), {"type": "object", "required": ["label"],
                               "properties": {"label": _s(120), "value": _s(120)}}]}},
                 "min": {"type": "number"}, "max": {"type": "number"}, "step": {"type": "number"},
                 "required": {"type": "boolean"}, "default": {}}}}}}},
    {"type": "checklist", "icon": "list-checks", "category": "interactive",
     "hint": "Steps the user ticks before an action; they can send the result back.",
     "fields": "{items: [label | {label, checked?, hint?}], title?, submit?}",
     "schema": {"type": "object", "required": ["items"], "properties": {
         **_HEAD, "submit": _s(40), "items": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"anyOf": [
             _s(200), {"type": "object", "required": ["label"], "properties": {
                 "label": _s(200), "hint": _s(200), "checked": {"type": "boolean"}}}]}}}}},
    {"type": "app", "icon": "app-window", "category": "interactive", "raw": "html",
     "hint": "A small self-contained HTML mini-app (calculator, simulator, game) in an isolated frame, no network.",
     "fields": "{html, title?, height?} or raw HTML (inline <style>/<script> only)",
     "schema": {"type": "object", "required": ["html"], "properties": {
         **_HEAD, "html": _s(200_000), "height": {"type": "integer", "minimum": 80, "maximum": 1200}}}},
    {"type": "created", "icon": "check-circle", "category": "organisation",
     "hint": "Cards for what you just created (task, cron, notification, file, session) with a link to it.",
     "fields": '{items: [{kind: "task"|"cron"|"notification"|"file"|"session"|"project"|"extension"|"other", title, '
               'subtitle?, id?, path?, href?}], title?}',
     "schema": {"type": "object", "required": ["items"], "properties": {
         **_HEAD, "items": {"type": "array", "minItems": 1, "maxItems": 12, "items": {
             "type": "object", "required": ["kind", "title"], "properties": {
                 "kind": {"enum": ["task", "cron", "notification", "file", "session", "project", "extension",
                                   "other"]},
                 "title": _s(200), "subtitle": _s(300), "id": _s(200), "path": _s(4096), "href": _s(2000)}}}}}},
    {"type": "proposal", "icon": "package-check", "category": "organisation",
     "hint": "A creation waiting in the Atelier for the user's approval: paste the block `pilot ext propose` printed.",
     "fields": '{draft: "d_<12 hex>" (the id pilot ext propose printed), title?}',
     "schema": {"type": "object", "required": ["draft"], "properties": {
         "draft": {"type": "string", "minLength": 14, "maxLength": 14}, "title": _s(120)}}},
]
BUILTIN_TYPES = {b["type"] for b in BUILTINS}


# ---- JSON schema subset ------------------------------------------------------------------------------------------
_KEYWORDS = {"type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems",
             "maxItems", "minLength", "maxLength", "minimum", "maximum", "anyOf", "oneOf", "description", "title",
             "default", "examples", "$comment", "format", "$schema"}
_TYPES = {"string", "number", "integer", "boolean", "array", "object", "null"}


def check_schema(schema: Any, depth: int = 0) -> None:
    """The subset of JSON Schema the app validates (both here and in the browser); raises ValueError on anything
    else: an unknown keyword would otherwise be silently ignored and let any data through."""
    if depth > SCHEMA_DEPTH:
        raise ValueError(f"schema nested deeper than {SCHEMA_DEPTH} levels")
    if schema is True or schema == {}:
        return
    if not isinstance(schema, dict):
        raise ValueError("a schema must be an object")
    unknown = set(schema) - _KEYWORDS
    if unknown:
        raise ValueError(f"unsupported schema keyword(s): {', '.join(sorted(unknown))}")
    t = schema.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not ts or any(x not in _TYPES for x in ts):
            raise ValueError(f"bad schema type {t!r}")
    if "enum" in schema and (not isinstance(schema["enum"], list) or not schema["enum"]):
        raise ValueError("enum must be a non-empty list")
    if "required" in schema and (not isinstance(schema["required"], list)
                                 or not all(isinstance(x, str) for x in schema["required"])):
        raise ValueError("required must be a list of names")
    for k in ("minItems", "maxItems", "minLength", "maxLength"):
        if k in schema and (not isinstance(schema[k], int) or isinstance(schema[k], bool) or schema[k] < 0):
            raise ValueError(f"{k} must be a non-negative integer")
    for k in ("minimum", "maximum"):
        if k in schema and (not isinstance(schema[k], (int, float)) or isinstance(schema[k], bool)):
            raise ValueError(f"{k} must be a number")
    props = schema.get("properties")
    if props is not None:
        if not isinstance(props, dict):
            raise ValueError("properties must be an object")
        for v in props.values():
            check_schema(v, depth + 1)
    ap = schema.get("additionalProperties")
    if ap is not None and not isinstance(ap, bool):
        check_schema(ap, depth + 1)
    items = schema.get("items")
    if isinstance(items, list):
        for v in items:
            check_schema(v, depth + 1)
    elif items is not None:
        check_schema(items, depth + 1)
    for k in ("anyOf", "oneOf"):
        if k in schema:
            if not isinstance(schema[k], list) or not schema[k]:
                raise ValueError(f"{k} must be a non-empty list")
            for v in schema[k]:
                check_schema(v, depth + 1)


def _type_ok(t: str, v: Any) -> bool:
    if t == "string":
        return isinstance(v, str)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "integer":
        return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())
    if t == "boolean":
        return isinstance(v, bool)
    if t == "array":
        return isinstance(v, list)
    if t == "object":
        return isinstance(v, dict)
    return v is None


def validate(schema: Any, data: Any, path: str = "", limit: int = 20) -> list[str]:
    """Errors of `data` against a schema of the subset above, as readable lines (`series[0].points: expected an
    array`), at most `limit`. Mirrors web/src/features/blocks/schema.ts."""
    errors: list[str] = []

    def at(p: str) -> str:
        return p or "(root)"

    def walk(s: Any, v: Any, p: str) -> None:
        if len(errors) >= limit or s is True or not isinstance(s, dict) or not s:
            return
        t = s.get("type")
        if t is not None:
            ts = t if isinstance(t, list) else [t]
            if not any(_type_ok(x, v) for x in ts):
                errors.append(f"{at(p)}: expected {' or '.join(ts)}")
                return
        if "const" in s and v != s["const"]:
            errors.append(f"{at(p)}: must be {json.dumps(s['const'])}")
        if "enum" in s and v not in s["enum"]:
            errors.append(f"{at(p)}: must be one of {', '.join(json.dumps(x) for x in s['enum'])}")
        if isinstance(v, str):
            if "maxLength" in s and len(v) > s["maxLength"]:
                errors.append(f"{at(p)}: longer than {s['maxLength']} characters")
            if "minLength" in s and len(v) < s["minLength"]:
                errors.append(f"{at(p)}: shorter than {s['minLength']} characters")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if "minimum" in s and v < s["minimum"]:
                errors.append(f"{at(p)}: below {s['minimum']}")
            if "maximum" in s and v > s["maximum"]:
                errors.append(f"{at(p)}: above {s['maximum']}")
        if isinstance(v, list):
            if "minItems" in s and len(v) < s["minItems"]:
                errors.append(f"{at(p)}: needs at least {s['minItems']} item(s)")
            if "maxItems" in s and len(v) > s["maxItems"]:
                errors.append(f"{at(p)}: more than {s['maxItems']} items")
            items = s.get("items")
            if isinstance(items, list):
                for i, (sub, x) in enumerate(zip(items, v)):
                    walk(sub, x, f"{p}[{i}]")
            elif isinstance(items, dict):
                for i, x in enumerate(v):
                    if len(errors) >= limit:
                        break
                    walk(items, x, f"{p}[{i}]")
        if isinstance(v, dict):
            for name in s.get("required") or []:
                if name not in v or v[name] is None:
                    errors.append(f"{p + '.' if p else ''}{name}: missing")
            props = s.get("properties") or {}
            ap = s.get("additionalProperties", True)
            for k, x in v.items():
                sub = f"{p}.{k}" if p else str(k)
                if k in props:
                    walk(props[k], x, sub)
                elif ap is False:
                    errors.append(f"{sub}: unknown field")
                elif isinstance(ap, dict):
                    walk(ap, x, sub)
        for key in ("anyOf", "oneOf"):
            alts = s.get(key)
            if alts and not any(not validate(a, v, p, 1) for a in alts):
                first = validate(alts[0], v, p, 1)
                errors.append(first[0] if first else f"{at(p)}: does not match any allowed form")

    walk(schema, data, path)
    return errors[:limit]


# ---- block plugin manifests (extensions/<id>/block.json) ----------------------------------------------------------
def _read_capped(p: Path, cap: int, what: str) -> str:
    try:
        st = p.stat()
    except OSError:
        raise ValueError(f"{what} is missing") from None
    if st.st_size > cap:
        raise ValueError(f"{what} is larger than {cap // 1024} KB")
    return p.read_text("utf-8", "replace")


def _inside(d: Path, name: str, what: str) -> Path:
    try:
        p = (d / name).resolve(strict=True)
        p.relative_to(d.resolve())
    except (OSError, ValueError):
        raise ValueError(f"{what} {name!r} is missing or outside the extension folder") from None
    if not p.is_file():
        raise ValueError(f"{what} {name!r} is not a file")
    return p


def parse_manifest(d: Path) -> dict:
    """Validated block.json of a block extension folder; ValueError with a readable reason otherwise."""
    try:
        m = json.loads(_read_capped(_inside(d, "block.json", "manifest"), MANIFEST_MAX, "block.json"))
    except ValueError as e:
        if "block.json" in str(e):
            raise
        raise ValueError(f"block.json is not valid JSON ({e})") from None
    if not isinstance(m, dict):
        raise ValueError("block.json must contain an object")
    if m.get("type") != "block":
        raise ValueError('block.json needs "type": "block"')
    if d.name in BUILTIN_TYPES:
        raise ValueError(f"{d.name!r} is the name of a built-in block - rename the folder")
    out: dict[str, Any] = {"id": d.name}
    raw = m.get("name")
    names: dict[str, str] = {}
    if isinstance(raw, dict):
        names = {str(k)[:8]: str(v)[:80] for k, v in raw.items() if isinstance(v, str) and v.strip()}
        raw = names.get("en") or next(iter(names.values()), "")
    out["name"], out["names"] = str(raw or d.name)[:80], names
    out["version"] = str(m.get("version") or "")[:20]
    out["icon"] = str(m.get("icon") or "puzzle")[:40]
    out["description"] = str(m.get("description") or "")[:300]
    out["hint"] = " ".join(str(m.get("hint") or "").split())[:200]
    cat = m.get("category") or "other"
    if cat not in CATEGORIES:
        raise ValueError(f"category must be one of {', '.join(CATEGORIES)}")
    out["category"] = cat
    renders = m.get("renders")
    if not isinstance(renders, list) or not renders or len(renders) > MAX_RENDERS:
        raise ValueError(f'"renders" must list 1 to {MAX_RENDERS} block types')
    types: list[str] = []
    for t in renders:
        if not isinstance(t, str) or not TYPE_RE.match(t):
            raise ValueError(f"block type {t!r} must be a lowercase slug (a-z, 0-9, -; 2-32 characters)")
        if t in BUILTIN_TYPES:
            raise ValueError(f"{t!r} is a built-in block type")
        if t in RESERVED_TYPES:
            raise ValueError(f"{t!r} is reserved (a code language or an app block)")
        if t not in types:
            types.append(t)
    out["renders"] = types
    schema = m.get("schema", {"type": "object"})
    if isinstance(schema, str):
        if not SCHEMA_FILE_RE.match(schema):
            raise ValueError('"schema" must be an object or the name of a .json file of the folder')
        try:
            schema = json.loads(_read_capped(_inside(d, schema, "schema"), SCHEMA_MAX, schema))
        except ValueError as e:
            raise ValueError(f"schema: {e}") from None
    elif len(json.dumps(schema)) > SCHEMA_MAX:
        raise ValueError(f"schema is larger than {SCHEMA_MAX // 1024} KB")
    try:
        check_schema(schema)
    except ValueError as e:
        raise ValueError(f"schema: {e}") from None
    out["schema"] = schema
    entry = m.get("entry") or "block.html"
    if not isinstance(entry, str) or not ENTRY_RE.match(entry):
        raise ValueError('"entry" must be the name of an .html file of the folder (e.g. block.html)')
    ep = _inside(d, entry, "entry")
    if ep.stat().st_size > ENTRY_MAX:
        raise ValueError(f"{entry} is larger than {ENTRY_MAX // 1024} KB")
    out["entry"] = entry
    out["entry_v"] = ep.stat().st_mtime_ns // 1_000_000
    perms = m.get("permissions") or {}
    if not isinstance(perms, dict):
        raise ValueError('"permissions" must be an object')
    unknown = set(perms) - {"network"}
    if unknown:
        raise ValueError(f"unsupported permission(s): {', '.join(sorted(unknown))} (only network)")
    hosts = perms.get("network") or []
    if not isinstance(hosts, list) or len(hosts) > MAX_HOSTS:
        raise ValueError(f"permissions.network must list at most {MAX_HOSTS} host names")
    clean: list[str] = []
    for h in hosts:
        if not isinstance(h, str) or not HOST_RE.match(h.lower()):
            raise ValueError(f"network host {h!r} must be a host name such as tiles.example.com (no scheme, no path)")
        if h.lower() not in clean:
            clean.append(h.lower())
    out["network"] = clean
    try:
        out["height"] = min(1200, max(80, int(m.get("height") or 320)))
    except (TypeError, ValueError):
        raise ValueError('"height" must be a number of pixels') from None
    return out


# ---- registry ----------------------------------------------------------------------------------------------------
def _settings() -> dict:
    b = config.load_config().get("blocks")
    return b if isinstance(b, dict) else {}


def disabled_builtins() -> set[str]:
    return {x for x in _settings().get("disabled") or [] if isinstance(x, str)}


def consents() -> dict[str, dict]:
    c = _settings().get("consent") or {}
    return {k: v for k, v in c.items() if isinstance(k, str) and isinstance(v, dict)} if isinstance(c, dict) else {}


def _consent_state(pid: str, hosts: list[str]) -> str | None:
    """None: nothing to ask (no network) · granted / denied · ask."""
    if not hosts:
        return None
    c = consents().get(pid) or {}
    if c.get("state") == "denied":
        return "denied"
    granted = set(c.get("hosts") or [])
    return "granted" if c.get("state") == "granted" and set(hosts) <= granted else "ask"


def _builtin_info(b: dict, disabled: set[str]) -> dict:
    return {"id": b["type"], "kind": "builtin", "name": b["type"], "names": {}, "renders": [b["type"]],
            "icon": b["icon"], "category": b["category"], "hint": b["hint"], "fields": b["fields"],
            "schema": b["schema"], "raw": b.get("raw"), "version": "", "description": "",
            "enabled": b["type"] not in disabled, "error": None, "network": [], "consent": None,
            "pin": bool(b.get("pin")), "entry_v": None, "height": None}


def _light_extensions() -> list[Any]:
    """Block extensions read straight from their block.json (no extension code imported): for the CLI (install,
    doctor) where the server's extension registry is not loaded."""
    from types import SimpleNamespace
    root = config.workspace() / "extensions"
    dis = {x for x in (config.load_config().get("extensions") or {}).get("disabled") or [] if isinstance(x, str)}
    out = []
    try:
        dirs = sorted(d for d in root.iterdir() if d.is_dir() and (d / "block.json").is_file()
                      and not (d / "manifest.json").exists() and not d.name.startswith((".", "_")))
    except OSError:
        return []
    for d in dirs:
        ns = SimpleNamespace(id=d.name, type="block", block=None, error=None, version="", icon="puzzle",
                             enabled=d.name not in dis)
        try:
            ns.block = parse_manifest(d)
            ns.version, ns.icon = ns.block["version"], ns.block["icon"]
        except ValueError as e:
            ns.error = str(e)
        lang = str(config.load_config().get("language") or "en")
        ns.label = (lambda n=ns, lang=lang: ((n.block or {}).get("names") or {}).get(lang)
                    or ((n.block or {}).get("names") or {}).get("en") or (n.block or {}).get("name") or n.id)
        out.append(ns)
    return out


def plugins(light: bool = False) -> list[dict]:
    """Every block plugin: built-ins first (fixed order), then block extensions (A-Z). A type claimed by two
    extensions goes to the first one; the other gets an error. `light`: block.json files read directly instead of
    the extension registry (which imports extension code)."""
    disabled = disabled_builtins()
    out = [_builtin_info(b, disabled) for b in BUILTINS]
    claimed: dict[str, str] = {}
    if light:
        exts = _light_extensions()
    else:
        from . import extensions
        exts = [x for x in extensions.all_extensions() if x.type == "block"]
    for e in sorted(exts, key=lambda x: x.id):
        m = e.block or {}
        info = {"id": e.id, "kind": "extension", "name": e.label(), "names": m.get("names") or {},
                "renders": m.get("renders") or [], "icon": e.icon, "category": m.get("category") or "other",
                "hint": m.get("hint") or "", "fields": "", "schema": m.get("schema") or {"type": "object"},
                "raw": None, "version": e.version, "description": m.get("description") or "",
                "enabled": e.enabled, "error": e.error, "network": m.get("network") or [],
                "consent": None, "pin": False, "entry_v": m.get("entry_v"), "height": m.get("height")}
        info["consent"] = _consent_state(e.id, info["network"])
        if not e.error:
            taken = [t for t in info["renders"] if t in claimed]
            if taken:
                info["error"] = f"block type {taken[0]!r} is already drawn by the extension {claimed[taken[0]]!r}"
            else:
                for t in info["renders"]:
                    claimed[t] = e.id
        out.append(info)
    return out


def get(pid: str) -> dict | None:
    return next((p for p in plugins() if p["id"] == pid), None)


def enabled_plugins(light: bool = False) -> list[dict]:
    return [p for p in plugins(light) if p["enabled"] and not p["error"]]


def set_enabled(pid: str, enabled: bool) -> bool:
    """A built-in (config blocks.disabled) or a block extension (config extensions.disabled). False if unknown."""
    if pid in BUILTIN_TYPES:
        with config._lock:
            cfg = config.load_config()
            b = cfg.get("blocks") if isinstance(cfg.get("blocks"), dict) else {}
            dis = {x for x in b.get("disabled") or [] if isinstance(x, str) and x in BUILTIN_TYPES}
            dis.discard(pid) if enabled else dis.add(pid)
            cfg["blocks"] = {**b, "disabled": sorted(dis)}
            config.save_config(cfg)
        return True
    from . import extensions
    ext = extensions.get(pid)
    if ext is None or ext.type != "block":
        return False
    return extensions.set_enabled(pid, enabled)


# ---- network consent ---------------------------------------------------------------------------------------------
_grants: dict[str, tuple[str, float]] = {}
_grants_lock = threading.Lock()


def set_consent(pid: str, decision: str) -> dict:
    """always: the declared hosts are allowed for good · deny: never asked again · reset: asked again ·
    once: a grant token for one frame (an hour). Returns {consent, grant?}. LookupError / ValueError."""
    p = get(pid)
    if p is None or p["kind"] != "extension":
        raise LookupError(f"no block extension {pid}")
    if not p["network"]:
        raise ValueError("this block asks for no network access")
    if decision == "once":
        token = secrets.token_urlsafe(18)
        now = time.time()
        with _grants_lock:
            for k in [k for k, (_, exp) in _grants.items() if exp < now]:
                _grants.pop(k, None)
            if len(_grants) > 500:
                _grants.clear()
            _grants[token] = (pid, now + GRANT_TTL_S)
        return {"consent": p["consent"], "grant": token}
    if decision not in ("always", "deny", "reset"):
        raise ValueError("decision must be always, once, deny or reset")
    with config._lock:
        cfg = config.load_config()
        b = cfg.get("blocks") if isinstance(cfg.get("blocks"), dict) else {}
        c = dict(b.get("consent") or {}) if isinstance(b.get("consent"), dict) else {}
        if decision == "reset":
            c.pop(pid, None)
        else:
            c[pid] = {"state": "granted" if decision == "always" else "denied",
                      "hosts": p["network"] if decision == "always" else [], "at": time.time()}
        cfg["blocks"] = {**b, "consent": c}
        config.save_config(cfg)
    return {"consent": _consent_state(pid, p["network"])}


def grant_ok(pid: str, token: str | None) -> bool:
    if not token:
        return False
    with _grants_lock:
        hit = _grants.get(token)
    return bool(hit and hit[0] == pid and hit[1] > time.time())


def allowed_hosts(p: dict, grant: str | None = None) -> list[str]:
    if not p["network"]:
        return []
    if p["consent"] == "granted" or (p["consent"] != "denied" and grant_ok(p["id"], grant)):
        return list(p["network"])
    return []


def frame_csp(hosts: list[str]) -> str:
    """Content-Security-Policy of a block frame: its own document, sandboxed (opaque origin: no cookie, no app API),
    inline code only, and the network limited to `hosts` (https) - none by default."""
    src = " ".join(f"https://{h}" for h in hosts)
    net = src or "'none'"
    media = f"data: blob:{' ' + src if src else ''}"
    return ("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            f"img-src {media}; media-src {media}; font-src data:{' ' + src if src else ''}; connect-src {net}; "
            "form-action 'none'; base-uri 'none'; frame-ancestors 'self'")


# ---- dashboard pin -----------------------------------------------------------------------------------------------
def _ts(v: Any) -> float | None:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str) and v.strip():
        from datetime import datetime, timezone
        s = v.strip().replace("Z", "+00:00")
        try:
            d = datetime.fromisoformat(s)
        except ValueError:
            return None
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.timestamp()
    return None


def to_card(btype: str, data: dict, title: str = "") -> dict:
    """A dashboard Card (API.md#dashboard--extensions) from a block of a pinnable type. ValueError otherwise."""
    b = next((x for x in BUILTINS if x["type"] == btype), None)
    if b is None or not b.get("pin"):
        raise ValueError(f"{btype} blocks cannot be pinned to the dashboard")
    errs = validate(b["schema"], data)
    if errs:
        raise ValueError("; ".join(errs[:3]))
    title = (title or str(data.get("title") or "")).strip()[:80]
    if btype == "chart":
        blocks = [{"type": "chart", "kind": data.get("kind") or "line", "series": data["series"],
                   **({"unit": data["unit"]} if data.get("unit") else {})}]
    elif btype == "table":
        cols = [c if isinstance(c, str) else str(c.get("label") or "") for c in data["columns"]]
        blocks = [{"type": "table", "columns": cols, "rows": [r[:len(cols)] for r in data["rows"][:50]]}]
    elif btype == "stats":
        keys = ("label", "value", "unit", "delta", "hint", "tone")
        blocks = [{"type": "stats", "items": [{k: it[k] for k in keys if k in it} for it in data["items"]]}]
    elif btype == "list":
        blocks = [{"type": "list", "items": data["items"][:50], **({"grid": True} if data.get("grid") else {})}]
    elif btype == "progress":
        items = data.get("items") or [data]
        blocks = [{"type": "progress", **{k: it[k] for k in ("label", "value", "max", "unit", "hint", "format")
                                          if k in it}} for it in items]
    else:                                                                   # timeline
        lanes = []
        for lane in data["lanes"]:
            evs = [{**e, "at": _ts(e.get("at"))} for e in lane.get("events") or []]
            lanes.append({**{k: lane[k] for k in ("name", "sub") if k in lane},
                          "events": [e for e in evs if e["at"] is not None]})
        stamps = [e["at"] for lane in lanes for e in lane["events"]]
        start, end = _ts(data.get("start")), _ts(data.get("end"))
        start = start if start is not None else (min(stamps) if stamps else time.time() - 86400)
        end = end if end is not None else (max(stamps) if stamps else time.time())
        if end <= start:
            end = start + 3600
        blocks = [{"type": "timeline", "start": start, "end": end, "lanes": lanes,
                   **({"now": _ts(data["now"])} if _ts(data.get("now")) is not None else {})}]
    from . import extensions
    return extensions.clean_card({"title": title, "blocks": blocks})


PIN_API = '''"""Dashboard widget pinned from a conversation block (harness-pilot). Its card is the snapshot in card.json."""
import json
from pathlib import Path


def card(ctx):
    return json.loads((Path(__file__).parent / "card.json").read_text("utf-8"))
'''


def pin(btype: str, data: dict, title: str = "") -> str:
    """Write a widget extension `pin-<slug>-<hex>` whose card is this block's snapshot; returns its id."""
    from . import extensions
    card = to_card(btype, data, title)
    label = card.get("title") or btype.capitalize()
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:24].strip("-") or btype
    eid = f"pin-{slug}-{secrets.token_hex(3)}"
    d = extensions.root() / eid
    d.mkdir(parents=True, exist_ok=False)
    icon = next(b["icon"] for b in BUILTINS if b["type"] == btype)
    config.write_json(d / "card.json", {**card, "title": label})
    (d / "api.py").write_text(PIN_API, encoding="utf-8")
    config.write_json(d / "manifest.json", {"id": eid, "name": label, "type": "widget", "icon": icon,
                                            "version": "1", "span": 2 if btype in ("chart", "table", "timeline") else 1,
                                            "ttl": 86400})
    from . import atelier                              # the user pinned it: a version approved by the user
    atelier.record_user_install(eid, "pinned from a conversation")
    extensions.scan()
    return eid


# ---- what the agents read ----------------------------------------------------------------------------------------
SKILL = "pilot-blocks"


def reference_path() -> Path:
    return config.STATE / "blocks" / "reference.md"


def agents_path() -> Path:
    """The short list of enabled types the Codex turns get (sessions/codex.py reads it, stdlib only)."""
    return config.STATE / "blocks" / "agents.md"


def _fields(p: dict) -> str:
    if p["fields"]:
        return p["fields"]
    props = (p["schema"] or {}).get("properties") or {}
    req = set((p["schema"] or {}).get("required") or [])
    return "{" + ", ".join(f"{k}{'' if k in req else '?'}" for k in list(props)[:12]) + "}" if props else "JSON object"


def enabled_table(ps: list[dict]) -> str:
    """The enabled block types, one table row each (type, when to use it, body)."""
    if not ps:
        return ("Conversation blocks are turned off on this server: never answer with a block fence (```chart, "
                "```table...); use plain markdown.")
    lines = ["| Type | Use it for | Body |", "|---|---|---|"]
    for p in ps:
        hint = (p["hint"] or p["name"]).replace("|", "/")
        for t in p["renders"]:
            lines.append(f"| `{t}` | {hint} | `{_fields(p).replace('|', chr(92) + '|')}` |")
    return "\n".join(lines)


def agents_text(ps: list[dict]) -> str:
    """What a Codex turn gets: the format in three lines and the enabled types."""
    if not ps:
        return "# Conversation blocks\n\n" + enabled_table(ps) + "\n"
    return "\n".join([
        "# Conversation blocks (enabled on this server)", "",
        "The web UI draws a fenced block whose info string is one of the types below as a rich block; the body is ONE",
        "JSON object (terminal, diff and app also take raw text). Use only these types, and only when a block says more",
        "than a sentence would; keep a sentence of context around it (Telegram shows the raw JSON). Invalid data is shown",
        f"raw with the reason. Full schemas: `{reference_path()}`.", "",
        enabled_table(ps), ""])


def agent_reference(ps: list[dict]) -> str:
    """Full reference (with JSON schemas) of the enabled block types."""
    out = ["# Conversation blocks enabled on this server", "",
           "Generated by harness-pilot; changes when a block is turned on or off (Settings -> Conversation blocks).",
           "Emit a block as a fenced code block: the info string is the type, the body is one JSON object matching",
           "the schema (```<type>\\n{...}\\n```). Invalid data is shown raw with the reason, so check required fields.", ""]
    if not ps:
        out.append("No block type is enabled: answer in plain markdown.")
    for p in ps:
        for t in p["renders"]:
            out += [f"## `{t}`" + ("" if p["kind"] == "builtin" else f" (extension `{p['id']}`)"), "",
                    p["hint"] or p["name"], "", f"Body: `{_fields(p)}`" + (
                        f" - or raw text, read as `{p['raw']}`" if p.get("raw") else ""), "",
                    "```json", json.dumps(p["schema"], ensure_ascii=False, separators=(",", ":")), "```", ""]
    return "\n".join(out).rstrip() + "\n"


def skill_vars(ps: list[dict] | None = None) -> dict[str, str]:
    """Placeholders of skills/pilot-blocks/SKILL.md (also used by cmd_core._skill_vars at install)."""
    ps = enabled_plugins(light=True) if ps is None else ps
    types = [t for p in ps for t in p["renders"]]
    return {"{{PILOT_BLOCKS_TYPES}}": ", ".join(types) if types else "none (blocks are turned off: never emit one)",
            "{{PILOT_BLOCKS_ENABLED}}": enabled_table(ps)}


def _write(p: Path, text: str) -> bool:
    try:
        if p.read_text("utf-8") == text:
            return False
    except OSError:
        pass
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(p)
    return True


_sync_lock = threading.Lock()
_last_sync: dict[str, Any] = {"at": None}


def sync_agent_files(light: bool = False) -> dict:
    """Write the enabled types where the agents read them: `<state>/blocks/agents.md` (Codex) and `reference.md`
    (full schemas), and the installed `pilot-blocks` skill rendered again with the list (Claude Code's and Codex's
    copies; only when installed - `pilot init` installs them). Idempotent: files are rewritten only when they change."""
    ps = enabled_plugins(light)
    changed: list[str] = []
    with _sync_lock:
        if _write(agents_path(), agents_text(ps)):
            changed.append(str(agents_path()))
        if _write(reference_path(), agent_reference(ps)):
            changed.append(str(reference_path()))
        src = config.SKILLS_DIR / SKILL / "SKILL.md"
        from .cmd_core import codex_skills_target, skills_target
        for dst in (skills_target() / SKILL / "SKILL.md", codex_skills_target() / SKILL / "SKILL.md"):
            if src.is_file() and dst.parent.is_dir():
                from .cmd_core import render_template, template_vars
                text = render_template(src.read_text("utf-8"), {**template_vars(config.workspace()), **skill_vars(ps)})
                if _write(dst, text):
                    changed.append(str(dst))
        _last_sync["at"] = time.time()
    return {"changed": changed, "at": _last_sync["at"]}


def agents_summary() -> dict:
    types = [t for p in enabled_plugins() for t in p["renders"]]
    from .cmd_core import skills_target
    return {"types": types, "count": len(types), "skill": str(skills_target() / SKILL / "SKILL.md"),
            "codex": str(agents_path()), "reference": str(reference_path()), "synced_at": _last_sync["at"]}
