"""Settings -> System, local mode on macOS: the optional launchd agent of scripts/macos-service.sh, read-only
(maxxing/local_service.py, GET /api/system/local-service). Every plist here is a fake in a temporary LaunchAgents
folder (conftest: MAXXING_LAUNCH_AGENTS_DIR); nothing is loaded and launchctl is never called."""
from __future__ import annotations

import plistlib
import shlex
import subprocess
from pathlib import Path

import pytest

from maxxing import config, local_service


@pytest.fixture
def mac(mx, monkeypatch) -> dict:
    """A local installation on macOS: the local dir is the parent of the state dir, as dev-local.sh sets it."""
    monkeypatch.setenv("HARNESS_PILOT_LOCAL_MODE", "1")
    monkeypatch.setattr(local_service, "is_mac", lambda: True)
    for var in ("XPC_SERVICE_NAME", "HARNESS_PILOT_SERVICE_LABEL", "HARNESS_PILOT_LOCAL_DIR"):
        monkeypatch.delenv(var, raising=False)
    agents = local_service.agents_dir()
    agents.mkdir(parents=True, exist_ok=True)
    return {"agents": agents, "local": config.STATE.parent}


def write_agent(agents: Path, label: str, local: Path, script: Path | None = None) -> Path:
    """The plist macos-service.sh writes (the fields the status reads)."""
    path = agents / f"{label}.plist"
    path.write_bytes(plistlib.dumps({
        "Label": label,
        "ProgramArguments": ["/bin/bash", str(script or config.CODE / "scripts" / "dev-local.sh")],
        "WorkingDirectory": str(config.CODE),
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin", "HARNESS_PILOT_LOCAL_DIR": str(local), "HARNESS_PILOT_PORT": "8787"},
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "StandardOutPath": str(local / "logs" / "server.log"),
        "StandardErrorPath": str(local / "logs" / "server.err.log"),
    }))
    return path


def test_the_tests_never_read_the_real_launch_agents():
    assert local_service.agents_dir() != Path.home() / "Library" / "LaunchAgents"


def test_hidden_outside_local_mode_and_outside_macos(mx, monkeypatch):
    monkeypatch.delenv("HARNESS_PILOT_LOCAL_MODE", raising=False)
    monkeypatch.setattr(local_service, "is_mac", lambda: True)
    assert local_service.status() == {"supported": False}
    monkeypatch.setenv("HARNESS_PILOT_LOCAL_MODE", "1")
    monkeypatch.setattr(local_service, "is_mac", lambda: False)
    assert local_service.status() == {"supported": False}


def test_not_installed_gives_the_install_command(mac):
    st = local_service.status()
    assert st["supported"] is True and st["installed"] is False and st["running"] is False and st["since"] is None
    assert st["label"] == "local.harness-pilot"
    assert st["plist"] == str(mac["agents"] / "local.harness-pilot.plist")
    assert st["logs"] == str(mac["local"] / "logs")
    assert st["url"] == "http://127.0.0.1:8787"
    script = shlex.quote(str(config.CODE / "scripts" / "dev-local.sh"))
    # the test state dir is not <repo>/.harness-pilot-local: the command names it, as dev-local.sh reads it
    assert st["commands"]["install"] == f"HARNESS_PILOT_LOCAL_DIR={shlex.quote(str(mac['local']))} bash {script} service install"
    assert st["commands"]["update"] == f"git -C {shlex.quote(str(config.CODE))} pull"


def test_installed_and_this_server_runs_as_it(mac, monkeypatch):
    write_agent(mac["agents"], "local.harness-pilot", mac["local"])
    monkeypatch.setenv("XPC_SERVICE_NAME", "local.harness-pilot")    # launchd names the job of what it starts
    st = local_service.status()
    assert st["installed"] is True and st["running"] is True
    assert st["since"] == local_service.STARTED
    assert st["logs"] == str(mac["local"] / "logs")


def test_installed_but_this_server_was_started_from_a_terminal(mac, monkeypatch):
    write_agent(mac["agents"], "local.harness-pilot", mac["local"])
    monkeypatch.setenv("XPC_SERVICE_NAME", "application.com.apple.Terminal.1.2")
    st = local_service.status()
    assert st["installed"] is True and st["running"] is False and st["since"] is None


def test_a_custom_label_is_found_from_the_launchd_job_and_named_in_the_commands(mac, monkeypatch):
    write_agent(mac["agents"], "dev.acme.pilot", mac["local"])
    monkeypatch.setenv("XPC_SERVICE_NAME", "dev.acme.pilot")
    config.update_config(port=8790)
    st = local_service.status()
    assert st["installed"] is True and st["running"] is True and st["label"] == "dev.acme.pilot"
    assert st["url"] == "http://127.0.0.1:8790"
    assert st["commands"]["restart"].startswith("HARNESS_PILOT_SERVICE_LABEL=dev.acme.pilot HARNESS_PILOT_PORT=8790 ")
    assert st["commands"]["restart"].endswith(" service restart")


def test_the_service_of_another_clone_or_instance_is_not_this_one(mac, tmp_path):
    write_agent(mac["agents"], "local.harness-pilot", mac["local"], script=tmp_path / "other-clone" / "scripts" / "dev-local.sh")
    assert local_service.status()["installed"] is False
    write_agent(mac["agents"], "local.harness-pilot", tmp_path / "other-local-dir")
    assert local_service.status()["installed"] is False


def test_a_broken_plist_or_a_bad_label_is_ignored(mac, monkeypatch):
    (mac["agents"] / "local.harness-pilot.plist").write_text("<plist><dict><key>Label")
    monkeypatch.setenv("XPC_SERVICE_NAME", "../../etc/passwd")
    st = local_service.status()
    assert st["installed"] is False and st["label"] == "local.harness-pilot"


def test_launchctl_is_never_called(mac, monkeypatch):
    write_agent(mac["agents"], "local.harness-pilot", mac["local"])

    def refuse(*a, **k):
        raise AssertionError(f"no command may run: {a}")
    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(subprocess, "Popen", refuse)
    assert local_service.status()["installed"] is True


def test_route_needs_sign_in_and_has_no_action(client, mac, monkeypatch):
    write_agent(mac["agents"], "local.harness-pilot", mac["local"])
    monkeypatch.setenv("XPC_SERVICE_NAME", "local.harness-pilot")
    r = client.get("/api/system/local-service")
    assert r.status_code == 200 and r.json()["running"] is True
    for action in ("install", "restart", "stop", "uninstall"):
        assert client.post(f"/api/system/local-service/{action}").status_code in (404, 405)
    client.cookies.clear()
    assert client.get("/api/system/local-service").status_code == 401
