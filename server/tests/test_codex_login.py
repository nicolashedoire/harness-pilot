"""Signing Codex in from the web app (maxxing/codex_login.py, /api/system/codex/login and /auth) against a fake `codex`
command: the device-code flow (page, code, wait, cancel, failure, expiry), the API key on stdin, sign-out. No network,
no real Codex folder: the fake keeps its "signed in" state in the test's temporary folder."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from conftest import wait_for
from maxxing import codex_login
from maxxing.sessions import codex

FAKE_CODE = "ABCD-EFGHI"          # made-up, shaped like the CLI's codes
FAKE = r'''#!/usr/bin/env python3
# fake Codex CLI: `login status`, `login --device-auth`, `login --with-api-key`, `logout` (FAKE_CODEX_DIR holds its state)
import json, os, sys, time
d = os.environ["FAKE_CODEX_DIR"]
os.makedirs(d, exist_ok=True)
args, rest = sys.argv[1:], []
i = 0
while i < len(args):
    if args[i] == "-c":
        i += 2
        continue
    rest.append(args[i]); i += 1
with open(os.path.join(d, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "pid": os.getpid()}) + "\n")
auth = os.path.join(d, "auth")
def done(path):
    return os.path.exists(os.path.join(d, path))
if rest == ["login", "status"]:
    if os.path.exists(auth):
        method = open(auth).read()
        sys.stderr.write("Logged in using ChatGPT\n" if method == "chatgpt" else "Logged in using an API key - sk-fake***9999\n")
        sys.exit(0)
    sys.stderr.write("Not logged in\n"); sys.exit(1)
if rest == ["logout"]:
    if os.path.exists(auth):
        os.remove(auth); print("Successfully logged out"); sys.exit(0)
    print("Not logged in"); sys.exit(1)
if rest == ["login", "--with-api-key"]:
    print("Reading API key from stdin...")
    key = sys.stdin.read().strip()
    open(os.path.join(d, "stdin"), "w").write(key)
    if key.startswith("sk-refused"):
        sys.stderr.write("Error: the key " + key + " was refused\n"); sys.exit(1)
    open(auth, "w").write("api_key"); print("Successfully logged in"); sys.exit(0)
if rest == ["login", "--device-auth"]:
    mode = os.environ.get("FAKE_CODEX_DEVICE", "ok")
    open(os.path.join(d, "device.pid"), "w").write(str(os.getpid()))
    print("\nWelcome to Codex [v\x1b[90m0.150.1\x1b[0m]\n")
    if mode == "silent":
        time.sleep(60); sys.exit(1)
    if mode == "offline":
        print("Error: failed to request a device code: network unreachable", flush=True); sys.exit(1)
    print("Follow these steps to sign in with ChatGPT using device code authorization:\n")
    print("1. Open this link in your browser and sign in to your account")
    print("   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n")
    expiry = "" if mode == "noexpiry" else " \x1b[90m(expires in 15 minutes)\x1b[0m"
    print("2. Enter this one-time code" + expiry)
    print("   \x1b[94m" + "ABCD-EFGHI" + "\x1b[0m\n")
    print("\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\n", flush=True)
    while not (done("go") or done("refuse")):
        time.sleep(0.05)
    if done("refuse"):
        sys.stderr.write("Error: device code ABCD-EFGHI was rejected\n"); sys.exit(1)
    open(auth, "w").write("chatgpt"); print("Successfully logged in"); sys.exit(0)
sys.exit(2)
'''


@pytest.fixture
def fake(mx, monkeypatch) -> Path:
    """The fake `codex` for every call of the server; returns its state folder."""
    state = mx["tmp"] / "fake-codex"
    binary = mx["tmp"] / "codex"
    binary.write_text(FAKE)
    binary.chmod(0o755)
    monkeypatch.setenv("MAXXING_CODEX_BIN", str(binary))
    monkeypatch.setenv("FAKE_CODEX_DIR", str(state))
    yield state
    codex_login.cancel()
    codex_login._flow = None                                                         # noqa: SLF001


def _calls(state: Path, *words: str) -> list[dict]:
    calls = [json.loads(line) for line in (state / "calls.jsonl").read_text().splitlines()]
    return [c for c in calls if all(w in c["argv"] for w in words)]


def _alive(pid: int) -> bool:
    """The server reaps the CLI it stops (`_kill` waits for it), so a stopped one is gone, not a zombie."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_device_code_flow_shows_the_page_and_code_then_signs_in(client, fake):
    before = time.time()
    r = client.post("/api/system/codex/login")
    assert r.status_code == 200, r.text
    flow = r.json()
    assert flow["state"] == "waiting" and flow["url"] == "https://auth.openai.com/codex/device"
    assert flow["code"] == FAKE_CODE and flow["error"] is None
    assert before + 15 * 60 - 5 <= flow["expires_at"] <= time.time() + 15 * 60 + 5     # "expires in 15 minutes"
    assert client.get("/api/system/codex/login").json() == flow
    # a second start (another tab) joins the running flow: one CLI process
    assert client.post("/api/system/codex/login").json()["code"] == FAKE_CODE
    assert len(_calls(fake, "--device-auth")) == 1
    argv = _calls(fake, "--device-auth")[0]["argv"]
    assert argv[-2:] == ["login", "--device-auth"] and "analytics.enabled=false" in argv
    assert client.get("/api/system/codex").json()["authenticated"] is False
    (fake / "go").touch()                                     # the user entered the code in the browser
    done = wait_for(lambda: (s := client.get("/api/system/codex/login").json())["state"] == "succeeded" and s)
    assert done["code"] is None and done["url"] is None and done["error"] is None
    assert client.get("/api/system/codex").json() == {"installed": True, "authenticated": True, "reason": None,
                                                      "method": "chatgpt"}
    # a new start after the end is a new flow
    assert client.post("/api/system/codex/login").json()["state"] == "waiting"
    assert len(_calls(fake, "--device-auth")) == 2


def test_cancel_stops_the_cli(client, fake):
    assert client.post("/api/system/codex/login").json()["state"] == "waiting"
    pid = int((fake / "device.pid").read_text())
    r = client.delete("/api/system/codex/login")
    assert r.status_code == 200 and r.json()["state"] == "cancelled" and r.json()["code"] is None
    wait_for(lambda: not _alive(pid))
    time.sleep(0.2)                                           # the killed CLI's exit does not turn it into "failed"
    assert client.get("/api/system/codex/login").json()["state"] == "cancelled"
    assert client.get("/api/system/codex").json()["authenticated"] is False
    assert client.delete("/api/system/codex/login").json()["state"] == "cancelled"    # nothing left to stop


def test_errors_are_shown_with_the_code_masked(client, fake, monkeypatch):
    assert client.post("/api/system/codex/login").json()["state"] == "waiting"
    (fake / "refuse").touch()
    failed = wait_for(lambda: (s := client.get("/api/system/codex/login").json())["state"] == "failed" and s)
    assert failed["error"] == "Error: device code ••• was rejected" and FAKE_CODE not in json.dumps(failed)
    # the CLI stops before giving a code (no network): its last line
    (fake / "refuse").unlink()
    monkeypatch.setenv("FAKE_CODEX_DEVICE", "offline")
    r = client.post("/api/system/codex/login").json()
    assert r["state"] == "failed" and r["error"] == "Error: failed to request a device code: network unreachable"


def test_a_cli_that_shows_no_code_or_outlives_it_is_stopped(client, fake, monkeypatch):
    monkeypatch.setattr(codex_login, "SHOW_TIMEOUT_S", 0.5)
    monkeypatch.setattr(codex_login, "START_WAIT_S", 0.2)
    monkeypatch.setenv("FAKE_CODEX_DEVICE", "silent")
    assert client.post("/api/system/codex/login").json()["state"] == "starting"
    pid = int(wait_for(lambda: (fake / "device.pid").is_file() and (fake / "device.pid").read_text()))
    failed = wait_for(lambda: (s := client.get("/api/system/codex/login").json())["state"] == "failed" and s)
    assert failed["error"] == "Codex did not show a sign-in code"
    wait_for(lambda: not _alive(pid))
    # a code without a stated lifetime lasts DEFAULT_TTL_S, then the flow expires and the CLI is stopped
    monkeypatch.setattr(codex_login, "START_WAIT_S", 20)
    monkeypatch.setattr(codex_login, "DEFAULT_TTL_S", 1)
    monkeypatch.setattr(codex_login, "GRACE_S", 0)
    monkeypatch.setenv("FAKE_CODEX_DEVICE", "noexpiry")
    flow = client.post("/api/system/codex/login").json()
    assert flow["state"] == "waiting" and flow["expires_at"] == pytest.approx(flow["started_at"] + 1)
    pid = int((fake / "device.pid").read_text())
    expired = wait_for(lambda: (s := client.get("/api/system/codex/login").json())["state"] == "expired" and s)
    assert expired["code"] is None
    wait_for(lambda: not _alive(pid))


def test_api_key_goes_to_the_cli_on_stdin_and_is_never_returned(client, fake):
    key = "sk-proj-" + "Zx9" * 20
    r = client.post("/api/system/codex/auth", json={"value": f"  {key}\n"})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "installed": True, "authenticated": True, "reason": None, "method": "api_key"}
    assert (fake / "stdin").read_text() == key
    call = _calls(fake, "--with-api-key")[0]["argv"]
    assert call[-2:] == ["login", "--with-api-key"] and not any(key in a for a in call)
    assert key not in r.text
    # refused by the CLI: its error, without the key
    refused = "sk-refused-" + "Q" * 30
    r = client.post("/api/system/codex/auth", json={"value": refused})
    assert r.status_code == 502 and r.json()["error"] == "login_failed"
    assert r.json()["message"] == "Error: the key ••• was refused" and refused not in r.text
    # not a key: refused before the CLI, without repeating it
    for bad in ("sk-short", "sk-with a space-in-the-middle-0123456789", "sk-" + "é" * 30, "x" * 5000):
        r = client.post("/api/system/codex/auth", json={"value": bad})
        assert r.status_code == 400 and r.json()["error"] == "invalid" and bad not in r.text
    assert client.post("/api/system/codex/auth", json={"value": 12}).status_code == 422
    assert len(_calls(fake, "--with-api-key")) == 2


def test_a_key_stops_a_running_device_flow_and_sign_out_works(client, fake):
    assert client.post("/api/system/codex/login").json()["state"] == "waiting"
    assert client.post("/api/system/codex/auth", json={"value": "sk-proj-" + "a" * 40}).json()["method"] == "api_key"
    assert client.get("/api/system/codex/login").json()["state"] == "cancelled"
    r = client.delete("/api/system/codex/auth")
    assert r.status_code == 200 and r.json() == {"ok": True, "installed": True, "authenticated": False,
                                                 "reason": "not_authenticated", "method": None}
    assert client.delete("/api/system/codex/auth").json()["ok"] is True        # already signed out
    assert _calls(fake, "logout")


def test_without_codex_the_routes_say_so(client, mx, monkeypatch):
    monkeypatch.setattr(codex, "binary", lambda: None)
    assert client.get("/api/system/codex").json() == {"installed": False, "authenticated": False,
                                                      "reason": "not_installed", "method": None}
    for method, path, body in (("POST", "/api/system/codex/login", None),
                               ("POST", "/api/system/codex/auth", {"value": "sk-proj-" + "b" * 40}),
                               ("DELETE", "/api/system/codex/auth", None)):
        r = client.request(method, path, json=body)
        assert r.status_code == 409 and r.json()["error"] == "not_installed", (method, path)
    assert client.get("/api/system/codex/login").json()["state"] == "none"


def test_every_sign_in_route_needs_the_session_and_the_csrf_header(client, fake):
    routes = (("GET", "/api/system/codex/login"), ("POST", "/api/system/codex/login"),
              ("DELETE", "/api/system/codex/login"), ("POST", "/api/system/codex/auth"),
              ("DELETE", "/api/system/codex/auth"))
    from fastapi.testclient import TestClient
    from maxxing.app import create_app
    anon = TestClient(create_app())                          # no cookie (and no lifespan: nothing else starts)
    for method, path in routes:
        assert anon.request(method, path, json={"value": "sk-proj-" + "c" * 40},
                            headers={"X-Maxxing": "1"}).status_code == 401, path
    del client.headers["X-Maxxing"]
    for method, path in routes[1:]:
        assert client.request(method, path, json={"value": "sk-proj-" + "c" * 40}).status_code == 403, path
    client.headers["X-Maxxing"] = "1"
    assert not (fake / "calls.jsonl").exists()               # nothing reached the CLI
