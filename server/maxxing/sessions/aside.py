"""Side questions: ask the session's agent about it without interrupting it.

The question runs in a throwaway copy of the agent's thread - Claude: `--resume <csid> --fork-session
--no-session-persistence`, read-only (`--permission-mode plan`); Codex: `exec --ephemeral --sandbox read-only
fork <thread>`. The agent knows the whole conversation, but nothing is written - the running turn, the queue and
the thread are untouched, and the exchange is not added to the session log. A discussion or debate asks the agent
that answered last. One side question at a time per session, two in all (each is an agent process next to the
running turn: memory on a small server).
"""
from __future__ import annotations

import json
import math
import subprocess
import threading
import time

from .. import config
from . import codex, spawn, store
from .runner import Runner
from .service import SessionError, _require

ASK_TIMEOUT_S = 240
MAX_PARALLEL = 2
QUESTION_MAX = 8000

ASK_PREFACE = ("[Side question from the user, answered apart: your main task goes on in another process and this "
               "exchange is not part of it. Answer from what you already know of this conversation - briefly, in "
               "the user's language. Change nothing; use a read-only tool only if you really need to check "
               "something.]\n\n")

_lock = threading.Lock()
_busy: set[str] = set()


def _agent(m: dict) -> tuple[str, str] | None:
    """(agent, thread id) to ask, None when no thread answered yet. A discussion asks its last speaker first."""
    provider = str(m.get("provider") or "claude")
    claude = str(m.get("csid") or "") if m.get("csid") and not m.get("fresh", True) else ""
    threads = {"claude": claude, "codex": str(m.get("codex_thread_id") or "")}
    if provider in ("discussion", "debate"):
        last = "codex" if m.get("turn_provider") == "codex" else "claude"
        order = [last, "claude" if last == "codex" else "codex"]
    else:
        order = [provider]
    return next(((a, threads[a]) for a in order if threads.get(a)), None)


def ask(sid: str, question: str) -> dict:
    """-> {answer, agent, cost_usd, duration_ms}. 409 when the session has no thread yet or is already
    answering a side question, 429 when two side questions are running."""
    m = _require(sid)
    if str(m.get("provider") or "").startswith("plugin:"):
        raise SessionError(409, "unsupported", "Side questions are not available for agent plugin sessions.")
    question = (question or "").strip()[:QUESTION_MAX]
    if not question:
        raise SessionError(400, "empty", "Empty question")
    target = _agent(m)
    if target is None:
        raise SessionError(409, "no_thread", "Nothing to ask about yet: this session has not answered once.")
    agent, thread = target
    cfg = config.load_config()
    cwd = Runner._cwd(cfg, m)
    if cwd is None:
        raise SessionError(409, "no_topic", "The topic folder of this session no longer exists.")
    with _lock:
        if sid in _busy:
            raise SessionError(409, "busy", "A side question is already being answered for this session.")
        if len(_busy) >= MAX_PARALLEL:
            raise SessionError(429, "throttled", "Two side questions are already running - try again in a moment.")
        _busy.add(sid)
    try:
        if agent == "codex":
            return _run_codex(m, thread, cwd, question)
        out = _run(m, thread, cwd, cfg, question)
        try:
            store.update(sid, cache_at=time.time())      # the fork read the thread: its prompt cache is warm again
        except KeyError:                                 # the session was deleted while Claude answered
            pass
        return out
    finally:
        with _lock:
            _busy.discard(sid)


def _run(m: dict, csid: str, cwd: str, cfg: dict, question: str) -> dict:
    model = (m.get("model") or cfg.get("default_model") or "").strip()
    args = [spawn.claude_bin(), "-p", "--output-format", "json", *spawn.permission_args("plan")[0],
            "--resume", csid, "--fork-session", "--no-session-persistence", *spawn.settings_args(cfg)] + (["--model", model] if model else [])
    env = spawn.claude_env(m.get("env") or {}, "plan")
    t0 = time.time()
    try:
        p = subprocess.run(args, input=ASK_PREFACE + question, capture_output=True, text=True, cwd=cwd, env=env,
                           timeout=ASK_TIMEOUT_S, start_new_session=True)
    except subprocess.TimeoutExpired:
        raise SessionError(504, "timeout", f"No answer after {ASK_TIMEOUT_S} s.") from None
    except OSError as e:
        raise SessionError(500, "spawn_failed", f"Claude could not start: {e}") from None
    try:
        res = json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else {}
    except ValueError:
        res = {}
    if not isinstance(res, dict):                       # an unexpected last line: no answer, not a crash
        res = {}
    answer = str(res.get("result") or "").strip()
    if p.returncode != 0 or res.get("is_error") or not answer:
        detail = answer or (p.stderr or "").strip()[-300:] or f"exit code {p.returncode}"
        raise SessionError(502, "ask_failed", f"The side question failed: {detail}")
    # the fork starts from the thread's running total: only the increase is this question's cost
    try:
        total = float(res.get("total_cost_usd") or 0)
    except (TypeError, ValueError):
        total = 0.0
    cost = store.turn_cost(total if math.isfinite(total) else 0.0, store.thread_prev_cost(m, csid))
    ms = res.get("duration_ms")
    if not (isinstance(ms, (int, float)) and math.isfinite(ms) and ms):
        ms = (time.time() - t0) * 1000
    return {"answer": answer, "agent": "claude", "cost_usd": round(cost, 4), "duration_ms": int(ms)}


def _run_codex(m: dict, thread: str, cwd: str, question: str) -> dict:
    debate = m.get("provider") in ("discussion", "debate")
    model = str((m.get("codex_model") if debate else m.get("model")) or "").strip()
    env = spawn.base_env()
    env.update({str(k): str(v) for k, v in (m.get("env") or {}).items() if spawn.ENV_NAME_RE.match(str(k))})
    t0 = time.time()
    try:
        p = subprocess.run(codex.fork_command(thread, model), input=ASK_PREFACE + question, capture_output=True,
                           text=True, cwd=cwd, env=env, timeout=ASK_TIMEOUT_S, start_new_session=True)
    except subprocess.TimeoutExpired:
        raise SessionError(504, "timeout", f"No answer after {ASK_TIMEOUT_S} s.") from None
    except OSError as e:
        raise SessionError(500, "spawn_failed", f"Codex could not start: {e}") from None
    answer, failure = "", ""
    for line in p.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        item = ev.get("item")
        if ev.get("type") == "item.completed" and isinstance(item, dict) and item.get("type") == "agent_message":
            answer = str(item.get("text") or "").strip()
        elif ev.get("type") in ("turn.failed", "error"):
            err = ev.get("error") if isinstance(ev.get("error"), dict) else {}
            failure = str(err.get("message") or ev.get("message") or "")
    if p.returncode != 0 or not answer:
        detail = failure or (p.stderr or "").strip()[-300:] or f"exit code {p.returncode}"
        raise SessionError(502, "ask_failed", f"The side question failed: {detail}")
    return {"answer": answer, "agent": "codex", "cost_usd": 0.0, "duration_ms": int((time.time() - t0) * 1000)}
