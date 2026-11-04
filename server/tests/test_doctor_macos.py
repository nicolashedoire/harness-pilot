"""macOS doctor checks are read-only; unknown listeners and unsafe tools must not get a clean bill of health."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from maxxing import cmd_core, local_service


@pytest.fixture
def mac(mx, monkeypatch):
    monkeypatch.setattr(cmd_core.sys, "platform", "darwin")
    monkeypatch.setenv("HARNESS_PILOT_LOCAL_MODE", "1")
    return mx


@pytest.mark.parametrize("address,expected", [("127.0.0.1", "ok"), ("[::1]", "ok"), ("*", "fail"), ("0.0.0.0", "fail"), ("[::]", "fail")])
def test_mac_listener_inspection_detects_public_and_loopback_bindings(mac, monkeypatch, address, expected):
    def lsof(args, **kwargs):
        assert args == ["lsof", "-nP", "-a", "-iTCP:8809", "-sTCP:LISTEN", "-Fn"]
        return 0, f"p123\nn{address}:8809\n"
    monkeypatch.setattr(cmd_core, "run", lsof)
    result = cmd_core.check_bind({"bind": "127.0.0.1", "port": 8809})
    assert result["level"] == expected
    assert "nothing listening" not in result["detail"]
    if expected == "fail":
        assert "lsof" in result["fix"] and "ss -" not in result["fix"]


@pytest.mark.parametrize("response", [(127, "lsof missing"), (1, "permission denied"), (0, "nunknown:8809"), (0, "p123")])
def test_failed_listener_inspection_is_not_reported_as_no_listener(mac, monkeypatch, response):
    monkeypatch.setattr(cmd_core, "run", lambda *a, **kw: response)
    result = cmd_core.check_bind({"bind": "127.0.0.1", "port": 8809})
    assert result["level"] == "warn" and "unknown" in result["detail"]


def test_no_mac_listener_is_distinguished_from_failed_inspection(mac, monkeypatch):
    monkeypatch.setattr(cmd_core, "run", lambda *a, **kw: (1, ""))
    assert cmd_core._listen_addrs(8809) == []


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


@pytest.mark.parametrize("mode", [0o777, 0o775])
def test_mac_local_tools_still_reject_writable_code_and_directories(mac, monkeypatch, mode):
    tool = _tools(mac, monkeypatch)
    tool.parent.chmod(mode)
    assert cmd_core.check_managed_deps()["level"] == "fail"


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
