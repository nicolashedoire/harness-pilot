"""A bounded, tool-free Claude authentication call shared by the API and CLI. Standard library only."""
from __future__ import annotations

import json
import subprocess
import tempfile
import time

from .sessions import spawn

MODEL = "claude-haiku-4-5-20251001"
PROMPT = "Reply with the single word: ok"
TIMEOUT_S = 90


def run(model: str = MODEL, prompt: str = PROMPT, timeout_s: int = TIMEOUT_S) -> dict:
    start = time.monotonic()
    out: dict = {"ok": False, "model": model, "ms": 0}
    args = [spawn.claude_bin(), "-p", "--output-format", "json", "--model", model,
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
        if r.returncode == 0 and not data.get("is_error") and answer.casefold() == "ok":
            out["ok"] = True
            usage = data.get("modelUsage")
            if isinstance(usage, dict) and usage:
                out["model"] = next(iter(usage))
        else:
            out["error"] = (answer or r.stderr or r.stdout or f"exit code {r.returncode}").strip()[-400:]
    out["ms"] = int((time.monotonic() - start) * 1000)
    return out
