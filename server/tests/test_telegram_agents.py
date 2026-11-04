"""Telegram: starting a Codex session or a Claude Code + Codex discussion (/codex, /discuss), the Codex sign-in
check, /model and /status of those sessions, and the pause of a discussion. Everything runs against the local fake
Bot API and a fake `codex` command (only `codex login status` is ever run): no network, no model request."""
from __future__ import annotations

import asyncio
import sys

import httpx
import pytest

from _conn_helpers import (TG_TOKEN, FakeService, FakeTelegram, FakeWorkspace, bare_app,  # noqa: F401
                           mx_state, wait_for)
from maxxing import config
from maxxing.api import telegram as tg_api
from maxxing.sessions import service as real_service, store as real_store  # noqa: F401 - before the fakes
from maxxing.telegram import gateway

TOPIC = "projects/acme/topics/blog"


def _fake_codex(tmp_path, signed_in: bool) -> str:
    """A `codex` whose `login status` says signed in (exit 0) or not (exit 1)."""
    p = tmp_path / ("codex-in" if signed_in else "codex-out")
    p.write_text("#!/bin/sh\n# fake Codex CLI: only `codex login status` is run by these tests\n"
                 f"exit {0 if signed_in else 1}\n")
    p.chmod(0o755)
    return str(p)


@pytest.fixture(autouse=True)
def codex_signed_in(tmp_path, monkeypatch):
    """Never the real Codex CLI: every test starts with a signed-in fake."""
    monkeypatch.setenv("MAXXING_CODEX_BIN", _fake_codex(tmp_path, True))


@pytest.fixture
def tg(mx_state, monkeypatch):
    fake = FakeTelegram()
    monkeypatch.setenv("MAXXING_TELEGRAM_API", fake.url)
    yield fake
    fake.close()


@pytest.fixture
def svc(monkeypatch):
    s = FakeService()
    monkeypatch.setitem(sys.modules, "maxxing.sessions.service", s)
    return s


@pytest.fixture
def ws(mx_state, monkeypatch):
    w = FakeWorkspace(mx_state / "ws", [("acme", "blog")])
    monkeypatch.setitem(sys.modules, "maxxing.workspace", w)
    return w


@pytest.fixture
async def api(tg, svc, ws, monkeypatch):
    monkeypatch.setattr(gateway, "_hooks", False)
    app = bare_app(tg_api.router)
    await tg_api.startup()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c
    await tg_api.shutdown()


async def _link(api, tg) -> None:
    assert (await api.post("/api/telegram/token", json={"token": TG_TOKEN})).status_code == 200
    link = (await api.post("/api/telegram/link")).json()
    tg.message(f"/start {link['code']}")
    await wait_for(lambda: gateway.link_status()["linked"], what="link")
    await wait_for(lambda: len(gateway.tg_config()["threads"]) == 3, what="threads")


async def _open(api, svc, title: str = "Plan") -> tuple[str, int]:
    sid = svc.create_session(TOPIC, title=title, source="web")["id"]
    assert (await api.post("/api/telegram/sync")).status_code == 200
    tid = gateway.thread_of(sid)
    assert tid
    return sid, tid


def _by_title(svc, title: str) -> str:
    return next(k for k, v in svc.sessions.items() if v["title"] == title)


async def test_codex_session_from_a_session_thread(api, tg, svc):
    """/codex in a session thread: a Codex sibling in the same topic, with its own thread, that talks to Codex."""
    await _link(api, tg)
    first, thread = await _open(api, svc, "Main")
    tg.message("/codex Review the API", thread=thread)
    await wait_for(lambda: any(v["title"] == "Review the API" for v in svc.sessions.values()), what="/codex")
    sid = _by_title(svc, "Review the API")
    s = svc.sessions[sid]
    assert s["provider"] == "codex" and s["path"] == TOPIC and s["source"] == "telegram"
    assert svc.sessions[first]["provider"] == "claude"
    tid = gateway.thread_of(sid)
    assert tid not in (None, thread) and tg.topics[tid] == "acme/blog · Review the API"
    await wait_for(lambda: any(p.get("message_thread_id") == tid and p["text"] == "Codex session: write your message here."
                               for p in tg.sent()), what="ready")
    assert any(p.get("message_thread_id") == thread and "acme / blog · Codex" in p["text"] for p in tg.sent())
    # the thread is the Codex session's
    tg.message("Look at the routes", thread=tid)
    await wait_for(lambda: svc.sent, what="message")
    assert svc.sent[0]["sid"] == sid and svc.sent[0]["source"] == "telegram"
    n = len(tg.sent())
    svc.finish(sid, "Two routes lack a check")
    await wait_for(lambda: len(tg.sent()) > n, what="answer")
    assert tg.sent()[-1]["message_thread_id"] == tid and tg.sent()[-1]["text"] == "Two routes lack a check"
    # /model leaves a Codex session's model alone (a Claude id would break its turns), the keyboard too
    tg.message("/model opus", thread=tid)
    await wait_for(lambda: any("only changes the model of Claude Code" in p["text"] for p in tg.sent()), what="/model")
    tg.message("/model", thread=tid)
    await wait_for(lambda: len([p for p in tg.sent() if "only changes the model" in p["text"]]) == 2, what="/model kb")
    tg.callback("m:claude-opus-5-5", thread=tid)
    await wait_for(lambda: any(p.get("text") and "only changes" in p["text"] for p in tg.sent("answerCallbackQuery")),
                   what="model callback refused")
    assert svc.sessions[sid]["model"] == ""
    assert not any(p.get("reply_markup") and p.get("message_thread_id") == tid for p in tg.sent())
    # /status names the agent
    tg.message("/status", thread=tid)
    await wait_for(lambda: any("Agent: Codex" in p["text"] for p in tg.sent()), what="/status")
    # /new in the Codex thread: Claude Code again (the default)
    tg.message("/new Notes", thread=tid)
    await wait_for(lambda: any(v["title"] == "Notes" for v in svc.sessions.values()), what="/new")
    assert svc.sessions[_by_title(svc, "Notes")]["provider"] == "claude"


async def test_codex_from_the_main_chat_asks_where(api, tg, svc):
    """/codex in the main chat: the "where?" question names Codex, survives in new.json, the session is Codex's."""
    await _link(api, tg)
    tg.message("/codex")
    await wait_for(lambda: any(p.get("reply_markup") for p in tg.sent()), what="where?")
    q = next(p for p in tg.sent() if p.get("reply_markup"))
    assert q["text"] == "Where should this Codex session live?" and q.get("message_thread_id") is None
    assert config.read_json(gateway._new_path())["0"]["provider"] == "codex"     # kept over a restart
    tg.message("Fix the login form")
    await asyncio.sleep(0.2)
    assert not svc.sent and not svc.sessions                  # kept until the topic is chosen
    tg.callback(f"w:0:{gateway._path_hash(TOPIC)}")
    await wait_for(lambda: svc.sent, what="session")
    sid = svc.sent[0]["sid"]
    s = svc.sessions[sid]
    assert s["provider"] == "codex" and s["path"] == TOPIC and svc.sent[0]["text"] == "Fix the login form"
    assert s["title"] == "Fix the login form" and svc.auto_titles == [sid]
    edits = [p["text"] for p in tg.sent("editMessageText")]
    assert any("acme / blog · Codex" in e and "continue in the thread" in e for e in edits)


async def test_agent_changed_before_the_topic_is_chosen(api, tg, svc):
    """A message asks "where?" for Claude Code; /discuss before the answer makes it a discussion (6 replies)."""
    await _link(api, tg)
    tg.message("Which database should we use?")
    await wait_for(lambda: any(p.get("reply_markup") for p in tg.sent()), what="where?")
    assert next(p for p in tg.sent() if p.get("reply_markup"))["text"] == "Where should this session live?"
    tg.message("/discuss")
    await wait_for(lambda: any(p["text"].startswith("Claude Code + Codex it is.") for p in tg.sent()), what="agent set")
    assert len([p for p in tg.sent() if p.get("reply_markup")]) == 1     # still one question
    tg.callback(f"w:0:{gateway._path_hash(TOPIC)}")
    await wait_for(lambda: svc.sent, what="session")
    s = svc.sessions[svc.sent[0]["sid"]]
    assert s["provider"] == "discussion" and s["discussion_turn_limit"] == gateway.DISCUSS_TURNS == 6
    edits = [p["text"] for p in tg.sent("editMessageText")]
    assert any("· Claude Code + Codex" in e and "pause after 6 replies" in e for e in edits)


async def test_codex_signed_out_or_missing_is_said(api, tg, svc, tmp_path, monkeypatch):
    """Codex not signed in, or not installed: the chat is told how to fix it and nothing is created or asked."""
    await _link(api, tg)
    first, thread = await _open(api, svc, "Main")
    monkeypatch.setenv("MAXXING_CODEX_BIN", _fake_codex(tmp_path, False))
    tg.message("/codex")
    await wait_for(lambda: any("not signed in" in p["text"] for p in tg.sent()), what="signed out (main chat)")
    told = next(p for p in tg.sent() if "not signed in" in p["text"])
    assert "<code>codex login</code>" in told["text"] and "/codex again" in told["text"]
    assert not any(p.get("reply_markup") for p in tg.sent()) and gateway.gateway()._new == {}
    tg.message("/discuss Compare", thread=thread)
    await wait_for(lambda: any("not signed in" in p["text"] and p.get("message_thread_id") == thread
                               for p in tg.sent()), what="signed out (thread)")
    # not installed: no `codex` anywhere
    monkeypatch.delenv("MAXXING_CODEX_BIN")
    empty = tmp_path / "empty-path"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    tg.message("/codex", thread=thread)
    await wait_for(lambda: any("not installed" in p["text"] for p in tg.sent()), what="not installed")
    assert set(svc.sessions) == {first} and not svc.sent
    # a message written meanwhile still starts a Claude Code session, as before
    tg.message("hello")
    await wait_for(lambda: any(p.get("reply_markup") for p in tg.sent()), what="where? for Claude")


async def test_codex_status_unknown_does_not_block(api, tg, svc, monkeypatch):
    await _link(api, tg)
    _, thread = await _open(api, svc, "Main")
    monkeypatch.setattr(gateway, "_codex_status", lambda: {"installed": True, "authenticated": None,
                                                           "reason": "status_unavailable"})
    tg.message("/codex Try", thread=thread)
    await wait_for(lambda: any(v["title"] == "Try" for v in svc.sessions.values()), what="created anyway")
    assert svc.sessions[_by_title(svc, "Try")]["provider"] == "codex"


async def test_discussion_from_telegram_pauses_on_its_limit(api, tg, svc):
    """/discuss: a Claude Code + Codex discussion with a 6-reply limit; its replies come to its thread, and the pause
    on the limit is said there."""
    await _link(api, tg)
    _, thread = await _open(api, svc, "Main")
    tg.message("/discuss Pick a cache", thread=thread)
    await wait_for(lambda: any(v["title"] == "Pick a cache" for v in svc.sessions.values()), what="/discuss")
    sid = _by_title(svc, "Pick a cache")
    assert svc.sessions[sid]["provider"] == "discussion" and svc.sessions[sid]["discussion_turn_limit"] == 6
    tid = gateway.thread_of(sid)
    await wait_for(lambda: any(p.get("message_thread_id") == tid and "pause after 6 replies" in p["text"]
                               for p in tg.sent()), what="ready")
    tg.message("Redis or memcached?", thread=tid)
    await wait_for(lambda: svc.sent, what="question")
    svc.finish(sid, "Redis, for its data types")             # Claude Code's first reply answers the message
    await wait_for(lambda: any(p.get("message_thread_id") == tid and "Redis, for its data types" in p["text"]
                               for p in tg.sent()), what="first reply")
    assert "<b>Claude Code</b>" in next(p for p in tg.sent() if "Redis, for its data types" in p["text"])["text"]
    # Codex's reply reaches the limit: the exchange pauses and the thread says how to go on
    svc.sessions[sid].update(debate_telegram=True, debate_paused=True, discussion_pause_reason="limit",
                             discussion_turns=6)
    svc.finish(sid, "Agreed, Redis", kind="debate")
    await wait_for(lambda: any(p.get("message_thread_id") == tid and "paused after 6 replies" in p["text"]
                               for p in tg.sent()), what="pause notice")
    mine = [p["text"] for p in tg.sent() if p.get("message_thread_id") == tid]
    assert "Agreed, Redis" in mine[-2] and mine[-1].startswith("⏸")
    tg.message("/status", thread=tid)
    await wait_for(lambda: any("Agent: Claude Code + Codex · 6/6 replies · paused" in p["text"] for p in tg.sent()),
                   what="/status")
    # a pause by the user (not the limit) says nothing more
    n = len(tg.sent())
    svc.sessions[sid].update(discussion_pause_reason="user")
    svc.finish(sid, "One more thought", kind="debate")
    await wait_for(lambda: len(tg.sent()) > n, what="reply")
    await asyncio.sleep(0.2)
    assert not any("paused after" in p["text"] for p in tg.sent()[n:])


async def test_threads_off_codex_and_discussion(api, tg, svc):
    """Threads off: /codex and /discuss make the topic's new Telegram session, which the main chat then talks to."""
    tg.topics_enabled = False
    await api.post("/api/telegram/token", json={"token": TG_TOKEN})
    code = (await api.post("/api/telegram/link")).json()["code"]
    tg.message(f"/start {code}")
    await wait_for(lambda: gateway.load_state().get("topics_enabled") is False, what="threads off")
    tg.message("/codex Research")
    await wait_for(lambda: (gateway.tg_config().get("sessions") or {}).get(""), what="/codex")
    sid = gateway.tg_config()["sessions"][""]
    assert svc.sessions[sid]["provider"] == "codex" and svc.sessions[sid]["title"] == "Research"
    await wait_for(lambda: any("New session: <b>Research</b> · Codex" in p["text"] for p in tg.sent()), what="said")
    tg.message("first question")
    await wait_for(lambda: svc.sent, what="message")
    assert svc.sent[0]["sid"] == sid
    tg.message("/discuss")
    await wait_for(lambda: gateway.tg_config()["sessions"][""] != sid, what="/discuss")
    duo = gateway.tg_config()["sessions"][""]
    assert svc.sessions[duo]["provider"] == "discussion" and svc.sessions[duo]["discussion_turn_limit"] == 6
    await wait_for(lambda: any("· Claude Code + Codex" in p["text"] and "pause after 6 replies" in p["text"]
                               for p in tg.sent()), what="discussion said")


def test_the_real_service_takes_the_telegram_arguments(client, topic):
    """What the gateway passes for each agent is accepted by sessions.service (no message: no turn is run)."""
    for provider in gateway.NEW_COMMANDS.values():
        s = real_service.create_session(topic, source="telegram", title=provider, plan_mode=False,
                                        **gateway._agent_kw(provider))
        assert s["provider"] == provider and s["source"] == "telegram" and s["state"] == "idle"
        assert s["discussion_turn_limit"] == (6 if provider == "discussion" else None)
        assert gateway.agent_name(s) == gateway.AGENTS[provider]


async def test_help_and_menu_list_the_agents(api, tg, svc):
    await _link(api, tg)
    menu = next(p for m, p in tg.calls if m == "setMyCommands" and p.get("language_code") is None)
    names = [c["command"] for c in menu["commands"]]
    assert names[:3] == ["new", "codex", "discuss"]
    tg.message("/help")
    await wait_for(lambda: any("/codex [title]" in p["text"] for p in tg.sent()), what="/help")
    text = next(p for p in tg.sent() if "/codex [title]" in p["text"])["text"]
    assert "/discuss [title]" in text and "new Claude Code session" in text
    assert not svc.sessions
