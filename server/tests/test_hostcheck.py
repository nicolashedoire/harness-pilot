"""DNS rebinding: requests whose Host is not one of this server's names are refused before any route."""
from __future__ import annotations

import pytest

from maxxing import config, hostcheck


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.1:8787", "[::1]:8787", "::1", "100.101.102.103:8787",
                                  "192.168.1.20", "localhost", "LOCALHOST:5173", "localhost.", "app.localhost:8801",
                                  "box.tailnet-abcd.ts.net", "Box.Tailnet-ABCD.TS.NET.:8787", "macbook.local", "MacBook.Local.:8787"])
def test_addresses_and_loopback_names_are_always_served(host, monkeypatch):
    monkeypatch.delenv("MAXXING_ALLOWED_HOSTS", raising=False)
    assert hostcheck.allowed(host, {})


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8787", "127.0.0.1.evil.example", "localhost.evil.example",
                                  "ui.example.com.evil.example", "0x7f.1", "", "ts.net.evil.example", "local.evil.example",
                                  "evil-ts.net", "evillocal", "box.ts.network", "box.locals"])
def test_other_names_are_refused(host, monkeypatch):
    monkeypatch.delenv("MAXXING_ALLOWED_HOSTS", raising=False)
    assert not hostcheck.allowed(host, {"public_url": "https://ui.example.com", "bind": "127.0.0.1"})


def test_the_configured_names_are_served(monkeypatch):
    monkeypatch.delenv("MAXXING_ALLOWED_HOSTS", raising=False)
    cfg = {"public_url": "https://UI.example.com/", "bind": "box.tailnet.example", "allowed_hosts": ["Proxy.example:443"]}
    for host in ("ui.example.com", "ui.example.com:443", "UI.EXAMPLE.COM.", "box.tailnet.example:8787", "proxy.example"):
        assert hostcheck.allowed(host, cfg), host
    assert not hostcheck.allowed("other.example", cfg)
    assert hostcheck.allowed("tunnel.example", {"allowed_hosts": "tunnel.example"})      # one name written as a string
    monkeypatch.setenv("MAXXING_ALLOWED_HOSTS", "a.example, b.example")
    assert hostcheck.allowed("b.example", {}) and not hostcheck.allowed("c.example", {})
    monkeypatch.setenv("MAXXING_ALLOWED_HOSTS", "*")                                    # the check turned off
    assert hostcheck.allowed("anything.example", {})
    assert hostcheck.allowed(None, {})                                                  # no Host header


def test_the_server_answers_421_to_another_name(client, mx, monkeypatch):
    monkeypatch.setenv("MAXXING_ALLOWED_HOSTS", "testserver")
    for path in ("/api/auth/state", "/", "/settings"):
        r = client.get(path, headers={"Host": "evil.example"})
        assert r.status_code == 421 and r.json()["error"] == "bad_host", path
        assert r.headers["x-frame-options"] == "SAMEORIGIN"                             # still the security headers
    r = client.post("/api/auth/login", json={"password": "correct horse battery"}, headers={"Host": "evil.example:8787"})
    assert r.status_code == 421 and "set-cookie" not in r.headers                      # no sign-in, no throttle entry
    for host in ("127.0.0.1:8787", "localhost:5173", "[::1]:8787", "100.64.0.7:8787"):
        assert client.get("/api/auth/state", headers={"Host": host}).status_code == 200, host
    assert client.get("/api/auth/state", headers={"Host": "ui.example.com"}).status_code == 421
    config.update_config(public_url="https://ui.example.com")                           # read on every request
    assert client.get("/api/auth/state", headers={"Host": "ui.example.com"}).status_code == 200
    assert client.get("/api/settings", headers={"Host": "ui.example.com"}).status_code == 200   # signed in, Caddy in front


def test_a_websocket_under_another_name_is_closed_before_it_is_accepted(client, monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    monkeypatch.setenv("MAXXING_ALLOWED_HOSTS", "testserver")
    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect("/api/pc/ws", headers={"Host": "evil.example"}):
            pass
    assert e.value.code == 1008
