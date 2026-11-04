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
"""
from __future__ import annotations

import posixpath
from typing import Any

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
