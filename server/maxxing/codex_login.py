"""Signing Codex in from the web app. See docs/dev/API.md#system and INTERNALS.md `maxxing.codex_login`.

Two ways, both through the Codex CLI that sessions use (`sessions.codex.binary()`), which keeps the credentials in its
own folder (`CODEX_HOME`, default `~/.codex/auth.json`, mode 0600) exactly as `codex login` in a terminal does:

- ChatGPT account, device code: `codex login --device-auth` runs in the background. It prints a page to open and a
  one-time code to enter there (codex-cli 0.150.1: `https://auth.openai.com/codex/device`, a code shaped like
  `ABCD-EFGHI`, "expires in 15 minutes"), then waits and exits 0 once the user has signed in. One flow at a time.
- API key: `codex login --with-api-key` reads the key on stdin (never on a command line).

harness-pilot keeps no copy of the key and never logs or returns it, nor the CLI's output: only the page address, the
code while the flow waits, and a short error line in which codes and keys are masked.
"""
from __future__ import annotations

import os
import re
import signal
import subprocess
import threading
import time

from . import bus
from .sessions import codex

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
URL_RE = re.compile(r"https://[^\s<>\"'\x1b]+")
CODE_RE = re.compile(r"\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b")
EXPIRES_RE = re.compile(r"expires in (\d{1,3}) minute", re.I)
KEY_RE = re.compile(r"\b(?:sk|rk|sess)-[A-Za-z0-9_*.-]{6,}")
SHOW_TIMEOUT_S = 30          # no page and code by then: the flow is stopped
START_WAIT_S = 20            # how long POST waits for them before answering "starting"
DEFAULT_TTL_S = 15 * 60      # when the CLI does not say how long its code lasts
GRACE_S = 30                 # after the code expired, the CLI gets this long to give up by itself
KEY_TIMEOUT_S = 30
RUNNING = ("starting", "waiting")

_lock = threading.Lock()
_flow: "_Flow | None" = None


def _clean(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\r", "")


def _mask(text: str, *secrets: str) -> str:
    for s in secrets:
        if s:
            text = text.replace(s, "•••")
    return KEY_RE.sub("•••", CODE_RE.sub("•••", text))


def _error_line(lines: list[str], fallback: str, *secrets: str) -> str:
    """The CLI's last words (its error), masked and short; `fallback` when it said nothing."""
    for line in reversed(lines):
        line = line.strip()
        if line and not line.startswith("Continue only if"):
            return _mask(line, *secrets)[:300]
    return fallback


class _Flow:
    def __init__(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        self.state = "starting"
        self.url: str | None = None
        self.code: str | None = None
        self.started = time.time()
        self.expires_at: float | None = None
        self.error: str | None = None
        self.lines: list[str] = []          # the last lines, in memory only (for the error line)
        self.shown = threading.Event()
        self.ended = threading.Event()

    def public(self) -> dict:
        waiting = self.state == "waiting"
        return {"state": self.state, "url": self.url if waiting else None, "code": self.code if waiting else None,
                "expires_at": self.expires_at if waiting else None, "started_at": self.started, "error": self.error}

    def finish(self, state: str, error: str | None = None) -> None:
        """First final state wins (a cancel is not turned into "failed" when the killed CLI exits)."""
        with _lock:
            if self.state not in RUNNING:
                return
            self.state, self.error = state, error
            self.code = None
        self.shown.set()
        if state == "succeeded":
            _signed_in_changed()


def _signed_in_changed() -> None:
    """Another account (or none): the "Claude is not connected" health issue may soften, and the model list the CLI
    refreshes for the account is read again (codex_models)."""
    from . import codex_models
    codex_models.invalidate()
    bus.invalidate("health")


def _sign_in_page(url: str) -> bool:
    return "/device" in url or "auth." in url


def _kill(proc: subprocess.Popen) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            proc.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            continue


def _read(flow: _Flow) -> None:
    """Follow the CLI's output: the page and the code, then its end."""
    out = flow.proc.stdout
    assert out is not None
    for raw in out:
        line = _clean(raw).rstrip("\n")
        flow.lines = (flow.lines + [line])[-20:]
        if (m := URL_RE.search(line)) and flow.code is None:
            url = m.group(0).rstrip(".,)")
            if flow.url is None or (not _sign_in_page(flow.url) and _sign_in_page(url)):   # not a notice's link
                flow.url = url
        elif flow.url is not None and flow.code is None and (m := CODE_RE.search(line)):
            flow.code = m.group(0)
        if (m := EXPIRES_RE.search(line)) and flow.expires_at is None:
            flow.expires_at = flow.started + int(m.group(1)) * 60
        if flow.url and flow.code and flow.state == "starting":
            with _lock:
                if flow.state == "starting":
                    flow.state = "waiting"
                    flow.expires_at = flow.expires_at or flow.started + DEFAULT_TTL_S
            flow.shown.set()
    rc = flow.proc.wait()
    if rc == 0 and flow.code:
        flow.finish("succeeded")
    else:
        flow.finish("failed", _error_line(flow.lines, f"Codex stopped (exit code {rc})", flow.code or ""))
    flow.ended.set()


def _watch(flow: _Flow) -> None:
    """Stop a CLI that never shows a code, or that still waits after its code expired."""
    while not flow.ended.wait(1):
        now = time.time()
        if flow.state == "starting" and now - flow.started > SHOW_TIMEOUT_S:
            flow.finish("failed", "Codex did not show a sign-in code")
            _kill(flow.proc)
        elif flow.state == "waiting" and now > (flow.expires_at or flow.started + DEFAULT_TTL_S) + GRACE_S:
            flow.finish("expired")
            _kill(flow.proc)


def state() -> dict:
    """The current (or last) device-code flow of this server process: `{state: none|starting|waiting|succeeded|failed|
    cancelled|expired, url, code, expires_at, started_at, error}` (url, code and expires_at only while it waits)."""
    flow = _flow
    if flow is None:
        return {"state": "none", "url": None, "code": None, "expires_at": None, "started_at": None, "error": None}
    return flow.public()


def start() -> dict:
    """Start a device-code sign-in (or return the one already running) and wait a little for its page and code."""
    global _flow
    path = codex.binary()
    if not path:
        raise FileNotFoundError("codex")
    with _lock:
        flow = _flow
        if flow is None or flow.state not in RUNNING:
            env = {**os.environ, "NO_COLOR": "1"}
            proc = subprocess.Popen([path, *codex.privacy_args(), "login", "--device-auth"], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                                    env=env, start_new_session=True)
            flow = _flow = _Flow(proc)
            threading.Thread(target=_read, args=(flow,), name="codex-login-read", daemon=True).start()
            threading.Thread(target=_watch, args=(flow,), name="codex-login-watch", daemon=True).start()
    flow.shown.wait(START_WAIT_S)
    return flow.public()


def cancel() -> dict:
    """Stop the running flow (nothing to do otherwise)."""
    flow = _flow
    if flow is not None and flow.state in RUNNING:
        flow.finish("cancelled")
        _kill(flow.proc)
    return state()


def valid_key(value: str) -> bool:
    """Printable ASCII, no spaces, 20 to 4096 characters (a key is never echoed back, even in an error)."""
    return 20 <= len(value) <= 4096 and value.isascii() and value.isprintable() and not any(c.isspace() for c in value)


def with_api_key(key: str) -> str | None:
    """Hand an OpenAI API key to `codex login --with-api-key` on stdin -> None, or the CLI's error (masked)."""
    path = codex.binary()
    if not path:
        raise FileNotFoundError("codex")
    cancel()                                          # one sign-in at a time
    try:
        r = subprocess.run([path, *codex.privacy_args(), "login", "--with-api-key"], input=key + "\n",
                           capture_output=True, text=True, errors="replace", timeout=KEY_TIMEOUT_S,
                           env={**os.environ, "NO_COLOR": "1"})
    except subprocess.TimeoutExpired:
        return f"Codex did not answer within {KEY_TIMEOUT_S} s"
    except OSError as e:
        return _mask(str(e), key)[:300]
    if r.returncode == 0:
        _signed_in_changed()
        return None
    return _error_line(_clean(f"{r.stdout}\n{r.stderr}").splitlines(), f"Codex refused the key (exit code {r.returncode})",
                       key)


def logout() -> str | None:
    """`codex logout` (stops a running flow first) -> None, or the CLI's error (masked). Already signed out is fine."""
    path = codex.binary()
    if not path:
        raise FileNotFoundError("codex")
    cancel()
    try:
        r = subprocess.run([path, *codex.privacy_args(), "logout"], stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, errors="replace", timeout=KEY_TIMEOUT_S, env={**os.environ, "NO_COLOR": "1"})
    except (OSError, subprocess.TimeoutExpired) as e:
        return _mask(str(e))[:300] or "Codex did not answer"
    _signed_in_changed()
    if r.returncode == 0:
        return None
    text = _clean(f"{r.stdout}\n{r.stderr}")
    if "not logged in" in text.lower():
        return None
    return _error_line(text.splitlines(), f"Codex could not sign out (exit code {r.returncode})")
