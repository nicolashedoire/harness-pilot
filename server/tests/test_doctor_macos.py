"""macOS doctor checks are read-only; unknown listeners and unsafe tools must not get a clean bill of health."""
from __future__ import annotations

import os
import shutil
import socket
import stat
import sys
from pathlib import Path

import pytest

from maxxing import cmd_core, local_service

REAL_MAC = sys.platform == "darwin" and shutil.which("lsof")    # read before `mac` patches sys.platform
LSOF = ["lsof", "-w", "-nP", "-a", "-iTCP:8809", "-sTCP:LISTEN", "-Ftn"]


@pytest.fixture
def mac(mx, monkeypatch):
    monkeypatch.setattr(cmd_core.sys, "platform", "darwin")
    monkeypatch.setenv("HARNESS_PILOT_LOCAL_MODE", "1")
    return mx


@pytest.mark.parametrize("family,address,expected", [
    ("IPv4", "127.0.0.1", "ok"), ("IPv6", "[::1]", "ok"), ("IPv4", "*", "fail"), ("IPv4", "0.0.0.0", "fail"),
    ("IPv6", "[::]", "fail"), ("IPv6", "*", "fail"), ("", "*", "fail")])
def test_mac_listener_inspection_detects_public_and_loopback_bindings(mac, monkeypatch, family, address, expected):
    def lsof(args, **kwargs):
        assert args == LSOF
        return 0, f"p123\nf5\nt{family}\nn{address}:8809\n"
    monkeypatch.setattr(cmd_core, "run", lsof)
    result = cmd_core.check_bind({"bind": "127.0.0.1", "port": 8809})
    assert result["level"] == expected
    assert "nothing listening" not in result["detail"]
    if expected == "fail":
        assert "lsof" in result["fix"] and "ss -" not in result["fix"]


def test_mac_ipv6_wildcard_is_not_reported_as_ipv4(mac, monkeypatch):
    """lsof writes `*` for both wildcards: the socket type says which one listens."""
    out = "p123\nf3\ntIPv6\nn*:8809\nf4\ntIPv4\nn127.0.0.1:8809\n"
    monkeypatch.setattr(cmd_core, "run", lambda *a, **kw: (0, out))
    assert cmd_core._listen_addrs(8809) == ["::", "127.0.0.1"]
    result = cmd_core.check_bind({"bind": "127.0.0.1", "port": 8809})
    assert result["level"] == "fail" and result["title"] == "port 8809 is listening on [::]"
    monkeypatch.setattr(cmd_core, "run", lambda *a, **kw: (0, "p123\nf3\ntIPv6\nn[::1]:8809\n"))
    assert cmd_core.check_bind({"bind": "127.0.0.1", "port": 8809})["detail"] == "[::1]"


@pytest.mark.parametrize("response", [(127, "lsof missing"), (1, "permission denied"), (0, "nunknown:8809"), (0, "p123")])
def test_failed_listener_inspection_is_not_reported_as_no_listener(mac, monkeypatch, response):
    monkeypatch.setattr(cmd_core, "run", lambda *a, **kw: response)
    result = cmd_core.check_bind({"bind": "127.0.0.1", "port": 8809})
    assert result["level"] == "warn" and "unknown" in result["detail"]


def test_no_mac_listener_is_distinguished_from_failed_inspection(mac, monkeypatch):
    """`-w`: lsof's warnings (a stale network mount) would land in the output and turn its exit 1 into a failure."""
    def nothing(args, **kwargs):
        assert args == LSOF
        return 1, ""
    monkeypatch.setattr(cmd_core, "run", nothing)
    assert cmd_core._listen_addrs(8809) == []
    assert cmd_core.check_bind({"bind": "127.0.0.1", "port": 8809})["level"] == "ok"


@pytest.mark.skipif(not REAL_MAC, reason="real lsof on macOS")
def test_real_lsof_output_is_parsed(mac):
    """Listeners this test opens on a free port: an IPv6 wildcard and IPv4 loopback, then none."""
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as v6, \
            socket.socket(socket.AF_INET, socket.SOCK_STREAM) as v4:
        v6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        v6.bind(("::", 0))
        port = v6.getsockname()[1]
        v4.bind(("127.0.0.1", port))
        v6.listen()
        v4.listen()
        assert sorted(cmd_core._listen_addrs(port)) == ["127.0.0.1", "::"]
        result = cmd_core.check_bind({"bind": "127.0.0.1", "port": port})
        assert result["level"] == "fail" and result["title"] == f"port {port} is listening on [::]"
    assert cmd_core._listen_addrs(port) == []


def test_mac_service_and_security_checks_do_not_run_linux_commands(mac, monkeypatch):
    def forbidden(*a, **kw):
        pytest.fail("Linux service/security command called on macOS")
    monkeypatch.setattr(cmd_core, "systemctl", forbidden)
    monkeypatch.setattr(cmd_core, "_run_ok", forbidden)
    monkeypatch.setattr(local_service, "status", lambda: {"supported": True, "installed": False,
                                                          "commands": {"install": "bash scripts/dev-local.sh service install"}})
    service = cmd_core.check_service()
    assert service["level"] == "info" and "terminal" in service["title"]
    assert "optional" in service["fix"]
    assert cmd_core.check_security()["level"] == "info"


def test_configured_launchd_service_is_not_claimed_stopped_from_another_terminal(mac, monkeypatch):
    monkeypatch.setattr(local_service, "status", lambda: {"supported": True, "installed": True,
                        "running": False, "plist": "/test/local.pilot.plist", "commands": {"status": "service status"}})
    result = cmd_core.check_service()
    assert result["level"] == "info" and "configured" in result["title"]
    assert result["fix"] == "service status"


def _tools(mac, monkeypatch):
    tool = mac["tmp"] / "bin" / "claude"
    tool.parent.mkdir()
    tool.write_text("#!/bin/sh\nexit 0\n")
    tool.chmod(0o755)
    monkeypatch.setattr(cmd_core, "claude_bin", lambda: str(tool))
    monkeypatch.setattr(cmd_core, "uv_bin", lambda: None)
    monkeypatch.setattr(cmd_core.shutil, "which", lambda *a, **kw: None)
    return tool


def test_mac_local_tools_need_not_be_owned_by_root(mac, monkeypatch):
    _tools(mac, monkeypatch)
    result = cmd_core.check_managed_deps()
    assert result["level"] == "info" and "Linux package pins do not apply" in result["detail"]


def _with_group(monkeypatch, gid, *paths):
    """`paths` (folders) reported with group `gid`, whatever path names them; no real chgrp."""
    real_stat, wanted = Path.lstat, {p.resolve() for p in paths}
    def lstat(path):
        st = real_stat(path)
        if not stat.S_ISLNK(st.st_mode) and path.resolve() in wanted:
            fields = list(st)
            fields[5] = gid
            return os.stat_result(fields)
        return st
    monkeypatch.setattr(Path, "lstat", lstat)


@pytest.mark.parametrize("mode,gid,expected", [
    (0o777, 20, "fail"), (0o777, cmd_core.MAC_ADMIN_GID, "fail"),       # writable by everyone: always unsafe
    (0o775, 20, "warn"),                                                # writable by another group (staff)
    (0o775, cmd_core.MAC_ADMIN_GID, "info")])                           # admin: Homebrew's layout
def test_mac_local_tools_writable_code_and_directories(mac, monkeypatch, mode, gid, expected):
    tool = _tools(mac, monkeypatch)
    tool.parent.chmod(mode)
    _with_group(monkeypatch, gid, tool.parent)
    result = cmd_core.check_managed_deps()
    assert result["level"] == expected
    if expected == "warn":
        assert str(tool.parent) in result["detail"] and "g-w" in result["fix"]


def test_mac_homebrew_layout_is_a_healthy_install(mac, monkeypatch):
    """Homebrew's bin and Cellar are drwxrwxr-x <user>:admin; its commands are links into the Cellar."""
    brew = mac["tmp"] / "homebrew"
    real = brew / "Cellar" / "claude" / "1.0" / "bin" / "claude"
    real.parent.mkdir(parents=True)
    real.write_text("#!/bin/sh\nexit 0\n")
    real.chmod(0o755)
    (brew / "bin").mkdir()
    link = brew / "bin" / "claude"
    link.symlink_to("../Cellar/claude/1.0/bin/claude")
    for folder in (brew / "bin", brew / "Cellar"):
        folder.chmod(0o775)
    _with_group(monkeypatch, cmd_core.MAC_ADMIN_GID, brew / "bin", brew / "Cellar")
    monkeypatch.setattr(cmd_core, "claude_bin", lambda: str(link))
    monkeypatch.setattr(cmd_core, "uv_bin", lambda: None)
    monkeypatch.setattr(cmd_core.shutil, "which", lambda *a, **kw: None)
    result = cmd_core.check_managed_deps()
    assert result["level"] == "info", result


def test_mac_local_tools_check_symlink_targets(mac, monkeypatch):
    tool = _tools(mac, monkeypatch)
    target = tool.with_name("real-claude")
    tool.rename(target)
    tool.symlink_to(target)
    target.chmod(0o777)
    assert cmd_core.check_managed_deps()["level"] == "fail"


def test_mac_local_tools_reject_foreign_ownership(mac, monkeypatch):
    tool = _tools(mac, monkeypatch)
    real_stat = Path.lstat
    def foreign(path):
        st = real_stat(path)
        if path == tool:
            fields = list(st)
            fields[4] = 987654                         # simulate another account, no real chown
            return os.stat_result(fields)
        return st
    monkeypatch.setattr(Path, "lstat", foreign)
    assert cmd_core.check_managed_deps()["level"] == "fail"


def test_linux_hardening_checks_still_run(mac, monkeypatch):
    monkeypatch.setattr(cmd_core.sys, "platform", "linux")
    calls = []
    def missing(args):
        calls.append(args)
        return False, ""
    monkeypatch.setattr(cmd_core, "_run_ok", missing)
    result = cmd_core.check_security()
    assert result["level"] == "warn"
    assert ["ufw", "status"] in calls
    assert ["systemctl", "is-enabled", "--quiet", "unattended-upgrades"] in calls


def test_linux_component_verification_is_not_bypassed_by_local_mode(mac, monkeypatch):
    from maxxing import deps
    monkeypatch.setattr(cmd_core.sys, "platform", "linux")
    monkeypatch.setattr(deps, "status", lambda: [])
    monkeypatch.setattr(deps, "verify", lambda **kw: [{"name": "claude", "level": "fail", "text": "unsafe owner"}])
    assert cmd_core.check_managed_deps()["level"] == "fail"
