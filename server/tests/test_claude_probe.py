"""A connection test cannot load workspace context, use tools, persist a chat or expire a valid sign-in."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from maxxing import claude_auth, claude_probe, cmd_core, config
from maxxing.api import claude


def test_probe_isolated_from_workspace_tools_and_personal_settings(mx):
    config.set_secret("anthropic_api_key", "sk-test-connection")
    (mx["ws"] / "CLAUDE.md").write_text("Personal instructions must not be in a connection probe.")
    result = claude.run_test()
    assert result["ok"] is True and claude_auth.status()["ok"] is True
    calls = [json.loads(line) for line in (mx["fake_dir"] / "calls.jsonl").read_text().splitlines()]
    call = next(c for c in calls if "-p" in c["argv"])
    argv = call["argv"]
    for flag, value in (("--tools", ""), ("--mcp-config", '{"mcpServers":{}}'), ("--setting-sources", "")):
        assert argv[argv.index(flag) + 1] == value
    assert {"--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"} <= set(argv)
    assert "--bare" not in argv                         # must retain OAuth / Keychain support
    assert not Path(call["cwd"]).is_relative_to(mx["state"])
    assert not Path(call["cwd"]).is_relative_to(mx["ws"])
    assert not Path(call["cwd"]).exists()               # scratch context removed after the call
    assert not list((mx["state"] / "sessions").glob("*.json"))


@pytest.mark.parametrize("error", ["Prompt is too long (314411 tokens)", "Rate limit exceeded", "Network timeout"])
def test_explicit_test_error_preserves_last_verified_sign_in(client, monkeypatch, error):
    config.set_secret("anthropic_api_key", "sk-test-connection")
    claude_auth.record(True, source="turn")
    before = claude_auth.last()
    monkeypatch.setattr(claude_probe, "run", lambda *a: {"ok": False, "model": "haiku", "ms": 3, "error": error})
    assert client.post("/api/claude/test").json() == {"ok": False, "model": "haiku", "ms": 3, "error": error}
    assert claude_auth.last() == before
    assert client.get("/api/claude/status").json()["auth"]["ok"] is True


def test_explicit_authentication_error_still_disconnects(client, monkeypatch):
    config.set_secret("anthropic_api_key", "sk-test-connection")
    error = "Invalid API key"
    monkeypatch.setattr(claude_probe, "run", lambda *a: {"ok": False, "model": "haiku", "ms": 3, "error": error})
    assert client.post("/api/claude/test").json()["ok"] is False
    status = client.get("/api/claude/status").json()["auth"]
    assert status["ok"] is False and status["error"] == error


def test_new_credential_does_not_inherit_the_previous_credentials_auth_failure(client, monkeypatch):
    config.set_secret("anthropic_api_key", "sk-test-old-credential")
    claude_auth.record(False, "Invalid API key", source="test")
    monkeypatch.setattr(claude_probe, "run", lambda *a: {"ok": False, "model": "haiku", "ms": 3, "error": "Network timeout"})
    result = client.post("/api/claude/auth", json={"kind": "api_key", "value": "sk-test-new-credential"}).json()
    assert result == {"ok": False, "error": "Network timeout"}
    status = client.get("/api/claude/status").json()["auth"]
    assert status["ok"] is True and status["checked_at"] is None and status["error"] is None


def test_old_context_error_is_not_an_expired_sign_in(mx):
    config.set_secret("anthropic_api_key", "sk-test-connection")
    claude_auth.record(False, "Prompt is too long", source="test")
    assert claude_auth.status()["ok"] is True
    assert claude_auth.status()["checked_at"] is None
    assert claude_auth.needs_check()


@pytest.mark.parametrize("stdout,code", [
    ("", 0), ("invalid JSON", 0), ("[]", 0), ('{"result":""}', 0), ('{"result":"ok","is_error":true}', 0),
    ('{"result":"ok","subtype":"error_during_execution"}', 0), ('{"result":"ok"}', 1),
    ('{"result":"Invalid API key · Please run /login"}', 0)])
def test_invalid_answer_is_not_a_success(mx, monkeypatch, stdout, code):
    monkeypatch.setattr(claude_probe.subprocess, "run", lambda *a, **kw: SimpleNamespace(stdout=stdout, stderr="", returncode=code))
    result = claude_probe.run()
    assert not result["ok"] and result["error"]


@pytest.mark.parametrize("answer", ["ok", "OK.", "ok!", " Ok \n", "OK, ready."])
def test_any_answer_of_a_successful_call_is_a_success(mx, monkeypatch, answer):
    """The probe tests the sign-in, not how the model words its reply: "OK." must not fail Test or doctor --live."""
    config.set_secret("anthropic_api_key", "sk-test-connection")
    stdout = json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": answer,
                         "modelUsage": {"claude-haiku-4-5-20251001": {}}})
    monkeypatch.setattr(claude_probe.subprocess, "run", lambda *a, **kw: SimpleNamespace(stdout=stdout, stderr="", returncode=0))
    result = claude_probe.run()
    assert result["ok"] is True and "error" not in result
    assert cmd_core.check_claude_auth(live=True)["level"] == "ok"


@pytest.mark.parametrize("missing", ["claude-not-installed-here", "/nonexistent/bin/claude"])
def test_missing_cli_is_reported_as_not_installed(client, mx, monkeypatch, missing):
    config.set_secret("anthropic_api_key", "sk-test-connection")
    monkeypatch.setenv("MAXXING_CLAUDE_BIN", missing)
    monkeypatch.setattr(claude_probe.subprocess, "run", lambda *a, **kw: pytest.fail("no call without Claude Code"))
    result = client.post("/api/claude/test").json()
    assert result["ok"] is False and result["error"] == "Claude Code is not installed"
    assert claude_auth.last() == {}                      # not a sign-in result
    doctor = cmd_core.check_claude_auth(live=True)
    assert doctor["level"] == "fail" and doctor["title"].startswith("Claude Code is not installed")
    assert "Errno" not in json.dumps(doctor)


def test_probe_timeout_cleans_up_its_scratch_folder(mx, monkeypatch):
    seen = []
    def timeout(args, **kwargs):
        seen.append(Path(kwargs["cwd"]))
        assert seen[-1].is_dir()
        raise subprocess.TimeoutExpired(args, 1)
    monkeypatch.setattr(claude_probe.subprocess, "run", timeout)
    assert claude_probe.run(timeout_s=1)["error"] == "No answer within 1 s"
    assert not seen[0].exists()


def test_doctor_live_uses_the_same_bounded_probe(mx):
    config.set_secret("anthropic_api_key", "sk-test-connection")
    result = cmd_core.check_claude_auth(live=True)
    assert result["level"] == "ok" and "live test" in result["title"]
    assert claude_auth.last()["source"] == "check"
    calls = (mx["fake_dir"] / "calls.jsonl").read_text()
    assert "--strict-mcp-config" in calls and "--no-session-persistence" in calls


def test_doctor_and_web_detect_mac_keychain_without_exposing_credentials(mx, monkeypatch):
    monkeypatch.setattr(claude_auth.sys, "platform", "darwin")
    monkeypatch.setenv("HOME", str(mx["tmp"] / "home"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)   # else claude_dir() is the caller's, not HOME's
    monkeypatch.setattr(claude_auth, "_mac_status_cache", {})
    def cli(args, **kwargs):
        assert args[1:] == ["auth", "status", "--json"]
        return SimpleNamespace(returncode=0, stdout='{"loggedIn":true,"email":"private@example.com"}')
    monkeypatch.setattr(claude_auth.subprocess, "run", cli)
    assert cmd_core.claude_auth() == claude_auth.auth_method()
    st = claude_auth.status()
    assert st["ok"] and st["method"] == "credentials"
    assert "private@example.com" not in json.dumps(st)
    assert cmd_core.check_claude_auth()["level"] == "ok"


def test_environment_credentials_are_shared_with_web_detection(mx, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "test-oauth")
    assert cmd_core.claude_auth()[0] == claude_auth.status()["method"] == "oauth_token"
