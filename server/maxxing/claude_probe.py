"""A bounded, tool-free Claude authentication call shared by the API and CLI. Standard library only."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time

from . import claude_auth
from .sessions import spawn

MODEL = "claude-haiku-4-5-20251001"
PROMPT = "Reply with the single word: ok"
TIMEOUT_S = 90
NOT_INSTALLED = "Claude Code is not installed"


def binary() -> str | None:
    """The Claude Code executable that sessions and the probe run, or None when it is missing."""
    b = spawn.claude_bin()
    if os.path.isabs(b):
        return b if os.access(b, os.X_OK) else None
    return shutil.which(b, path=spawn.base_env()["PATH"])


def answered(returncode: int, data: dict) -> bool:
    """The authenticated call returned an answer. Its wording does not matter ("OK.", "ok!", "Ok, ready"): the
    probe checks the sign-in and the request path, not how closely the model follows the prompt."""
    answer = data.get("result")
    return (returncode == 0 and not data.get("is_error") and data.get("type", "result") == "result"
            and data.get("subtype", "success") == "success" and isinstance(answer, str) and bool(answer.strip())
            and not claude_auth.detect(answer))         # a sign-in error printed as the answer is not one


def run(model: str = MODEL, prompt: str = PROMPT, timeout_s: int = TIMEOUT_S) -> dict:
    start = time.monotonic()
    out: dict = {"ok": False, "model": model, "ms": 0}
    b = binary()
    if not b:
        out["error"] = NOT_INSTALLED
        return out
    # --setting-sources "": no user, project or local settings file, so none of the user's hooks run. It also
    # skips what only settings provide (apiKeyHelper, settings `env`): see INTERNALS.md `maxxing.claude_probe`.
    args = [b, "-p", "--output-format", "json", "--model", model,
            "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
            "--system-prompt", "Reply only ok."]
    try:
        # A state folder inside a checkout inherits that checkout's CLAUDE.md. The OS temp directory
        # avoids that ancestry; no --bare, which would also disable OAuth / macOS Keychain credentials.
        with tempfile.TemporaryDirectory(prefix="pilot-claude-test-") as cwd:
            r = subprocess.run(args, input=prompt, capture_output=True, text=True, timeout=timeout_s,
                               cwd=cwd, env=spawn.claude_env(None, "default"))
    except subprocess.TimeoutExpired:
        out["error"] = f"No answer within {timeout_s} s"
    except OSError as e:
        out["error"] = str(e)[:400]
    else:
        try:
            data = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        answer = str(data.get("result") or "").strip()
        if answered(r.returncode, data):
            out["ok"] = True
            usage = data.get("modelUsage")
            if isinstance(usage, dict) and usage:
                out["model"] = next(iter(usage))
        else:
            out["error"] = (answer or r.stderr or r.stdout or f"exit code {r.returncode}").strip()[-400:]
    out["ms"] = int((time.monotonic() - start) * 1000)
    return out
