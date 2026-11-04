"""Codex CLI adapter: safe invocation and translation to the session event vocabulary."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
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


def binary() -> str | None:
    """The Codex CLI sessions use: `MAXXING_CODEX_BIN`, else `codex` on the PATH; None when there is none."""
    return os.environ.get('MAXXING_CODEX_BIN') or shutil.which('codex')


def _login_method(text: str) -> str | None:
    """How `codex login status` says it is signed in (codex-cli 0.150.1, on stderr): "Logged in using ChatGPT" or
    "Logged in using an API key - sk-…***…" (masked). Only this word leaves the function, never the text."""
    if 'ChatGPT' in text:
        return 'chatgpt'
    if 'API key' in text:
        return 'api_key'
    return None


def status() -> dict:
    """Check the same CLI and account used by sessions without exposing its output."""
    path = binary()
    if not path:
        return {'installed': False, 'authenticated': False, 'reason': 'not_installed', 'method': None}
    try:
        result = subprocess.run([path, *privacy_args(), 'login', 'status'], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, errors='replace', timeout=8)
        ok = result.returncode == 0
        return {'installed': True, 'authenticated': ok, 'reason': None if ok else 'not_authenticated',
                'method': _login_method(f'{result.stdout}\n{result.stderr}') if ok else None}
    except (OSError, subprocess.TimeoutExpired):
        return {'installed': True, 'authenticated': None, 'reason': 'status_unavailable', 'method': None}


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
# Kept read-only inside the writable folder: `.git` / `.codex` / `.agents` as `--sandbox workspace-write` does (a
# profile extending ":workspace" loses that, checked with codex-cli 0.150.1, so they are listed again), and the
# folder's SESSION_CONFIG.
WORKSPACE_READ_ONLY = (".git", ".codex", ".agents", ".claude", ".mcp.json", ".maxxing.json")
# What the server or Claude runs or obeys outside Codex's sandbox, as the server's user (root on a server
# installation): a write-mode Codex turn never changes it, whatever folder it runs in (the workspace root included).
# - SERVER_CODE, read-only: `extensions/` (api.py the server imports, agent providers it starts, block plugins),
#   `customizations/` (patches `pilot custom restore` applies to the product code), `infra.json` (servers the server
#   reaches over ssh; Claude's deny rules have it too).
# - SESSION_CONFIG of every folder a session runs in (the root, projects/<p>, projects/<p>/topics/<t>): its
#   permission mode (`.maxxing.json`: bypass would free Claude there), Claude Code's settings (hooks, MCP servers,
#   helpers) and hook scripts, the folder's `.mcp.json`. Read-only at the root and in the turn's own folder
#   (WORKSPACE_READ_ONLY); in the other folders through patterns, which a profile only accepts as "deny"
#   (codex-cli 0.150.1): Codex can neither read nor change those files there.
SERVER_CODE = ("extensions", "customizations", "infra.json")
SESSION_CONFIG = (".maxxing.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/**",
                  ".mcp.json")
SESSION_FOLDERS = ("projects/*", "projects/*/topics/*")


_GLOB_CHARS = re.compile(r"([*?\[\]{}])")


def _glob_literal(path: str) -> str:
    """`path` as a literal inside a Codex filesystem pattern: codex-cli 0.150.1 reads any path holding * ? [ ] { }
    as a glob (so `/srv/ws [2]/x` would not match itself), and a glob only takes "deny"."""
    return _GLOB_CHARS.sub(r"[\1]", path)


def _read_only(path: str) -> tuple[str, str]:
    """A "read" entry for `path` (and below); for a path holding glob characters, which Codex refuses as "read",
    a "deny" of the literal path and everything under it: never readable then, but never writable either."""
    if not _GLOB_CHARS.search(path):
        return path, "read"
    lit = _glob_literal(path)
    return (f"{lit}/**" if os.path.isdir(path) or not os.path.splitext(path)[1] else lit), "deny"


def _deny(path: str) -> dict[str, str]:
    """"deny" entries for a secret path: the path itself; written as a pattern (glob characters in it), a pattern
    of a folder does not cover what is inside, so `<folder>/**` is denied too."""
    if not _GLOB_CHARS.search(path):
        return {path: "deny"}
    lit = _glob_literal(path)
    return {lit: "deny", **({f"{lit}/**": "deny"} if os.path.isdir(path) else {})}


def _server_side(ws: str) -> dict[str, str]:
    """The filesystem entries that keep SERVER_CODE and every SESSION_CONFIG out of a write-mode turn's reach."""
    try:                                               # an existing folder: its rule never depends on Codex's handling
        os.makedirs(os.path.join(ws, "extensions"), exist_ok=True)   # of a missing path
    except OSError:
        pass
    fs = dict(_read_only(os.path.join(ws, p)) for p in (*SERVER_CODE, ".maxxing.json", ".claude", ".mcp.json"))
    base = _glob_literal(ws)
    fs.update({f"{base}/{d}/{c}": "deny" for d in SESSION_FOLDERS for c in SESSION_CONFIG})
    return fs


def sandbox_args(mode: str) -> list[str]:
    """Codex's sandbox for a permission mode: read-only in default / plan, workspace-write otherwise - never
    unrestricted machine access, even when Claude's mode is bypass. Workspace-write is always a permission profile
    that also keeps the server's code and the sessions' settings read-only (SERVER_CODE, SESSION_CONFIG): changing
    them would run code outside Codex's sandbox. With config `protect_secrets` (default on), the profile also denies
    `spawn.secret_paths()` (read-only modes too): Codex's OS sandbox then refuses reading or changing them to every
    command it runs. No `--sandbox` with a profile: that flag silently replaces it. Only existing secret paths are
    passed; read-only with none: plain `--sandbox read-only`.
    INTERNALS.md `maxxing.sessions.codex` has what was checked and what it does not cover (MCP servers)."""
    from .. import config
    from . import spawn
    write = mode not in ("default", "plan")
    paths = [os.path.abspath(p) for p in spawn.secret_paths() if os.path.lexists(p)] \
        if config.load_config().get("protect_secrets", True) else []
    if not paths and not write:
        return ["--sandbox", "read-only"]
    fs: dict = {}
    if write:
        fs[":workspace_roots"] = {".": "write", **{d: "read" for d in WORKSPACE_READ_ONLY}}
        fs.update(_server_side(os.path.abspath(str(config.workspace()))))
    for p in paths:
        fs.update(_deny(p))
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


USAGE_KEYS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens")


def usage_totals(event: dict) -> dict[str, int]:
    """The counters of a `turn.completed` event. `codex exec --json` reports there the THREAD's running totals (every
    model call of every turn so far, `exec resume` included), not the turn's own: checked with codex-cli 0.150.1
    against a stub Responses API (INTERNALS.md `maxxing.sessions.codex`)."""
    usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
    out = {}
    for name in USAGE_KEYS:
        try:
            out[name] = max(0, int(usage.get(name) or 0))
        except (TypeError, ValueError, OverflowError):
            out[name] = 0
    return out


def turn_usage(totals: dict[str, int], base: dict | None) -> dict[str, int]:
    """The turn's own counters: the thread's running totals minus those after its previous turn (`base`; None for a
    new thread or one never counted). A total below its base (not the same thread after all) -> the totals."""
    if not isinstance(base, dict):
        return dict(totals)
    try:
        prev = {k: int(base.get(k) or 0) for k in USAGE_KEYS}
    except (TypeError, ValueError, OverflowError):
        return dict(totals)
    if any(totals[k] < prev[k] for k in USAGE_KEYS):
        return dict(totals)
    return {k: totals[k] - prev[k] for k in USAGE_KEYS}


def events(event: dict, base: dict | None = None) -> list[dict]:
    """Map completed CLI events into the existing Claude-compatible log format. `base`: the thread's running totals
    after its previous turn (`usage_totals`), so that a `result` carries the turn's own tokens."""
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
        usage = turn_usage(usage_totals(event), base)
        # Codex reports cached tokens within input_tokens. The common session counters expect
        # uncached input, cache reads and cache writes as separate, non-overlapping buckets.
        total_input = usage["input_tokens"]
        cache_read = min(total_input, usage["cached_input_tokens"])
        cache_write = min(total_input - cache_read, usage["cache_write_input_tokens"])
        return [{"type": "result", "subtype": "success", "usage": {
            "input_tokens": total_input - cache_read - cache_write,
            "output_tokens": usage["output_tokens"],
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_write}}]
    if kind == "turn.failed":
        err = event.get("error") or {}
        message = err.get("message") if isinstance(err, dict) else str(err)
        return [{"type": "result", "subtype": "error", "is_error": True, "errors": [message or "Codex turn failed"]}]
    return []


# ---- context size (Codex's own session file) --------------------------------------------------------------------
# `codex exec --json` carries neither the context of a call nor the window; Codex writes both to its session file after
# every model call (`token_count`). Checked with codex-cli 0.150.1: INTERNALS.md `maxxing.sessions.codex`.
DEFAULT_WINDOW = 258_400       # Codex's window when it records none: 272 000 (every 0.150.1 model) x 95 % usable
THREAD_ID_RE = re.compile(r"\A[0-9A-Za-z][0-9A-Za-z-]{7,63}\Z")
SESSION_TAIL = 256 * 1024      # bytes read at the end of the file for the last call (more when none is there)
SESSION_TAIL_MAX = 4 * 1024 * 1024


def home(env: dict[str, str] | None = None) -> Path:
    """Codex's folder for the process environment `env`: CODEX_HOME, else ~/.codex."""
    env = os.environ if env is None else env
    if env.get("CODEX_HOME"):
        return Path(env["CODEX_HOME"]).expanduser()
    return Path(env.get("HOME") or Path.home()) / ".codex"


def session_file(thread_id: str, env: dict[str, str] | None = None) -> Path | None:
    """Codex's record of a thread: `<home>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl` (the day the
    thread started; `exec resume` appends to it). Thread ids are UUIDv7: the day of their timestamp (+-1) is looked at
    first, then every day folder."""
    if not THREAD_ID_RE.match(thread_id or ""):
        return None
    root = home(env) / "sessions"
    name = f"rollout-*-{thread_id}.jsonl"
    days: list[str] = []
    hexa = thread_id.replace("-", "")
    if len(hexa) == 32 and hexa[12] == "7":
        try:
            at = int(hexa[:12], 16) / 1000
            days = [time.strftime("%Y/%m/%d", time.localtime(at + d)) for d in (0, -86400, 86400)]
        except (ValueError, OverflowError, OSError):
            days = []
    try:
        for day in dict.fromkeys(days):
            found = sorted((root / day).glob(name))
            if found:
                return found[-1]
        found = sorted(root.glob(f"*/*/*/{name}"))
    except OSError:
        return None
    return found[-1] if found else None


def _token_counts(chunk: bytes) -> list[dict]:
    out = []
    for line in chunk.split(b"\n"):
        if b'"token_count"' not in line:
            continue
        try:
            ev = json.loads(line)
        except (ValueError, RecursionError):
            continue
        payload = ev.get("payload") if isinstance(ev, dict) else None
        if isinstance(payload, dict) and payload.get("type") == "token_count" and isinstance(payload.get("info"), dict):
            out.append(payload["info"])
    return out


def _input(info: dict) -> int:
    last = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else {}
    try:
        return max(0, int(last.get("input_tokens") or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def context_usage(thread_id: str, env: dict[str, str] | None = None, first: bool = False) -> dict | None:
    """{tokens, window, first} of a thread from its session file: `tokens` = the input of its last model call (cached
    tokens included, as Claude's context), `window` = `model_context_window` (the usable window Codex measures
    against, DEFAULT_WINDOW when it records none), `first` = the input of the file's first call (with `first`, for a
    thread started by this turn: its fixed part). None when the file, or a call with a context, is not found."""
    path = session_file(thread_id, env)
    if path is None:
        return None
    try:
        with path.open("rb") as f:
            size = f.seek(0, os.SEEK_END)
            infos: list[dict] = []
            for want in (SESSION_TAIL, SESSION_TAIL_MAX):
                start = max(0, size - want)
                f.seek(start)
                chunk = f.read(size - start)
                if start:
                    chunk = chunk.split(b"\n", 1)[-1]          # a cut first line
                infos = _token_counts(chunk)
                if infos or not start:
                    break
            head = None
            if first:
                f.seek(0)
                chunk = f.read(SESSION_TAIL)
                calls = _token_counts(chunk.rsplit(b"\n", 1)[0] if len(chunk) == SESSION_TAIL else chunk)
                head = _input(calls[0]) if calls else None
    except OSError:
        return None
    if not infos or not _input(infos[-1]):          # 0: Codex just compacted its thread, the next call tells
        return None
    try:
        window = int(infos[-1].get("model_context_window") or 0)
    except (TypeError, ValueError, OverflowError):
        window = 0
    return {"tokens": _input(infos[-1]), "window": window if window > 0 else DEFAULT_WINDOW, "first": head or None}
