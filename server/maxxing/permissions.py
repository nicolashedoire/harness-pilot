"""Declared permissions of extensions: what a widget or page says it uses beyond its own folder.

    manifest.json  "permissions": {"network": ["api.example.com"], "secrets": ["SHOP_TOKEN"], "read": ["projects/shop"]}

- network: host names its HTML widget frame reaches over https (`blocks.HOST_RE`: `api.example.com`, `*.example.com`,
  an optional `:port`; no scheme, no path), at most MAX_HOSTS.
- secrets: names of Keys (Settings -> Keys, `vault.NAME_RE`) its api.py reads with ctx["secret"](name), at most
  MAX_SECRETS.
- read: files or folders of the workspace its api.py reads, relative to the workspace ("." = all of it), at most
  MAX_READ. Its own folder and ctx["state_dir"] are always its own and are never declared.

`parse()` validates the manifest's value (None when the key is absent, ValueError with a readable reason otherwise);
`extensions._load_one` stores the result as `Extension.permissions` (a block plugin's: its block.json hosts). `view()`
is the `Permissions` of the Atelier contract. See docs/dev/API.md#dashboard--extensions and #atelier.

Enforced: the keys. `ctx["secret"]` is `secret_reader(ext)`: a declared key the user allowed (`set_consent`, or the
Atelier's approval: `accept`), or - for an extension without a declaration that existed before permissions
(`baseline`) - any key, each one recorded the first time as granted before permissions existed. Anything else raises
PermissionDenied and is recorded (`access(ext)["denied"]`, exterrors).
"""
from __future__ import annotations

import copy
import logging
import posixpath
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("maxxing.permissions")

KEYS = ("network", "secrets", "read")
MAX_HOSTS = 8
MAX_SECRETS = 32
MAX_READ = 32
READ_MAX_LEN = 300


def _list(perms: dict, key: str, cap: int, what: str) -> list:
    v = perms.get(key)
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > cap:
        raise ValueError(f"permissions.{key} must list at most {cap} {what}")
    return v


def _read_path(p: Any) -> str:
    if not isinstance(p, str) or not p.strip() or len(p) > READ_MAX_LEN:
        raise ValueError(f"permissions.read: {p!r} must be a path of the workspace (1-{READ_MAX_LEN} characters)")
    raw = p.strip()
    if raw.startswith(("/", "~")) or "\\" in raw or "\0" in raw:
        raise ValueError(f"permissions.read: {p!r} must be relative to the workspace (no leading / or ~, no \\)")
    parts = [x for x in raw.split("/") if x not in ("", ".")]
    if any(x == ".." for x in parts):
        raise ValueError(f"permissions.read: {p!r} must stay inside the workspace (no ..)")
    return posixpath.join(*parts) if parts else "."


def parse(raw: Any) -> dict | None:
    """The manifest's "permissions" -> {network, secrets, read} (manifest order, duplicates dropped), None when absent.
    ValueError with a readable reason for anything else."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError('"permissions" must be an object: {"network": [...], "secrets": [...], "read": [...]}')
    unknown = set(raw) - set(KEYS)
    if unknown:
        raise ValueError(f"permissions: unsupported key(s) {', '.join(sorted(map(str, unknown)))} "
                         "(network, secrets, read)")
    from .blocks import HOST_RE
    from .vault import NAME_RE
    out: dict[str, list[str]] = {k: [] for k in KEYS}
    for h in _list(raw, "network", MAX_HOSTS, "host names"):
        if not isinstance(h, str) or not HOST_RE.match(h.lower()):
            raise ValueError(f"permissions.network: {h!r} must be a host name such as api.example.com "
                             "(no https://, no path)")
        if h.lower() not in out["network"]:
            out["network"].append(h.lower())
    for n in _list(raw, "secrets", MAX_SECRETS, "key names"):
        if not isinstance(n, str) or not NAME_RE.match(n):
            raise ValueError(f"permissions.secrets: {n!r} must be the name of a key of Settings -> Keys "
                             "(A-Z, 0-9 and _, starting with a letter)")
        if n not in out["secrets"]:
            out["secrets"].append(n)
    for p in _list(raw, "read", MAX_READ, "paths"):
        path = _read_path(p)
        if path not in out["read"]:
            out["read"].append(path)
    return out


def host_ok(host: str) -> bool:
    """A host name as permissions.network takes it (blocks.HOST_RE)."""
    from .blocks import HOST_RE
    return bool(HOST_RE.match(host))


def summary(perms: dict | None) -> str:
    """One line: "network: a.example.com · keys: SHOP_TOKEN · reads: projects/shop" ("nothing" when empty)."""
    if perms is None:
        return "not declared"
    parts = [f"{label}: {', '.join(perms.get(k) or [])}"
             for k, label in (("network", "network"), ("secrets", "keys"), ("read", "reads")) if perms.get(k)]
    return " · ".join(parts) or "nothing"


def view(perms: dict | None) -> dict:
    """The Atelier's `Permissions` of a declaration (`Extension.permissions`): {network, secrets, read, declared},
    lists always present ([] when none), declared = the manifest has a "permissions" object at all."""
    p = perms or {}
    return {"network": list(p.get("network") or []), "secrets": list(p.get("secrets") or []),
            "read": list(p.get("read") or []), "declared": perms is not None}


# ---- what the user granted (secrets) ----------------------------------------------------------------------------------
# <state>/extension-permissions.json (config.write_json, under _lock):
#   {"since": ts,                                   when permissions came in (the first scan of this version)
#    "legacy": {"<id>": ts},                        extension folders that existed then (grandfathered)
#    "extensions": {"<id>": {
#        "secrets": {"NAME": {"at": ts, "how": "accepted"|"legacy"}},
#        "refused": ts | null,                      the user refused: nothing it declares is allowed
#        "denied": [{"kind": "secret", "name", "reason", "at", "count"}]}}}   refusals at run time, newest first
FILE = "extension-permissions.json"
DENIED_KEEP = 20
DENIED_WRITE_S = 60.0                  # an unchanged refusal is written again (count, at) at most once a minute
REASONS = ("undeclared", "not_allowed", "refused")

_lock = threading.RLock()
_cache: dict[str, Any] = {"key": None, "data": None}


class PermissionDenied(PermissionError):
    """ctx["secret"](name) refused: `reason` = undeclared (not in the manifest's "permissions") | not_allowed (declared,
    waiting for the user) | refused (the user refused)."""

    def __init__(self, eid: str, kind: str, name: str, reason: str, message: str):
        super().__init__(message)
        self.eid, self.kind, self.name, self.reason = eid, kind, name, reason

    @property
    def needs_consent(self) -> bool:
        return self.reason == "not_allowed"

    def detail(self) -> dict:
        return {"kind": self.kind, "name": self.name, "reason": self.reason}


def _path() -> Path:
    from . import config
    return config.STATE / FILE


def _load() -> dict:
    """The state file (cached until it changes); {} when missing or damaged. Never mutate the result."""
    from . import config
    p = _path()
    try:
        st = p.stat()
        key = (st.st_mtime_ns, st.st_size, str(p))
    except OSError:
        return {}
    if _cache["key"] != key:
        d = config.read_json(p, {})
        _cache.update(key=key, data=d if isinstance(d, dict) else {})
    return _cache["data"]


def _save(d: dict) -> None:
    from . import config
    config.write_json(_path(), d)
    _cache.update(key=None, data=None)


def _rec(d: dict, eid: str) -> dict:
    exts = d.setdefault("extensions", {})
    if not isinstance(exts, dict):
        exts = d["extensions"] = {}
    r = exts.setdefault(eid, {})
    if not isinstance(r, dict):
        r = exts[eid] = {}
    return r


def _entry(eid: str, d: dict | None = None) -> dict:
    d = _load() if d is None else d
    r = (d.get("extensions") or {}).get(eid)
    return r if isinstance(r, dict) else {}


def baseline(ids: list[str]) -> None:
    """The first time this version scans the extensions: every folder present now existed before permissions and is
    grandfathered (`legacy`). Later calls do nothing. Never raises (an unwritable state: no baseline, see is_legacy)."""
    if _load().get("since"):
        return
    with _lock:
        try:
            d = copy.deepcopy(_load())
            if d.get("since"):
                return
            now = time.time()
            d["since"] = now
            d["legacy"] = {i: now for i in ids}
            _save(d)
        except OSError:
            log.warning("extension permissions: cannot record which extensions existed before", exc_info=True)


def is_legacy(eid: str) -> bool:
    """The extension existed before permissions (or no baseline could be written yet: never break one)."""
    d = _load()
    return not d.get("since") or eid in (d.get("legacy") or {})


def _granted(r: dict, kind: str = "secrets") -> dict[str, dict]:
    """{name or host: {at, how}} granted to an extension (`kind` = secrets | network)."""
    g = r.get(kind)
    return {k: v for k, v in g.items() if isinstance(v, dict)} if isinstance(g, dict) else {}


def _secrets_granted(r: dict) -> dict[str, dict]:
    return _granted(r, "secrets")


def check_secret(ext: Any, name: str) -> str | None:
    """None when `ext` may read the key `name` now, else the reason (REASONS). A grandfathered extension without a
    declaration may read any key (recorded by `secret_reader`)."""
    r = _entry(ext.id)
    if r.get("refused"):
        return "refused"
    perms = ext.permissions
    if perms is None:
        return None if is_legacy(ext.id) else "undeclared"
    if name not in perms["secrets"]:
        return "undeclared"
    return None if name in _secrets_granted(r) else "not_allowed"


def _message(ext: Any, name: str, reason: str) -> str:
    if reason == "refused":
        return f"reading the key {name} was refused for this extension (Settings -> Extensions)"
    if reason == "not_allowed":
        return (f"reading the key {name} waits for your permission: Settings -> Extensions -> {ext.label()} -> Allow")
    if ext.permissions is None:
        return (f'manifest.json declares no "permissions": add "permissions": {{"secrets": ["{name}"]}} to read the key '
                f"{name}, then allow it (Settings -> Extensions)")
    return (f'the key {name} is not in manifest.json "permissions.secrets": add it there to read it, then allow it '
            "(Settings -> Extensions)")


LEGACY_HOSTS_MAX = 50                   # sites recorded for one grandfathered HTML widget at most


def _record_legacy(ext: Any, kind: str, name: str) -> None:
    """A grandfathered extension used a key (`kind` secret) or reached a site (`kind` network) for the first time:
    recorded as granted before permissions existed, with a feed notice listing everything recorded so far."""
    key = "secrets" if kind == "secret" else "network"
    with _lock:
        d = copy.deepcopy(_load())
        r = _rec(d, ext.id)
        granted = r.setdefault(key, {})
        if name in granted or (key == "network" and len(granted) >= LEGACY_HOSTS_MAX):
            return
        granted[name] = {"at": time.time(), "how": "legacy"}
        _save(d)
        names = sorted(k for k, v in granted.items() if v.get("how") == "legacy")
    log.info("extension %s: %s %s recorded as granted before permissions existed", ext.id, kind, name)
    from . import feed
    if key == "secrets":
        title, what = f"“{ext.label()}” keeps reading the keys {', '.join(names)}", "the keys it reads"
        kind_, params = "extension.legacy_secrets", {"secrets": ", ".join(names)}
    else:
        title, what = f"“{ext.label()}” keeps reaching {', '.join(names)}", "the sites its HTML widget reaches"
        kind_, params = "extension.legacy_network", {"hosts": ", ".join(names)}
    feed.system(title, f"It existed before extensions declared their permissions: {what} are recorded as granted. "
                "See Settings -> Extensions.", "info", "security", "/settings/extensions",
                group=f"ext-legacy:{ext.id}:{key}", kind=kind_,
                params={"extension_id": ext.id, "name": ext.label(), **params},
                actions=[feed.link("open", "Open", "/settings/extensions")])


def record_hosts(ext: Any, hosts: list[str]) -> list[str]:
    """Sites a grandfathered HTML widget reached (its frame's report-only policy saw them): each new one is recorded as
    granted before permissions existed. Only while the extension has no declaration and is not refused. -> the hosts
    recorded now."""
    if ext.permissions is not None or not is_legacy(ext.id) or _entry(ext.id).get("refused"):
        return []
    known = _granted(_entry(ext.id), "network")
    new = [h for h in dict.fromkeys(hosts) if h not in known]
    for h in new:
        _record_legacy(ext, "network", h)
    return new


def _record_denied(ext: Any, kind: str, name: str, reason: str, message: str, where: str | None) -> None:
    """A refusal at run time: kept for Settings / the Atelier (`denied`), and as a runtime error of the extension
    (exterrors, `where` = card / api). Never raises."""
    now = time.time()
    try:
        with _lock:
            d = copy.deepcopy(_load())
            r = _rec(d, ext.id)
            rows = [x for x in r.get("denied") or [] if isinstance(x, dict)]
            hit = next((x for x in rows if (x.get("kind"), x.get("name"), x.get("reason")) == (kind, name, reason)),
                       None)
            if hit is not None and now - float(hit.get("at") or 0) < DENIED_WRITE_S:
                return                                   # seen less than a minute ago: nothing new to say
            if hit is not None:
                rows.remove(hit)
            rows.insert(0, {"kind": kind, "name": name, "reason": reason, "at": now,
                            "count": int((hit or {}).get("count") or 0) + 1})
            r["denied"] = rows[:DENIED_KEEP]
            _save(d)
        log.warning("extension %s: %s", ext.id, message)
        if where:
            from . import exterrors
            exterrors.record(ext.id, ext.dir, where, f"PermissionDenied: {message}")
            from . import bus
            bus.invalidate("extensions")
    except Exception:  # noqa: BLE001 - a refusal is reported by its exception anyway
        log.warning("extension %s: could not record a permission refusal", ext.id, exc_info=True)


def secret_reader(ext: Any, where: str | None = None, record: bool = True) -> Callable[[str], str | None]:
    """ctx["secret"] of an extension: the key's value when the extension may read it (vault.get: None when the key is
    missing), PermissionDenied otherwise. `where` (card / api): what a refusal is recorded as in exterrors; `record`
    False (pilot ext check): neither refusals nor grandfathered keys are recorded."""
    from . import vault

    def secret(name: str) -> str | None:
        name = str(name)
        reason = check_secret(ext, name)
        if reason is None:
            if (record and ext.permissions is None and vault.NAME_RE.match(name)
                    and name not in _secrets_granted(_entry(ext.id))):
                try:
                    _record_legacy(ext, "secret", name)
                except Exception:  # noqa: BLE001 - never breaks a grandfathered extension
                    log.warning("extension %s: could not record the key %s", ext.id, name, exc_info=True)
            return vault.get(name)
        message = _message(ext, name, reason)
        if record:
            _record_denied(ext, "secret", name, reason, message, where)
        raise PermissionDenied(ext.id, "secret", name, reason, message)
    return secret


# ---- the user's decision -----------------------------------------------------------------------------------------------
GRANT_TTL_S = 3600
_once: dict[str, tuple[str, float]] = {}
_once_lock = threading.Lock()


def set_consent(ext: Any, decision: str) -> dict:
    """always: what the manifest declares is allowed - keys and sites (one added later asks again) · deny: nothing it
    declares is allowed, never asked again · reset: asked again (what was granted before permissions existed stays) ·
    once: its HTML widget frame may reach the declared sites for one load (a grant token, an hour, in memory).
    -> access(ext) (+ "grant" for once). ValueError: `not_declared` (always without a declaration), `no_network` (once
    without declared sites), bad decision."""
    if decision not in ("always", "deny", "reset", "once"):
        raise ValueError("decision must be always, once, deny or reset")
    if decision in ("always", "once") and ext.permissions is None:
        raise ValueError('this extension declares no "permissions": nothing to allow')
    if decision == "once":
        if not ext.permissions["network"]:
            raise ValueError("this extension declares no site to reach")
        token, now = secrets.token_urlsafe(18), time.time()
        with _once_lock:
            for k in [k for k, (_, exp) in _once.items() if exp < now]:
                _once.pop(k, None)
            if len(_once) > 500:
                _once.clear()
            _once[token] = (ext.id, now + GRANT_TTL_S)
        return {**access(ext), "grant": token}
    if decision == "always":
        return accept(ext.id, ext.permissions, ext=ext)
    with _lock:
        d = copy.deepcopy(_load())
        r = _rec(d, ext.id)
        for key in ("secrets", "network"):
            r[key] = {k: v for k, v in _granted(r, key).items() if v.get("how") == "legacy"}
        r["refused"] = time.time() if decision == "deny" else None
        _save(d)
    return access(ext)


def grant_ok(eid: str, token: str | None) -> bool:
    """A valid "once" grant of `eid` (set_consent)."""
    if not token:
        return False
    with _once_lock:
        hit = _once.get(token)
    return bool(hit and hit[0] == eid and hit[1] > time.time())


def accept(eid: str, perms: dict | None = None, ext: Any = None) -> dict:
    """The user allowed what `perms` declares (default: the extension's current declaration): every key and site it
    lists is granted, a refusal is cleared. Called by Allow (set_consent "always") and by the Atelier when the user
    approves a version. -> access of the extension (when it is known)."""
    if ext is None:
        from . import extensions
        ext = extensions.get(eid)
    if perms is None:
        perms = ext.permissions if ext is not None else None
    perms = perms or {}
    now = time.time()
    with _lock:
        d = copy.deepcopy(_load())
        r = _rec(d, eid)
        for key in ("secrets", "network"):
            granted = _granted(r, key)
            for n in perms.get(key) or []:
                if n not in granted:
                    granted[n] = {"at": now, "how": "accepted"}
            r[key] = granted
        r["refused"] = None
        _save(d)
    return access(ext) if ext is not None else {}


def forget(eid: str) -> None:
    """Drop what was granted to `eid` (the extension was deleted: a new one with the same id asks again)."""
    with _lock:
        d = copy.deepcopy(_load())
        if eid in (d.get("extensions") or {}) or eid in (d.get("legacy") or {}):
            (d.get("extensions") or {}).pop(eid, None)
            (d.get("legacy") or {}).pop(eid, None)
            _save(d)


# ---- the HTML widget frame's network ----------------------------------------------------------------------------------
def frame_network(ext: Any, grant: str | None = None) -> dict:
    """What the HTML widget frame of `ext` may reach: {open, hosts, known}.
    open: no limit as before permissions (a grandfathered widget without a declaration, not refused): `known` = the
    sites recorded so far (its report-only policy reports the others); otherwise `hosts` = the declared sites the user
    allowed (all of them with a valid "once" grant), [] for a widget that declares none or was refused."""
    r = _entry(ext.id)
    perms = ext.permissions
    refused = bool(r.get("refused"))
    if perms is None:
        if is_legacy(ext.id) and not refused:
            return {"open": True, "hosts": [], "known": sorted(_granted(r, "network"))}
        return {"open": False, "hosts": [], "known": []}
    if refused:
        return {"open": False, "hosts": [], "known": []}
    if grant_ok(ext.id, grant):
        return {"open": False, "hosts": list(perms["network"]), "known": []}
    allowed = _granted(r, "network")
    return {"open": False, "hosts": [h for h in perms["network"] if h in allowed], "known": []}


def network_state(ext: Any) -> str:
    """The HTML widget's network for the dashboard: open (grandfathered, not limited) · none (declares no site) ·
    granted · ask (a declared site waits for the user) · denied (refused)."""
    perms = ext.permissions
    r = _entry(ext.id)
    if r.get("refused"):
        return "denied" if perms is None or perms["network"] else "none"
    if perms is None:
        return "open" if is_legacy(ext.id) else "none"
    if not perms["network"]:
        return "none"
    allowed = _granted(r, "network")
    return "granted" if all(h in allowed for h in perms["network"]) else "ask"


# ---- what the user sees -------------------------------------------------------------------------------------------------
def _rows(names: list[str], granted: dict, refused: bool) -> list[dict]:
    return [{"status": "refused" if refused else "allowed" if g else "pending", "how": (g or {}).get("how"),
             "at": (g or {}).get("at"), "_n": n} for n in names for g in [granted.get(n)]]


def access(ext: Any, d: dict | None = None) -> dict:
    """Access of a widget or page (API.md): what runs today and what waits for the user."""
    d = _load() if d is None else d
    r = _entry(ext.id, d)
    perms = ext.permissions
    legacy = not d.get("since") or ext.id in (d.get("legacy") or {})
    refused = bool(r.get("refused"))
    out: dict[str, Any] = {}
    if perms is not None:
        state = "declared"
        for key, label in (("secrets", "name"), ("network", "host")):
            out[key] = [{label: x.pop("_n"), **x} for x in _rows(perms[key], _granted(r, key), refused)]
    else:
        state = "legacy" if legacy else "undeclared"
        for key, label in (("secrets", "name"), ("network", "host")):
            names = sorted(_granted(r, key)) if legacy else []
            out[key] = [{label: x.pop("_n"), **x} for x in _rows(names, _granted(r, key), refused)]
    return {
        "state": state,
        **out,
        "network_open": state == "legacy" and not refused,
        "legacy": {"secrets": [{"name": n, "at": g.get("at")} for n, g in sorted(_granted(r).items())
                               if g.get("how") == "legacy"],
                   "network": [{"host": n, "at": g.get("at")} for n, g in sorted(_granted(r, "network").items())
                               if g.get("how") == "legacy"]},
        "pending": any(x["status"] == "pending" for key in ("secrets", "network") for x in out[key]),
        "refused": refused,
        "denied": [{k: x.get(k) for k in ("kind", "name", "reason", "at", "count")}
                   for x in r.get("denied") or [] if isinstance(x, dict)],
    }


def suggested(ext: Any, d: dict | None = None) -> dict:
    """The declaration that keeps a grandfathered extension working: what it was recorded using."""
    r = _entry(ext.id, d)
    base = ext.permissions or {"network": [], "secrets": [], "read": []}
    out = {"read": list(base.get("read") or [])}
    for key in ("network", "secrets"):
        keep = sorted(k for k, v in _granted(r, key).items() if v.get("how") == "legacy")
        out[key] = [*base.get(key, []), *(k for k in keep if k not in base.get(key, []))]
    return {"network": out["network"], "secrets": out["secrets"], "read": out["read"]}


def detail(ext: Any, d: dict | None = None) -> dict:
    """GET /api/extensions/{id}/permissions."""
    return {"id": ext.id, "name": ext.label(), "type": ext.type, "permissions": ext.permissions,
            "access": access(ext, d), "suggested": suggested(ext, d)}


def since() -> float | None:
    v = _load().get("since")
    return float(v) if isinstance(v, (int, float)) else None
