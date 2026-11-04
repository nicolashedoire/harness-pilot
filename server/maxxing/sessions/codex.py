"""Codex CLI adapter: safe invocation and translation to the session event vocabulary."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


def privacy_args() -> list[str]:
    """Per-process settings shared by status checks and execution; never rewrite personal config."""
    args = []
    # Keep app-owned turns private even if the CLI's built-in analytics default changes.
    # analytics.enabled alone does not disable explicitly configured OTLP exporters.
    for key, value in (
        ('analytics.enabled', 'false'), ('otel.exporter', '"none"'),
        ('otel.metrics_exporter', '"none"'), ('otel.trace_exporter', '"none"'),
        ('otel.log_user_prompt', 'false'), ('otel.log_agent_responses', 'false'),
    ):
        args += ['-c', f'{key}={value}']
    return args


def status() -> dict:
    """Check the same CLI and account used by sessions without exposing its output."""
    binary = os.environ.get('MAXXING_CODEX_BIN') or shutil.which('codex')
    if not binary:
        return {'installed': False, 'authenticated': False, 'reason': 'not_installed'}
    try:
        result = subprocess.run([binary, *privacy_args(), 'login', 'status'], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        return {'installed': True, 'authenticated': result.returncode == 0,
                'reason': None if result.returncode == 0 else 'not_authenticated'}
    except (OSError, subprocess.TimeoutExpired):
        return {'installed': True, 'authenticated': None, 'reason': 'status_unavailable'}


def workspace_context(root: Path, cwd: Path) -> str:
    """Share Harness's existing project/topic instructions and memory with Codex."""
    root, cwd = root.resolve(), cwd.resolve()
    if cwd != root and root not in cwd.parents:
        return ""
    folders = list(reversed([cwd, *[p for p in cwd.parents if p != root and root in p.parents]]))
    folders.insert(0, root)
    parts = []
    for folder in dict.fromkeys(folders):
        for name in ("CLAUDE.md", "memory.md"):
            path = folder / name
            try:
                resolved = path.resolve()
                if root not in resolved.parents or not resolved.is_file():
                    continue
                with resolved.open("rb") as f:
                    content = f.read(32769)
                truncated = len(content) > 32768
                text = content[:32768].decode("utf-8", errors="replace")
                parts.append(f"--- {path.relative_to(root)} ---\n{text}" + ("\n[truncated]" if truncated else ""))
            except OSError:
                continue
    parts += _blocks_context()   # the conversation block types enabled on this server (written by maxxing/blocks.py)
    return "\n\n".join(parts)


def _blocks_context() -> list[str]:
    from .. import config
    try:
        with (config.STATE / "blocks" / "agents.md").open("rb") as f:
            return [f"--- conversation blocks ---\n{f.read(16384).decode('utf-8', errors='replace')}"]
    except OSError:
        return []


def command(thread_id: str, mode: str, model: str = "", images: list[str] | None = None) -> list[str]:
    binary = os.environ.get("MAXXING_CODEX_BIN") or shutil.which("codex") or "codex"
    # Never silently give Codex unrestricted machine access, including when Claude's default is bypass.
    sandbox = "read-only" if mode in ("default", "plan") else "workspace-write"
    args = [binary, "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", sandbox]
    args += privacy_args()
    if model:
        args += ["--model", model]
    for image in images or []:
        args += ["--image", image]
    return args + (["resume", thread_id, "-"] if thread_id else ["-"])


def fork_command(thread_id: str, model: str = "") -> list[str]:
    """A throwaway, read-only copy of a Codex thread (side questions): `exec fork` with `--ephemeral` writes no
    session file, the original thread is not touched."""
    binary = os.environ.get("MAXXING_CODEX_BIN") or shutil.which("codex") or "codex"
    args = [binary, "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ephemeral",
            "--sandbox", "read-only", *privacy_args()]
    if model:
        args += ["--model", model]
    return args + ["fork", thread_id, "-"]


def events(event: dict) -> list[dict]:
    """Map completed CLI events into the existing Claude-compatible log format."""
    kind = event.get("type")
    if kind == "thread.started":
        return [{"type": "system", "subtype": "init"}]
    if kind == "item.completed":
        item = event.get("item") or {}
        if not isinstance(item, dict):
            return []
        if item.get("type") == "agent_message":
            return [{"type": "assistant", "message": {"content": [{"type": "text", "text": item.get("text") or ""}]}}]
        if item.get("type") == "command_execution":
            ident = str(item.get("id") or "")
            return [
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": ident,
                    "name": "Bash", "input": {"command": item.get("command") or ""}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": ident,
                    "content": item.get("aggregated_output") or "", "is_error": item.get("exit_code") not in (0, None)}]}},
            ]
        return []
    if kind == "turn.completed":
        usage = event.get("usage") or {}
        if not isinstance(usage, dict):
            usage = {}
        # Codex reports cached tokens within input_tokens. The common session counters expect
        # uncached input, cache reads and cache writes as separate, non-overlapping buckets.
        def count(name: str) -> int:
            try:
                return max(0, int(usage.get(name) or 0))
            except (TypeError, ValueError, OverflowError):
                return 0
        total_input = count("input_tokens")
        cache_read = min(total_input, count("cached_input_tokens"))
        cache_write = min(total_input - cache_read, count("cache_write_input_tokens"))
        return [{"type": "result", "subtype": "success", "usage": {
            "input_tokens": total_input - cache_read - cache_write,
            "output_tokens": count("output_tokens"),
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_write}}]
    if kind == "turn.failed":
        err = event.get("error") or {}
        message = err.get("message") if isinstance(err, dict) else str(err)
        return [{"type": "result", "subtype": "error", "is_error": True, "errors": [message or "Codex turn failed"]}]
    return []
