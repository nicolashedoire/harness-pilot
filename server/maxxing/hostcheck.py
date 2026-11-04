"""`Host` header check against DNS rebinding (docs/dev/API.md, before the routes).

A page on another site can have the browser send requests to this server under the attacker's own name: the name
first resolves to the attacker, then to 127.0.0.1 (or the Tailscale address) once the page is loaded. Those requests
carry `Host: <attacker's name>`. The session cookie is not sent to that name, but the public routes (sign-in,
setup, state) would answer. Only these `Host` values are served (port, case and a trailing dot ignored):
- an IP address (127.0.0.1, ::1, the Tailscale or LAN address): a page whose origin is an address of this server
  is not a rebinding attack;
- `localhost` and `*.localhost` (browsers resolve them to loopback themselves);
- `*.ts.net` (Tailscale MagicDNS: names Tailscale assigns to the tailnet's own machines) and `*.local` (mDNS, which
  only resolves on the local network): an attacker's site cannot be served under them;
- the host of config `public_url` (the domain behind Caddy) and config `bind` when it is a name;
- the names of config `allowed_hosts` and of MAXXING_ALLOWED_HOSTS (comma separated): another name in front of this
  server (reverse proxy, tunnel). `*` there turns the check off.
Anything else: 421 `bad_host` (HTTP), or the WebSocket is closed before it is accepted. No `Host` header: served.
"""
from __future__ import annotations

import ipaddress
import os
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse

from . import config


_OWN_SUFFIXES = (".localhost", ".ts.net", ".local")   # loopback, Tailscale MagicDNS, mDNS: not an attacker's names


def hostname(value: str) -> str:
    """'Example.COM.:443' -> 'example.com'; '[::1]:8787' -> '::1'; '' when it cannot be read."""
    v = value.strip().lower()
    if v.startswith("["):
        end = v.find("]")
        return v[1:end] if end > 0 else ""
    if v.count(":") == 1:                     # name:port or ipv4:port (a bare IPv6 address has several colons)
        v = v.split(":", 1)[0]
    return v.rstrip(".")


def _is_ip(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def _names(cfg: dict) -> set[str]:
    names = {hostname(x) for x in str(os.environ.get("MAXXING_ALLOWED_HOSTS") or "").split(",")}
    extra = cfg.get("allowed_hosts")
    for x in ([extra] if isinstance(extra, str) else extra if isinstance(extra, list) else []):
        if isinstance(x, str):
            names.add("*" if x.strip() == "*" else hostname(x))
    try:
        names.add(hostname(urlsplit(str(cfg.get("public_url") or "")).hostname or ""))
    except ValueError:
        pass
    names.add(hostname(str(cfg.get("bind") or "")))
    names.discard("")
    return names


def allowed(host: str | None, cfg: dict | None = None) -> bool:
    if host is None:
        return True
    name = hostname(host)
    if not name:
        return False
    if _is_ip(name) or name == "localhost" or name.endswith(_OWN_SUFFIXES):
        return True
    names = _names(config.load_config() if cfg is None else cfg)
    return "*" in names or name in names


class HostCheck:
    """ASGI middleware: refuses an unexpected `Host` before any route, body or authentication."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        host = next((v.decode("latin-1") for k, v in scope.get("headers") or [] if k == b"host"), None)
        if allowed(host):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        name = hostname(host or "")[:100]
        return await JSONResponse(status_code=421, content={
            "error": "bad_host",
            "message": f"This server does not answer to the name {name!r}. Open it at its own address (127.0.0.1, "
                       "localhost, its Tailscale or .local name, or its public URL), or add the name: pilot init --public-url https://<name>, "
                       "or allowed_hosts in config.json, or MAXXING_ALLOWED_HOSTS."})(scope, receive, send)
