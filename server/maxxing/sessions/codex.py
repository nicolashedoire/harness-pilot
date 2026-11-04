"""Codex CLI adapter: safe invocation and translation to the session event vocabulary."""
from __future__ import annotations

import json
import os
import re
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


# ---- MCP servers -----------------------------------------------------------------------------------------------
MCP_NAME_RE = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")         # a bare TOML key in `-c mcp_servers.<name>=...`
REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}$]*))?\}")   # Claude Code's ${VAR} / ${VAR:-default}
# never replaced in the Codex process environment by a server's secret (the process itself needs them)
RESERVED_ENV = re.compile(r"\A(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|TERM|LANG|LC_\w+|TZ|TMPDIR|HOSTNAME|PYTHON\w*|"
                          r"LD_\w+|DYLD_\w+|NODE_\w+|BASH_ENV|ENV|SSL_\w+|\w*_PROXY|\w*_proxy|CODEX_\w*|OPENAI_\w*|"
                          r"MAXXING_\w*|RUST_\w+)\Z")


class _Missing(Exception):
    pass


def _expand(value: object, env: dict[str, str]) -> str:
    def one(m: re.Match) -> str:
        if m.group(1) in env:
            return env[m.group(1)]
        if m.group(2) is not None:
            return m.group(2)
        raise _Missing(m.group(1))
    return REF_RE.sub(one, str(value))


def _toml(v: object) -> str:
    if isinstance(v, dict):
        return "{" + ", ".join(f"{k if MCP_NAME_RE.match(k) else json.dumps(k)} = {_toml(x)}" for k, x in v.items()) + "}"
    if isinstance(v, list):
        return "[" + ", ".join(_toml(x) for x in v) + "]"
    return json.dumps(str(v), ensure_ascii=False)


def _server(cfg: dict, env: dict[str, str], extra: dict[str, str], header_no: int,
            taken: dict[str, str], keys: set[str] = frozenset(),
            turn_env: dict[str, str] | None = None) -> tuple[dict | None, str]:
    """One Claude Code server config -> (Codex table, "") or (None, why it is skipped). Secrets go to `extra` (the
    Codex process environment; header values as MAXXING_MCP_H<header_no...>), never into the table, which ends up
    on the command line."""
    from .. import mcp                                   # masking rules shared with Settings -> MCP
    kind = str(cfg.get("type") or ("stdio" if cfg.get("command") else "http"))
    if kind == "stdio":
        if not isinstance(cfg.get("command"), str) or not cfg["command"].strip():
            return None, "no command"
        args = cfg.get("args") if isinstance(cfg.get("args"), list) else []
        if any(mcp._secret_args(args)) or any(m.group(1) in keys for a in [cfg["command"], *args]    # noqa: SLF001
                                              for m in REF_RE.finditer(str(a))):
            return None, "a key in its command arguments (use an environment variable)"
        out: dict = {"command": _expand(cfg["command"], env), "args": [_expand(a, env) for a in args]}
        plain, forwarded = {}, []
        for k, v in (cfg.get("env") if isinstance(cfg.get("env"), dict) else {}).items():
            k, v = str(k), str(v)
            if not REF_RE.search(v) and not mcp.SECRET_NAME_RE.search(k) and not mcp._has_literal(v):   # noqa: SLF001
                plain[k] = v                             # a setting (LOG_LEVEL=debug): nothing secret
            elif not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) or RESERVED_ENV.match(k):
                return None, f"its variable {k} cannot be passed safely"
            elif k in taken and taken[k] != _expand(v, env):
                return None, f"its variable {k} has another value in a server already given to Codex"
            elif k in (turn_env or {}) and turn_env[k] != _expand(v, env):
                return None, f"its variable {k} has another value in the session's environment"
            else:
                if k not in (turn_env or {}):            # already there with this value: nothing to add or hide
                    extra[k] = _expand(v, env)
                forwarded.append(k)
        if plain:
            out["env"] = plain
        if forwarded:
            out["env_vars"] = forwarded
        return out, ""
    if kind != "http":
        return None, f"{kind} transport (Codex supports stdio and streamable HTTP)"
    url = str(cfg.get("url") or "")
    if not url or REF_RE.search(url) or mcp._url_masked(url) != url:                              # noqa: SLF001
        return None, "its address carries a key"
    out = {"url": url}
    for h, v in (cfg.get("headers") if isinstance(cfg.get("headers"), dict) else {}).items():
        h, v = str(h), str(v)
        if h.lower() in mcp.PLAIN_HEADERS and not REF_RE.search(v):
            out.setdefault("http_headers", {})[h] = v
        else:
            name = f"MAXXING_MCP_H{header_no}"
            header_no += 1
            extra[name] = _expand(v, env)
            out.setdefault("env_http_headers", {})[h] = name
    return out, ""


def tools_approval(mode: str) -> str:
    """`default_tools_approval_mode` of every server for a permission mode. `codex exec` never asks (approval policy
    `never`) and its sandbox does not apply to MCP tools; checked with codex-cli 0.150.1: "writes" runs only the
    tools a server marks read-only (`readOnlyHint`) and refuses the others ("MCP tool call requires approval, but
    approval policy is never"), "approve" runs them all. Only Full access (bypass) lets Codex write through MCP,
    like Claude, whose other modes refuse tools that need approval in an unattended turn."""
    return "approve" if mode == "bypass" else "writes"


def mcp_config(cwd: str, env: dict[str, str], mode: str = "default") -> tuple[list[str], dict[str, str],
                                                                               list[tuple[str, str]]]:
    """The MCP servers Claude Code would load in `cwd`, for a Codex turn in permission `mode` -> (`-c` arguments,
    variables to add to the Codex process environment, [(server, reason)] skipped). `env`: the turn environment
    (references resolve from it and from the vault keys flagged `expose`)."""
    if os.environ.get("MAXXING_CODEX_MCP") == "0":                    # tests: never the real .claude.json
        return [], {}, []
    from .. import config, mcp_auto
    from . import spawn
    try:
        claude_json = mcp_auto._read_cfg()                                                          # noqa: SLF001
    except (OSError, ValueError, RecursionError):
        claude_json = {}
    users, folder = mcp_auto.candidates(cwd, claude_json if isinstance(claude_json, dict) else {})
    vault = spawn._exposed_vault(config.load_secrets())                                           # noqa: SLF001
    refs = {**vault, **env}
    args: list[str] = []
    extra: dict[str, str] = {}
    skipped: list[tuple[str, str]] = []
    chosen = {s.name: s for s in users}
    chosen.update({s.name: s for s in folder})          # the folder's server wins over a user one of the same name
    for name, s in sorted(chosen.items()):
        if not MCP_NAME_RE.match(name):
            skipped.append((name, "its name has characters Codex does not accept"))
            continue
        mine: dict[str, str] = {}                       # kept only when the server is passed
        try:
            table, why = _server(s.cfg, refs, mine, sum(1 for k in extra if k.startswith("MAXXING_MCP_H")), extra,
                                 set(vault), env)
        except _Missing as e:
            table, why = None, f"no value for ${{{e}}}"
        if table is None:
            skipped.append((name, why))
            continue
        extra.update(mine)
        table["default_tools_approval_mode"] = tools_approval(mode)
        args += ["-c", f"mcp_servers.{name}={_toml(table)}"]
    if extra:                                           # the servers' secrets stay out of the agent's shell commands
        args += ["-c", f"shell_environment_policy.exclude={_toml(sorted(extra))}"]
    return args, extra, skipped


# ---- sandbox ---------------------------------------------------------------------------------------------------
PROFILE = "protected"                          # Codex permission profile name (":..." names are Codex's built-ins)
# Kept read-only inside the writable folder, as `--sandbox workspace-write` does: a profile extending ":workspace"
# loses that (checked with codex-cli 0.150.1), so they are listed again.
WORKSPACE_READ_ONLY = (".git", ".codex", ".agents")


def sandbox_args(mode: str) -> list[str]:
    """Codex's sandbox for a permission mode: read-only in default / plan, workspace-write otherwise - never
    unrestricted machine access, even when Claude's mode is bypass. With config `protect_secrets` (default on), the
    same sandbox as a permission profile that also denies `spawn.secret_paths()`: Codex's OS sandbox then refuses
    reading or changing them to every command it runs. No `--sandbox` with it: that flag silently replaces the
    profile. Only existing paths are passed (nothing to protect otherwise); none: plain `--sandbox`.
    INTERNALS.md `maxxing.sessions.codex` has what was checked and what it does not cover (MCP servers)."""
    from .. import config
    from . import spawn
    write = mode not in ("default", "plan")
    paths = [os.path.abspath(p) for p in spawn.secret_paths() if os.path.lexists(p)] \
        if config.load_config().get("protect_secrets", True) else []
    if not paths:
        return ["--sandbox", "workspace-write" if write else "read-only"]
    fs: dict = {":workspace_roots": {".": "write", **{d: "read" for d in WORKSPACE_READ_ONLY}}} if write else {}
    fs.update({p: "deny" for p in paths})
    profile = {"extends": ":workspace" if write else ":read-only", "filesystem": fs}
    return ["-c", f'default_permissions="{PROFILE}"', "-c", f"permissions.{PROFILE}={_toml(profile)}"]


def command(thread_id: str, mode: str, model: str = "", images: list[str] | None = None,
            mcp: list[str] | None = None) -> list[str]:
    binary = os.environ.get("MAXXING_CODEX_BIN") or shutil.which("codex") or "codex"
    args = [binary, "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", *sandbox_args(mode)]
    args += privacy_args() + list(mcp or [])
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
            *sandbox_args("plan"), *privacy_args()]
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
