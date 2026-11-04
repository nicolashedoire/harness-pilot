# Internal interfaces (between server modules)

Python modules call each other only through these functions. Keep signatures stable.

## maxxing.workspace  (owner: core)
- `topic_dir(path: str) -> Path` - validates a topic path (relative to the workspace, "" = root), raises ValueError.
- `list_topics() -> list[dict]` - `[{path, project, name, description}]` (projects/<p>/topics/<t>).
- `create_project(name, description="")`, `create_topic(project, name, description="")` -> dicts of API.md.
- `on_change(cb)` - `cb()` or `cb(change)` (sync or async) called after any project/topic create/update/
  rename/delete; `change = {action:"created"|"updated"|"renamed"|"deleted", kind:"project"|"topic", path, old_path}`.
  A rename already remaps session paths, Claude transcripts and `telegram.threads/sessions` keys.
- `project_emoji(project) -> str`, `set_project_emoji(project, emoji)`, `check_emoji(value)` - one emoji per
  project in `projects/<p>/.maxxing.json` (moves with the folder; in `backup.ALWAYS`).
- `move_to_trash(path, label=None) -> Path` - shared trash (state_dir('trash'), `.json` sidecar with the origin).

## maxxing.sessions.service  (owner: core)
- `list_sessions(path: str | None = None, archived: bool | None = None) -> list[dict]` (API.md Session)
- `get_session(sid) -> dict | None`
  Both read metas through `store.read_cached(sid)` (parsed meta kept per file (inode, mtime_ns, size); shared
  dict, never mutate it).
- `create_session(path, message=None, title=None, model=None, attachments=None, source="web",
                   notify=False, cron=False, env=None, timeout_s=None, auto_title=False) -> dict`
   `env` = extra environment for the turn (dict), `timeout_s` = max turn duration (stop after). `auto_title`: the
   caller made `title` from the first message (Telegram) - it is shortened like a missing title (sessions.titles).
- `send_message(sid, text, attachments=None, source="web") -> {"queued": bool, "session": dict}`
- `stop(sid) -> None` - signals the meta `pid` only while a runner holds the session's run lock
  (`store.runner_alive(sid, {})`): a dead runner's pid may belong to another process. `_enqueue` resets `pid` to
  None when it spawns a runner. The runner clears its stop / steer flags inside `_pop`'s locked edit, so a signal
  sent for the turn it just popped is never wiped.
- `read_events(sid, offset=0) -> (list[event], next_offset)` - normalised events (API.md).
- `end_offset(sid) -> int` - offset after the last complete line of the log (where the next turn's events start).
- `read_back(sid, end=None, limit=200) -> {events, start, next, more_before} | {reset: True}` - backward
  reading (tail / "show earlier"), never loads the whole log. `offset_valid(sid, offset)`, `log_ident(sid)`
  (inode, size) detect a rewritten log; `meta_ident(sid)` (inode, mtime_ns, size) of the meta file lets the
  session stream skip reading anything on quiet ticks. `compact_log(sid, dry_run=False)` clips an existing log (sessions/clip.py: tool outputs, `system/init` reduced
  to `INIT_KEEP`, `DROP_SUBTYPES` lines removed - the runner applies the same at write time).
- `last_assistant_text(sid) -> str`
- `on_session_stop(cb)` - `cb(session: dict)` (sync or async; the same callback registered twice is kept once) on the
  event loop when a session stops running: running -> idle | error seen across passes, turns that ran (or failed to
  start) between two passes, or ended while the server was down (first pass, same rule as below). `session` = API
  Session + `last_turn` + `discussion_elapsed`. `_scan(primed, stops=None)` appends them to `stops` (the watcher
  passes a list; tests may call `_scan(primed)` as before). Used by `sessionfeed.on_stop` (registered by
  `api/feed.startup`). `resume_debate`, a message to a paused discussion (`_enqueue`), `stop` and `delete_session`
  resolve the session's `discussion.paused` feed event (`_resolve_paused`, never raises).
- Discussions (provider `discussion` / `debate`): `pause_debate(sid)`, `resume_debate(sid)`,
  `update_discussion(sid, turn_limit=UNSET, duration_s=UNSET) -> Session` (PATCH /discussion: `UNSET` keeps, `None`
  removes; `SessionError 400 unsupported|bad_limit`, same ranges as `create_session`). Meta of the current period:
  `discussion_turns`, `discussion_elapsed` (+ `discussion_started` while it runs), limits `discussion_turn_limit` /
  `discussion_duration_seconds`; `_limit_reached(m)` compares them. A limit pause (set by the runner's
  `_debate_followup`) resets the counters on resume / a new message only while `_limit_reached` is still true.
  `discussion_paused_at` (time.time()) is set by `pause_debate` (when it was running) and by the runner's limit pause,
  and dropped wherever `debate_paused` turns false (resume, `_enqueue`, `stop`, the runner on an error / empty answer).
- `on_turn_end(cb)` - `cb(session: dict, result: dict | None)` is awaited/called on the event loop when a
  turn of ANY session finishes, whatever started it (web, Telegram, cron). Fired per turn (the turn counter
  grows, or running -> error); turns ending within the same scan are reported once. The watcher is woken by any
  meta change (`sessions/wake.py`: one inotify watch of the sessions folder through `watchfiles`, which also wakes
  the session SSE streams; `MAXXING_INOTIFY=0` or no inotify: the old polling, 0.25 s while a session runs) and
  passes at least every 2 s while a session runs, every 1 s otherwise. `result` = last
  normalised `result` event of the turn (None if the turn produced none). The watcher stamps its last pass in
  `<state>/session-watcher.json` `{at}` (after its first pass, at once after reporting, and at most every
  `PASS_STAMP_S` = 5 s after passes that saw a session change; no fsync): its first pass
  after a start reports the turns whose `finished_at` is later (they ended while the server was stopped or
  restarting); without that file (first start) the first pass is only a baseline.
- `wait_turn(sid, timeout_s) -> dict` - blocking helper (thread) used by `pilot cron run`: returns the
  Session once it is not running and its queue is empty (or when the timeout expires).
- `move_session(sid, path)` (also `update_session(..., path=)`) - another topic for an idle session; moves the
  Claude transcript (`~/.claude/projects/<slug of cwd>/<csid>.jsonl`) so `--resume` keeps the conversation.
  Session meta also has `favorite` (Favorites block, copied by `handoff`).
- `handoff(sid)` creates the continuation with meta `handoff_pending` (time.time()): while it is younger than
  `HANDOFF_HOLD_S` (600 s), `_enqueue` queues messages without starting a runner (`queued: true`). The old
  session's runner (`Runner._handoff` -> `_start_target`) drops the flag, puts the summary seed at the HEAD of the
  queue and starts the runner; a failed or stopped summary drops the flag and starts the queued messages. The session
  watcher (`_scan`) calls `release_handoff(sid)` for a continuation whose hold expired with messages queued (the
  summary never came: its runner died).
- Also: `update_session`, `delete_session`, `clear_queue`, `compact`, `handoff`, `mark_seen`, `search(q)`,
  `models()`, `uploads_dir(path)`. Blocking functions raise `SessionError(status, code, message)`.
- Compaction in the runner (`sessions/runner.py`): `_auto_compact` after a turn above `auto_compact_tokens`; idle
  compaction in `_pop` - `_idle_compact(meta, item, cfg, now)` returns `(away, k_tokens)` when a `user` item (not
  cron/system source, steer, plan approval) pops for a non-fresh, non-cron session whose last call
  (`max(finished_at, cache_at)`; `cache_at` = last side question, it warms the thread too) is older than
  `idle_compact_after_s` with `context_tokens >= max(idle_compact_tokens, IDLE_COMPACT_MIN)`, unless
  `context_tokens - base_tokens` (meta `base_tokens` = context of the first call of the current thread, i.e. its
  fixed part) is under half of that threshold - a summary would save nothing. The message goes back
  to the queue head marked `held: true` (removed when it pops) and a `compact` item (`auto`, `idle`) runs first; `_post`
  then puts the seed into the message as `preface` (prepended by `build_prompt`, not displayed) instead of a separate
  seed turn. `service.stop` keeps `held` items: a Stop cancels the summary only, the message then runs.
- Smart resume (`sessions/resume.py`, config `smart_resume_tokens`, 0 = off): in `_take` (under the session lock),
  `resume.candidate(meta, head, cfg, now)` (same exclusions as idle compaction, plus `held`; pause >= `MIN_PAUSE_S`
  300 s; context >= max(threshold, 20k); cache expired, or context >= `WARM_FACTOR` (2) x threshold; not mostly
  `base_tokens`) says whether a summary goes first. If so the idle-compaction mechanics run (`held` + `compact` item)
  with `resume.summary_prompt(message)` instead of `SUMMARY_PROMPT`: the summary is written for the waiting message.
  Otherwise `_idle_compact` (plain summary) as before.
- Discussion compaction (provider `discussion` / `debate`): `_debate_followup` sets meta `discussion_compact_due` (`{tokens, agent}`) when `_debate_due(attempt, cfg)` - Claude's `context_tokens` >= min(max(`auto_compact_tokens`, `AUTO_COMPACT_MIN`), `DEBATE_COMPACT_RATIO` x context window) - or, for a turn refused with `_context_overflow` (`CONTEXT_OVERFLOW` on the error, stderr or an error `result`), `{overflow: agent}` and puts the popped item back at the queue head with `debate_retry: true` (once; no second `mx_user` line). `_take` then inserts a `compact` item (`DEBATE_SUMMARY_PROMPT`, `auto`) before the next `user`/`debate` item (a `user` one `held`) and writes `_debate_due_note`. `turn` sends a discussion's `compact` item to `_debate_compact`: Claude, `--permission-mode plan`, a new `--session-id` (never the agents' threads), prompt = request + `_debate_transcript(log, discussion_compacted_at)` (user messages and each turn's last assistant text with its agent, summary turns skipped, last `DEBATE_TRANSCRIPT_MAX` chars of the last `DEBATE_LOG_TAIL` bytes) + the previous `discussion_summary`. On success: new `csid` + `fresh`, `codex_thread_id` dropped, `discussion_summary` (`DEBATE_SUMMARY_MAX`), `discussion_compacted_at`, due flag cleared; an agent whose thread is fresh (Claude `fresh`, Codex without `codex_thread_id`) gets `SEED_DEBATE` as preface. `_pop` lets a `compact` head run while the discussion is paused (`service.compact`).
- A successful turn of a `cron=True` session archives it; a message from the web/Telegram clears the flag.


## maxxing.sessions.teams  (owner: core) - mixed Claude + Codex teams
API: `/api/teams*` (API.md). A team is three ordinary sessions of one topic, each stoppable on its own: a Claude
coordinator (the parent, returned by `create`) and two workers, `claude` and `codex`, in `permission_mode='plan'`.
- State: coordinator meta `team: {phase, goal, attachments, agents: [{id, provider, role, stopped}], created}`, worker meta
  `team_parent: <coordinator id>`; the Session JSON exposes `team_phase`, `team_parent` and `team_turn`
  (`service._team_turn`). Phases: `launching` -> `working` -> `synthesizing` -> `completed`, or `stopped` / `error`.
- `create(path, message, title=None, attachments=None)`: mission of 1-24 000 characters (else 400 `bad_mission`),
  attachments checked by `service._check_attachments` (400 `bad_attachment`) before anything is created. Creates the
  coordinator then the workers, logs the mission and its attachments as the coordinator's `mx_user` line, then, inside the coordinator's
  `store.edit`, sets `team_parent` on each worker and sends it its role and the mission with the attachments (`source='team'`; asked not
  to edit files - an instruction, not an isolation boundary). A stop during the launch -> 409 `team_stopped`; any
  failure -> phase `error` (unless stopped) and the workers stopped.
- `get(sid)` -> `{id, phase, created, agents: [{..., state, session, started_at, finished_at, activity, report}]}`;
  `state` = `stopped` once the user stopped that worker, else the session's state (`missing` when it is gone). A
  session without a team -> 404 `not_found`. `activity` / `report` come from `_live_view`: the last `LIVE_TAIL`
  (128 kB) of the worker's log (`service._tail_events`), its latest turn (after the last `user` event), the last
  `ACTIVITY_MAX` (3) tool calls and texts, the first `REPORT_MAX` (600) characters of its last answer once it stopped.
  Cached per worker in `_live` (64 entries) on `(service.log_ident, running)`: the panel's polls re-read a log only
  when it changed.
- `stop_agent(sid, agent_id)`: only while `working` and that worker runs (else 409 `not_running`), marks it
  `stopped` and stops it alone. `stop(sid)`: phase `stopped`, running workers marked, every worker and the
  coordinator stopped. Both call `service.stop(..., _team_internal=True)`.
- Hooks in `service`: `send_message` refuses (409 `team_running`) a message to a coordinator whose team is launching,
  working or synthesizing, and to a worker of a launching or working team (`source='team'` = the team itself).
  `service.stop` on such a coordinator -> `teams.stop`, on a worker of a working team -> `teams.stop_agent`.
- `advance(sid)` / `advance_all()`: every pass of the session watcher (`service._watch`, in a thread), so a team
  carries on after a server restart. `launching` for more than 30 s -> `error`, workers stopped. `working` with no
  worker running -> one synthesis prompt with each report (`service.last_assistant_text`, 20 000 characters, or a
  placeholder for a stopped, failed or silent worker; reports are framed as untrusted observations) queued on the
  coordinator (`service._item(prompt, team['attachments'], 'team')`, the mission's attachments, state `running`, `_spawn`), phase `synthesizing`; skipped when
  the phase or the agents changed meanwhile (a concurrent stop: rebuilt on the next pass). `synthesizing` and the
  coordinator no longer running -> `completed` (idle with turns) or `error`.
- Notifications: a worker on its assignment (`team_turn`: `team_parent` set and no `last_turn` yet, or one whose
  `source` is `team`) raises none (`sessionfeed.record`, web `useDoneNotifier`); the coordinator's stop at the end of
  the synthesis is the team's one notice. A message the user sends a worker later is its own turn and notifies.
- Worker transcripts stay in their own sessions; the team never deletes them. Fixed roles, text missions only.

## maxxing.sessions.titles  (owner: core)
- `schedule(sid, current, message) -> Thread | None` - called by `create_session` when no title was given and the
  message is not empty; nothing when config `short_titles` is false (or env `MAXXING_SHORT_TITLES=0`, set by the
  tests). Daemon thread, at most two calls at a time.
- `first_message(sid, message) -> Thread | None` - called by `send_message`: a session created automatic-titled and
  without a message carries meta `title_auto` (= that title); the first message pops it and, if the title is still
  it and the switch is on, sets `provisional(message)` and schedules. Later messages: one cached meta read, no write.
- `refine(sid, current, message) -> str | None` - `heuristic(message)`, or `ask_claude(message) or heuristic(message)`
  with config `short_titles_model` (default false: a call per new session counts in the Claude plan), written under
  `store.edit` only if the title is still `current` (the provisional one), then `bus.invalidate("sessions")`.
- `ask_claude(message) -> str | None` - `claude -p --output-format json --model claude-haiku-4-5-20251001 --tools ""
  --no-session-persistence --strict-mcp-config --system-prompt …`, stdin = first 1000 chars, cwd
  `<state>/claude-titles`, env `spawn.claude_env(None, "default")`, timeout 30 s; answer through `clean()`.
- `heuristic(message) -> str` - first sentence, leading FR/EN filler removed, cut at 40 chars on a word.
- `provisional(message) -> str` - first 60 chars (+ "…"): the instant title, and the title when the switch is off.
- `pending(sid) -> bool` - a short title is being made (between `schedule` and the end of its thread) or meta
  `title_auto` is set: the Telegram sync waits for it (60 s at most) before creating the session's thread.
## maxxing.claude_auth  (stdlib only, also used by the runner)
- `record(ok, error=None, source="turn"|"test"|"check")` - outcome of a real call; `detect(text) -> str|None`
  finds a sign-in error; `status() -> {ok, method, detail, checked_at, error}` (GET /api/claude/status `auth`,
  health, doctor); `needs_check()` - no verification in the last 6 h (background check in api/claude.py).

## maxxing.auto_update
- Harness updates itself while nobody uses it. Off by default (config `auto_update`, Settings -> System -> Updates,
  `PUT /api/system/auto-update`, `auto_update` in GET /api/system/version). Loop started by `api/system.py`
  `startup()` (only the installed server: `claude_update.runs_here()`; first pass `MAXXING_AUTO_UPDATE_DELAY` s,
  default 900; one `tick(spawn)` every 30 min).
- `tick() -> off|not_on_branch|pending|busy|unavailable|up_to_date|needs_review|tried_recently|started`. Never on
  a detached HEAD (`on_branch()`: a branch under test, put there on purpose) nor while `customs.pending()` (a
  conflict or a rolled-back version waits for a person: not retried every day). Waits while `busy_reason()`: a
  browser holds `/api/stream` (`bus.browser_count()`, signed-in streams only), or `claude_update.busy_reason`
  (turn, queue, cron job, side question, last turn < 10 min ago), or the `maxxing-update` unit runs. Then
  `smartupdate.preflight()` (fetches): only the verdict "simple" with no upgrade note, no unsaved change and every
  customization "ok"/"included" goes on; anything else posts one notification per target (`needs_review`). One try per
  target per 24 h (`<state>/auto-update.json` `tried`); busy is checked again after the preflight. The update is
  `api/system._spawn_update(smart=False)`: the usual `pilot update` (rolls itself back when the new version does not
  start) without the Harness session of the Update button.

## maxxing.claude_update
- Claude Code updated while the server is idle (turns run with its own update check off: quiet start). Loop started by
  `api/claude.py` `startup()` (`start()`/`stop()`; only the installed server runs it - `runs_here()`: MAXXING_STATE is
  `/var/lib/claude-maxxing`, a dev server or a test copy of the state never updates the machine's CLI unless
  `MAXXING_CLAUDE_UPDATE=1`; off everywhere with `MAXXING_CLAUDE_UPDATE=0`, first pass after
  `MAXXING_CLAUDE_UPDATE_DELAY` s, default 600), one `tick()` every POLL_S (300 s) in `asyncio.to_thread`.
- `installed_version()` and `run_update()` run with `_env()`: `spawn.base_env()` without the quiet-start variable
  (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which turns off Claude Code's own update check), so the version the
  server installs is never skipped by it.
- `tick(now=None, force_check=False) -> "off"|"not_installed"|"unknown"|"up_to_date"|"unsupported"|"busy"|
  "failed_recently"|"updated"|"failed"`: registry read (`latest_version()` = `depcheck.claude_stable`, the npm
  `stable` dist-tag) at most every CHECK_EVERY_S (6 h); no `claude --version` between checks when nothing is pending.
  Newer, `install_method()` known (native `claude install <v>` / npm `npm install -g --prefix <p>`; else
  "unsupported"), `busy_reason()` None and the exclusive flock `<state>/.claude-update.lock` taken (a turn's runner
  holds it shared while its claude runs, `runner._claude_in_use(note)`, waiting at most UPDATE_WAIT_S = 7 min with an
  `mx_note` in the session, and a `warn` note when it gives up and starts anyway) -> `run_update(v)` (5 min
  timeout) then `installed_version()` again; a version that does not start is reinstalled back
  (`run_update(previous)`); unchanged version = failure. A failed
  version waits 6 h. Feed `system` item on success; on failure once per version (`dedupe`).
- `busy_reason(now=None) -> str|None`: a session `running`, a queue on a session not in `error`, an `aside`
  question, a cron lock held (`crons.is_running`), or the newest `finished_at` less than IDLE_AFTER_S (600 s) ago.
- State `<state>/claude-update.json`; `public()` = GET /api/claude/status `auto_update`; config `claude_auto_update`.
- Off by default (config `claude_auto_update` false). Tests monkeypatch `installed_version`, `latest_version`,
  `run_update`, `install_method` (never a real update).

## maxxing.telegram.gateway  (owner: connectivity)
- `alert(text, loud=False)` - sign-in alerts thread (no-op when not configured). Thread-safe.
- `notify_topic(path, text)` - message in the main chat (topics have no thread; sessions do).
- Thread names: `session_label(s)` = `"[<emoji> ]<project>/<topic> · <title>"`, `topic_label(path)` =
  `"[<emoji> ]<project> / <topic>"` ("Where?" buttons, messages).
- Session threads: `config.telegram.session_threads[sid] = {tid, name}`, kept in sync by
  `sync_threads_with(call, probe)` (open sessions = `open_sessions()`: human, not archived, active in
  the last `thread_days` days, <= MAX_THREADS); triggered by the bus topic "sessions" (`bus.subscribe`)
  and every RECONCILE_EVERY s. Older layout (one thread per topic) migrated by `_migrate_topic_threads`.
  Telegram has no silent "does this thread exist" call (editForumTopic without a change succeeds on
  a deleted thread; with the same name it posts a service message): deleted threads are found on
  the next send / rename (`_forget_thread` / `_thread_gone`) and are reopened (`Gateway.reopen_thread`).
  A session that left the list keeps its mapping when `deleteForumTopic` fails for a transient reason: network
  errors and 429 stop the pass, 5xx skip the session; both are retried at the next sync. Success, `_thread_gone`
  and other 4xx (no right to manage topics, bot removed) drop it (a refusal is not retried at every sync).
  `mirror_web()` (opt-in: `mirror_web` and `mirror_web_chosen`): `on_turn_end` without a pending Telegram turn copies the web turn into the thread
  (`service.last_user_message` + the answer, silent unless `notify`).
- `notify_cron(text)` - plain message in the "Crons" thread. `notify_cron_report(header, body, markdown, loud)` - a
  cron run's report: bold header + the Claude answer rendered by `fmt.render` (from its start, `fmt.head` at
  `REPORT_MAX` = 12000) or command output in `<pre>` (`fmt.code`); body packed with room for the header.
- `status() -> dict` - the GET /api/telegram payload.
- `start()/stop()/restart()` (async, server loop) and `install_hooks()` (registers
  `sessions.service.on_turn_end` + `workspace.on_change`), called by maxxing.api.telegram.
- Uses from sessions.service: `create_session`, `get_session`, `list_sessions`, `send_message`, `stop`,
  `update_session(sid, model=…)` (/model), `read_events` / `end_offset` (progress mode), `last_assistant_text`, `models()`.
  These are called from worker threads (`asyncio.to_thread`) and must be thread-safe.
- `telegram.reviews` (companion decisions): `buttons(ev)` gives a built-in `companion.ready` event (source `system`,
  params `session_id` + 64-hex `fingerprint`; the companion kinds are reserved against external producers) Review and
  Discuss buttons, `c:<feed id>:<v|a|r|d>`. `handle()` runs after `_on_callback`'s linked-owner check (linked private
  chat and owner user id), re-reads `companions.review` and refuses a running or changed proposal (fingerprint other
  than the event's), an already decided one, and a binary one or one whose complete text (Git patch + new files as
  `+` lines) exceeds `MAX_REVIEW` (12000). Review sends that text as `<pre>` blocks, then Approve / Reject only when
  every part was delivered. A decision is `companions.decide(sid, value, <event fingerprint>)`: recorded, never
  applied, published or merged (a mission step's dependents may start, as after a web approval). Discuss reopens the
  session's thread (`reopen_thread`) without a model request; messages there follow the normal session path.

## maxxing.feed / maxxing.feedhooks  (owner: organisation)
- `feed.post(title, body="", level="info", source="custom", url="", dedupe=None, group=None, notify=True, *,
  kind="custom", params=None, actions=None, trusted=False) -> dict | None` (None = duplicate). Usable from any process
  (sqlite WAL `<state>/feed.db`); the server's `api/feed` watcher turns outside writes into the bus topic "feed".
  `trusted` = a built-in producer: reserved kinds (`KINDS` whose source is not ""), `post` actions (only
  `POST_ACTIONS`), params coerced instead of refused; external callers (API, CLI, webhooks) are not trusted
  (`clean_kind` / `clean_params(strict)` / `clean_actions(trusted, strict)` raise `FeedError 400 bad_kind|bad_params|
  bad_action`; feedhooks drops a generic payload's bad actions with `strict=False`).
  `notify=False` = a quiet event (CLI `--quiet`, API `quiet`): the new row gets `quiet = 1`, it is not sent to
  Telegram and `push.wants` refuses it (a fold never changes the flag of the row it grows).
  `feed.system(title, body, level, source, url, group, dedupe, *, kind, params, actions)` = trusted post that never
  raises (built-in events: `crons._feed`, `sessionfeed`, `health._to_feed`, `cmd_core.notify_update` / `_notify`,
  `auto_update`, `smartupdate.after_update`, `claude_update`, `deps` / `cmd_deps`, `backup` restore, `twofactor`,
  `api/auth._alert`, `feedhooks`, `infra._alerts` and `api/tasks.check_reminders` (trusted `feed.post`)). `feed.link(id, label, url)` /
  `feed.post_action(id, label, url)` build actions. Every built-in kind is in `feed.KINDS` (kind -> (source, level))
  and documented with its params in API.md.
- Schema: columns `kind, params (JSON), actions (JSON), resolved_at, first_at, occurrences (JSON, <= 20)` were added
  after 2.0.0a108, `quiet` (0 / 1) after them: `_migrate` (run once per process on first open, under `_lock`) adds the missing ones with
  `ALTER TABLE` (a "duplicate column" from a concurrent process is ignored) and the index `events_grp(source, grp)`.
  Old rows: kind "custom", `{}` / `[]`, `first_at` = `at`, not quiet. A fold (`group`) only matches an unread, unresolved row of
  the same level younger than 24 h and pushes the previous state into `occurrences` (seeded with the row itself).
- `feed.resolve(source, group) -> int` (warning / error rows of that group not yet resolved get `resolved_at`;
  `system_resolve` = never raises), `resolve_ids(ids) -> pending count`. Groups used: `failed:<cron id>`,
  `session:<sid>`, `discussion:<sid>`, `hook-secret-<hook id>`, `health:<issue id>`, `down:<resource id>`,
  `claude-update-failed`, `task:<task id>`.
- `feed.list_events(source, unread, before, limit, *, category, kind, pending)` + `counts()` (`{unread, pending,
  sources, categories, kinds}` from `_aggregate(c, cutoff)` = one row per (source, kind), cached per feed.db / WAL
  stamp and minute: `_groups()`), `source_counts()`, `pending_count()`, `get(id, detail=False)`, `category(source)`,
  `new_since(after_id, limit)` / `max_id()` (push), `last_id()` / `watch_id()` -> `(max id, sum read, sum count,
  resolved count)` tuple (changes on posts, folds, reads, resolutions).
- `feed.rule_for(source, level, s=None, kind=None)` (kind rule, else source rule, else `default_rule`), `event_kinds(s)`
  (rows of the settings matrix), `settings()` / `save_settings(telegram, rules, hooks, kind_rules)` (config `feed`:
  `rules`, `kind_rules`, `telegram`, `hooks`).
- `feedhooks.create/update/remove/test`, `deliver(token, headers, body) -> (status, json)`, parsers per kind
  (`PARSERS`: `(title, body, level, url, dedupe[, kind, params])`); tokens + secrets in secrets.json `feed_hooks`.
  `SIGNED_KINDS` (stripe, shopify, github) need a secret to accept deliveries (`401 secret_required`, feed.system
  `webhook.refused` warning grouped `hook-secret-<id>`, resolved by `update` with a non-empty secret and by `remove`);
  creating one without a secret stays allowed (Stripe shows its whsec only once the endpoint URL exists).
  `BODY_DEDUPE` (shopify, github): their delivery-id headers are not covered by the signature, so `deliver` replaces
  the parser's dedupe with `_replay_key` = `sha256:<topic>:<sha256(body)>` (Shopify: a known topic of
  `_SHOPIFY_TOPICS`, else `other`; GitHub: no topic). Stripe signs a timestamp (5 min tolerance) and keeps the event
  id. `feed.post` turns the unique-index `IntegrityError` of a concurrent identical dedupe into a duplicate (None).
- Telegram `Gateway.authorized(chat, user)`: chat == `telegram.chat_id` AND user in `telegram.user_ids` (an empty
  list authorizes nobody; `_try_link` always records the linking account and refuses a message without `from`).
- Telegram: `gateway.feed_notify(ev, loud)` / `feed_message(ev)` (body cut at 700 characters BEFORE HTML escaping); thread key `#feed` (`NOTIFY_ONLY` = Crons, Alerts,
  Notifications: never treated as topic threads by the legacy migration); callback `f:<id>` = Ask Claude.

## maxxing.blocks / maxxing.api.blocks  (owner: organisation)
Conversation blocks (API.md#conversation-blocks). Stdlib only at import (`extensions` and `cmd_core` are imported
inside the functions that need them), so `sessions/codex.py` could read its output without it.
- `BUILTINS` (type, icon, category, hint, `fields` = the body summary given to the agents, `schema`, `raw` field for
  raw-text bodies, `pin`) is the source of the built-in schemas. Copies to keep in step (tests fail otherwise):
  `web/mock/blocks-builtins.json` (dev mock) and the type sets of `web/src/features/blocks/fence.tsx`.
- `check_schema(schema)` (raises ValueError on anything outside the subset) and `validate(schema, data, limit=20) ->
  [str]` (mirrors `features/blocks/schema.ts`, same messages).
- `parse_manifest(dir) -> dict` validates `block.json` (limits, renders, hosts, schema file, entry inside the folder).
  `extensions._load_one` calls it for a folder with `block.json` and no `manifest.json`: `Extension.type == "block"`,
  `Extension.block` = the manifest; never imported, never a widget. `extensions.on_change(fn)` listeners run after a
  rescan or an enable / disable (the blocks API registers `sync_agent_files`).
- `plugins(light=False)` (built-ins + block extensions with `enabled`, `error` - a type claimed twice -, `consent`),
  `get(id)`, `enabled_plugins()`, `set_enabled(id, on)` (config `blocks.disabled` or `extensions.disabled`).
  `light=True` reads the block.json files directly (CLI: install, doctor) instead of the extension registry.
- Consent: `set_consent(id, "always"|"once"|"deny"|"reset")` (config `blocks.consent`, or an in-memory grant token for
  one hour), `allowed_hosts(plugin, grant)`, `frame_csp(hosts)` (the frames' policy).
- `to_card(type, data, title)` / `pin(...)`: dashboard pins are plain widget extensions `pin-<slug>-<hex>` (manifest,
  `card.json`, fixed `api.py` returning it).
- Agents: `skill_vars(ps)` -> `{{PILOT_BLOCKS_TYPES}}`, `{{PILOT_BLOCKS_ENABLED}}`, merged into `cmd_core._skill_vars()`
  (install and `skills_status` render `skills/pilot-blocks/SKILL.md` with them); `sync_agent_files()` writes
  `<state>/blocks/agents.md` (Codex: `sessions/codex.workspace_context` appends it, the only hook in session code),
  `<state>/blocks/reference.md`, and renders the installed skill again (Claude's and Codex's copies) when it exists. Idempotent (files rewritten only
  on change); called by the API's startup, `GET /api/blocks`, `PATCH`, extension changes and `pilot init`. The
  user's CLAUDE.md files are never touched.
- `api/blocks.py`: the routes; `BRIDGE` / `APP_LOADER` (frame scripts; the dev mock reads them from this file).

## maxxing.sessionfeed  (owner: organisation)
- `on_stop(session)` (async, `sessions.service.on_session_stop` callback) -> `record(session)` in a thread: nothing for
  cron sessions, nor for a mixed-team worker on its assignment (`team_turn`: the coordinator's own stop is the team's
  one notice); a discussion / debate paused with `discussion_pause_reason == "limit"` -> `discussion.paused`; state
  `error` -> `session.failed`; else (unless the last turn was a summary: compact / handoff / seed) resolve
  `session:<sid>` and post `session.done`. Source `sessions` (in `feed.OWN_THREAD`: Telegram off by default).

## maxxing.push  (owner: organisation)
- Web Push (RFC 8030 / 8291 aes128gcm / 8292 VAPID) with `cryptography` (ECDH, ECDSA, AES-GCM; HKDF by hmac) and httpx.
  Blocking: call through `asyncio.to_thread`. `available()` (the library imports), `public_key()` (VAPID key made on
  first use: `<state>/push-vapid.json`, mode 600, under `ProcessLock("push")`), `vapid_header(endpoint)`,
  `encrypt(plaintext, p256dh, auth, *, salt=None, private_key=None)` (test vector of RFC 8291 appendix A in the tests).
- Subscriptions in `<state>/push.json` (mode 600, max 50): `subscriptions()`, `subscribe(endpoint, keys, label, prefs)`
  (upsert by endpoint), `update(id, label, prefs)`, `remove(id)`, `test(id)`; errors `PushError(status, code, msg)`.
  Prefs `{levels, sound, kinds: {kind: {enabled, sound}}, sources: {source: {enabled, sound}}}` (`_prefs`; `sources`
  checked by `_source_prefs`): `wants(prefs, ev)` (a quiet event: never; then the source's entry, the kind's entry, the
  level), `sound(prefs, ev)` (the same entry's sound, else `prefs.sound`); `_entry(p, ev)` picks the entry.
- `prime()` (cursor = feed max id, at server start) and `dispatch()` (rows after the cursor, oldest first, at most 50
  per pass; one httpx client per pass; 404 / 410 drop the subscription, others stamp `last_ok` / `last_error`), called
  by `api/feed._watch` after each change of feed.db (any process). `payload(ev, silent)` <= `PAYLOAD_MAX` (3000 bytes:
  params, actions, body dropped in that order when too long). Tests set `push.http_transport` (httpx.MockTransport).

## maxxing.backup  (owner: connectivity)
- `run() -> dict`, `restore(ref=None) -> dict`, `restore_from(repo, token, ref=None)`, `status()`,
  `history(limit)`, `last_success_age_h() -> float | None` (health check).
- Schedules itself through maxxing.crons (`list_jobs/create_job/update_job/delete_job`, job name
  "Memory backup", shell command `<maxxing> backup run`).
- Restore on a server in use: the ids of the extensions whose code files (`.py .js .mjs .html .htm`) it will write
  are added to config `extensions.disabled` BEFORE any file is written, all inside `extensions.publishing()` (the
  lock `extensions.scan()` / `set_enabled()` hold while they check the flag and import: thread RLock + flock on
  `state/extensions.lock`, so the CLI restore and the server exclude each other); a restored `extensions` setting
  keeps them in its disabled list.

## maxxing.voice  (owner: connectivity)
- `settings() -> dict`, `update_settings(**kw)`, `status() -> dict` (GET /api/voice), `readiness() -> (ready, reason)`.
- `transcribe_file(path, language=None, engine=None) -> {text, language, duration_s, engine, model, ms}` - blocking
  (call through `asyncio.to_thread`): ffmpeg → 16 kHz mono WAV (`normalise`, max 15 min) → engine. One transcription
  at a time (process lock). Raises `VoiceError(status, code, message)`.
- Engines in `_ENGINES` (`local` = faster-whisper int8 CPU, lazy-loaded once, unloaded after 10 min idle; `groq` /
  `openai` = httpx multipart, Opus-compressed upload, keys from the vault). Tests replace `_ENGINES[...]`,
  `install_steps[...]` and `http_transport` (httpx.MockTransport).
- `start_install(model=None)` (background thread: `uv sync --frozen --no-dev --extra voice` in `server/`, then the model
  download in a child process; progress = size of `state_dir('voice/models/<m>')`), `download_model(name)`,
  `delete_model(name)`, `sync_extras()` (flags added by `pilot update` so the optional group survives updates:
  marker `state/voice/extra-installed` or engine `local`), `doctor()`.
- Used by maxxing.api.voice, maxxing.telegram.gateway (`_voice`), cmd_core (doctor, update), cmd_voice (CLI).

## maxxing.health  (owner: organisation)
- `collect() -> dict` - the GET /api/system/health payload (cached 30 s). Each evaluation (`_collect`) also calls
  `_to_feed(issues)`: a new warn / error issue (not `FEED_SKIP`: cron_failed, login_failures) -> one `health.issue`
  feed event grouped `health:<issue id>`, an issue gone -> resolved; `<state>/health-feed.json` {issue id: posted at}
  under `ProcessLock("health-feed")`. Never raises. No loop of its own: health is evaluated when asked (UI every 60 s,
  widgets, heartbeat).
- `services(force=False)` - GET /api/system/services: ONE `systemctl show <all units>` (blocks split on blank
  lines, matched by `Id`), cached 10 s; `invalidate_services()` after a start / stop / restart.

## maxxing.mediatools  (owner: organisation)
- `status() -> dict` - GET /api/system/media-tools: `ffmpeg` / `pdftoppm` from `shutil.which` on every call, `webp`
  from `ffmpeg -hide_banner -encoders` listing `libwebp` (`_encodes_webp`, lru-cached per binary path and mtime);
  `missing` in the order ffmpeg | ffmpeg_webp, pdftoppm; `install_commands(missing)`: Homebrew on `darwin`
  (`ffmpeg-full`, keg-only, which `scripts/dev-local.sh` puts first on the PATH when installed; `poppler`), one
  `sudo apt-get install -y` elsewhere. Never installs anything.
- `log_missing()` - one warning per missing tool plus the commands, called by `api/system.startup()` in local mode only
  (the terminal of dev-local.sh); `cmd_core.check_media_tools` is the doctor check `media_tools` (warn, never fail).

## maxxing.security (session cookie)
- Cookie `mx_session` = `<issued_at>.<nonce>.<hmac_sha256(cookie_key, "<issued_at>.<nonce>")>` (legacy
  `<issued_at>.<hmac>` from <= 2.0.0a31 still accepted), lifetime `COOKIE_MAX_AGE` = 30 days.
- `revoke_cookie(value)` (sign-out) stores `sha256(value)[:32] -> issued_at + COOKIE_MAX_AGE` in secrets.json
  `revoked_sessions`; expired ids are pruned on each sign-out. Past `REVOKED_MAX` (500) ids the list is dropped
  and `sessions_not_before = now + 1` is set instead (cookies issued earlier are refused). `set_password` rotates
  `cookie_key` and clears `revoked_sessions` and `device_key` (two-step sign-in: every browser asks again).
- Preview tokens (`api/filesite.py`) are signed with `cookie_key` and carry `i` (issue time) and `s` (session id):
  `read_token` refuses them when `s` is revoked or `i < sessions_not_before` (a token without `i` is refused).
- `StreamAuth(cookie).ok()`: the SSE streams' re-check before each frame (`bus.stream(cookie)`, `api/sessions._sse`):
  one stat of secrets.json while its (inode, mtime, size) is unchanged, else / every `RECHECK_S` (15 s) / past the
  cookie's expiry a full `cookie_valid`.
- `streamcap.py` (audit F01): both SSE endpoints answer through `stream_response(cookie, factory)`: a slot per
  sign-in (`security.session_id`) is taken before the body generator is created, `PER_SIGNIN` 24 / `TOTAL` 96, else
  `429 too_many_streams` + `Retry-After`; `CappedStream.__call__` gives the slot back however the response ends (also
  when the generator never started), a `weakref.finalize` if the response is never sent. `counts()` for tests.

## maxxing.bodylimit / maxxing.uploads (request bodies)
- `bodylimit.BodyLimit` (ASGI, outermost but the security headers): every non-multipart POST/PUT/PATCH/DELETE under
  /api/ is decided from its headers before the body is read - no valid cookie on a non-public route -> 401; public
  `/api/auth/*` -> CSRF header first, then `PUBLIC_MAX` (64 kB); `/api/hooks/*` -> `feedhooks.MAX_BODY`; signed in
  -> `DEFAULT_MAX` (1 MB) or the cap of the first matching `ROUTES` entry. `Content-Length` over the cap -> 413
  before reading; a chunked body is counted by the wrapped `receive()` (413 as soon as it goes over).
  `cap_for(method, path, authed)` is the table lookup. A route whose JSON grows past 1 MB must get a `ROUTES` entry.
- `uploads.UploadGuard`: multipart bodies (auth + CSRF, `upload_max_mb`, temp-dir room) - see API.md Conventions.

## maxxing.twofactor (two-step sign-in with Telegram)
- On = config `telegram.two_factor`; effective (`enabled()`) only with a token, a chat and its owner
  (`available()`). `gateway.forget()` and a new bot drop the flag. `set_on(False)` also calls `forget_devices()`.
- Challenges in memory (one server process): `start(purpose, ip, ua)` (blocking: Telegram `sendMessage` to the
  Alerts thread, HTML, buttons `a:<id>:y|n`; `Refused("throttled"|"two_factor_unavailable")`), `check(id, code)`
  (approved = consumed once; `CODE_TRIES` wrong codes kill it), `decide(id, allow)` from `Gateway._on_callback`
  (kind `a`, after `authorized()`). The message is edited (buttons removed, outcome added) in a daemon thread.
  `TTL` 120 s, `GRACE` 60 s to collect an approval, `NEW_MAX` 5 per client / 15 min, `PENDING_MAX` 10.
- Trusted browser: cookie `mx_device` = `<issued_at>.<nonce>.<hmac(device_key)>`, path `/api/auth`, 30 days;
  `forget_devices()` = `device_key` -> None (recreated on first use).
- CLI `pilot 2fa status|off|forget-browsers` (`cmd_twofactor.py`): the way back in when Telegram does not answer.

## maxxing.bus
- `invalidate(*topics)` - thread-safe UI invalidation (see API.md Global bus).

## maxxing.config
- `load_config()/update_config(**kw)/get_secret/set_secret/set_secrets (several in one write)/read_json/write_json/state_dir/workspace()`.
  `load_config()` keeps the merged result (pickled) while config.json's (inode, mtime, size, ctime) and the
  defaults are unchanged and returns a fresh copy each call (callers may change it); saves are atomic renames,
  so a write by any process is seen on the next call.
- `integrations_paused()`: config `integrations_paused`, set by an instance-backup restore and cleared by
  `instance_backup.resume_integrations()`. While true, `telegram.gateway._should_run()` and `_post()`,
  `crons.managed_lines()`, `localcron.tick()`, `api/tasks.check_reminders()`, scheduled `pilot cron run` (detached or
  `--if-due`) and `backup.run()` (code `paused`, not recorded in the history) do nothing.
- User secrets (Keys vault) live in secrets.json under `"vault": {name: {value, note, expose, updated}}`.
  `config.exposed_env()` (owner: organisation, in maxxing/vault.py) -> dict of secrets flagged `expose`,
  merged into every Claude turn's environment by the runner spawner (sessions/spawn.py currently reads the vault
  itself - same result) and into shell cron jobs.

## maxxing.themes
- `clean_theme(data) -> dict` - structural validation of a palette (Theme object, DESIGN.md "Themes"), the server
  mirror of `web/src/lib/theme/validate.ts`: unknown keys dropped, defaults filled, colours only (`is_color`), 16 KB
  at most; raises `ThemeError` (-> 422 `invalid_theme`). No colour maths: derivation and contrast stay in the browser.
- `legacy_theme(accent, tint, keep)` - the palette of a client from before palettes; `nearest_accent(theme)`.
- Used by `PUT /api/settings/look` (config `look` = `{theme, accent, tint, palette, rev}`, `rev` + bus `look` on a
  palette change) and `GET /api/auth/state`.
- Saved themes ("My themes"): `saved()`, `save_theme(theme, source, frm)` (validated, same colours = the existing
  entry, `ThemeLimit` past `SAVED_MAX` = 50), `rename_theme(id, name)`, `delete_theme(id)` (`ThemeNotFound`);
  `<state>/themes.json` (600, `{themes: [{id, theme, source, from, saved}]}`, atomic writes, `_saved_lock`, bus
  `themes`); an entry that no longer validates is skipped on read. Routes `/api/settings/themes*`.
- `latest_file(folder, since)` - the newest `*.theme.json` (folder or `folder/themes/`, mtime >= since, no symbolic
  link, read with `O_NOFOLLOW`, 16 KB at most) as `{theme, file, at}` through `clean_theme`: the theme generator
  (Settings -> Appearance -> Create, skill `skills/pilot-theme`) reads what its session wrote
  (`GET /api/settings/themes/session/{sid}`).
- `team.send_theme` / `team._remote_message` validate a theme sent in a chat (message `kind: theme`) both ways.

## maxxing.crons  (owner: organisation)
- `run_job(id) -> Run | None` (blocking; None = unknown or already running) · `spawn_run(id)` · `sync_crontab()`
- `list_jobs()`, `read_runs(cron_id=None, limit=50)`, `last_runs() -> {cron_id: Run}`, `parse/humanize/next_runs`.
  The run history is parsed once per file version (`_all_runs`, keyed on path + mtime + size); `read_runs`
  returns copies.
- While a job runs, its lock file (`<state>/crons/locks/<id>.lock`) holds `{"pid", "at", "pgid", "pgid_start"}`; a
  normal end empties it. A run killed before its end (SIGKILL, out of memory) leaves it: the next `run_job` kills the
  orphan job shell (`pgid`) when `_proc_start(pgid)` still equals `pgid_start`, records a failed Run (`code -9`,
  "interrupted: …") and reports it. `_proc_start`: `<boot id>:<start ticks>` from /proc (Linux), else (`BOOT_ID`
  unreadable: macOS) `_ps_start` = `ps:<ps -o lstart=, TZ=UTC LC_ALL=C>` (start to the second); None (never killed)
  when the process is gone or `ps` fails.
- Claude jobs call `sessions.service.create_session(..., source="cron", cron=True, env={MAXXING_CRON_ID, MAXXING_CRON_NAME},
  timeout_s)` (or `send_message` when `reuse_session`), then `wait_turn` + `last_result` + `last_assistant_text`.
- Job units: `spawn_run(id)` ("Run now", and `maxxing cron run <id> --detach` = what every managed crontab line calls)
  starts `python -m maxxing cron run <id>` in `systemd-run --collect --unit maxxing-cron-<id> --slice=maxxing-jobs.slice`
  + `memory_properties()` + `RuntimeMaxSec=<timeout_s + KILL_GRACE_S + 120>` (backstop if the run itself dies). The
  unit runs the job inline (`run_job`: per-job flock, no overlap; a second start while the unit exists ->
  `already_running`, exit 3). When the main process ends, systemd kills what the job left in the unit (default
  KillMode=control-group): background processes of a job end with it, as with "Run now" before. `units_available()`
  = not `MAXXING_SPAWN=direct`, `systemd-run` on PATH and `/run/systemd/system` (`SYSTEMD_DIR`); otherwise
  `--detach` runs the job in the cron process and "Run now" starts a detached subprocess.
- `maxxing-jobs.slice` (`cmd_core.ensure_jobs_slice`, called by every `pilot init`, so by every update; removed by
  uninstall): `/etc/systemd/system/maxxing-jobs.slice` with `MemoryMax=<jobs_memory_max>` (config, default `75%`;
  `""`/`infinity` = no line) = the memory budget of all jobs running at once; written only when the text changed
  (then daemon-reload); skipped without systemd and with MAXXING_SPAWN=direct. Claude jobs run their turn in a turn
  unit (outside the slice; capped by `unit_memory_max`), only the waiting `cron run` process is in the slice.
- Shell jobs: `bash -lc` in the workspace, env = os.environ + exposed vault + MAXXING_CRON_ID/NAME; exit 124 on timeout.
  Timeout (`_kill_group`): SIGTERM to the job's process group, then after `KILL_GRACE_S` (5 s) SIGKILL to the whole
  group unconditionally (bash may have exited while a child ignoring SIGTERM lives on; the group id cannot be reused
  while a member lives); early exit when bash is reaped and the group is empty. In a unit, processes that left the
  group (setsid) are killed by systemd when the run ends.
  Output: stdout+stderr into a pipe drained by a reader thread that keeps only the last OUTPUT_TAIL bytes (no temp
  file: /tmp is often a tmpfs); after the exit the reader gets 2 s (a background child may hold the pipe open).
- The managed crontab line is `<schedule> [MAXXING_STATE=…] MAXXING_CRON_DETACH=1 <maxxing> cron run <id> [--if-due]
  >/dev/null 2>&1`; `MAXXING_STATE=…` only when the state dir is not the default. The detach request is an environment
  variable, not a flag: a version restored by a rollback (a69 and older) does not know `--detach` and would refuse
  every line; it ignores the variable and runs the job inline. `cmd_cron` pops it (never inherited) and `spawn_run`
  never forwards it. `cron_keep_background` (true on installs that existed before a70) = scheduled runs stay inline
  (no unit: background programs live on, as in a69). `pilot init` re-syncs the block.
- `split_crontab`: a BEGIN marker without END (edited by hand) keeps only the ` cron run ` lines as managed; every other
  line after it stays the user's.

## maxxing.shopify  (owner: organisation)
- Built-in widget `shopify` (widgets.BUILTINS): `card(force)` -> connect card, error card, or figures; `fetch(store, token, since)`
  (Admin GraphQL `orders`, 250/page, ≤ 4 pages, cancelled orders skipped) and `build_card(data, today, tz)` are pure enough to test.
  Keys from the vault: `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN`. `MAXXING_SHOPIFY_API` overrides the base URL (tests, demo).

## maxxing.gitview  (owner: organisation)
Read-only git: `local_repos(refresh)` (walk of the files root, MAX_DEPTH 6, MAX_DIRS budget, PRUNE + dot folders,
8 threads of `summary()`), `resolve(path)` (inside the files root, climbs to the clone), `graph(path, limit,
branches)` (`git log --branches --remotes --tags HEAD --topo-order --decorate=full`), `commit(path, sha)`
(`--numstat --diff-merges=first-parent`); every git call: no shell, `-c safe.directory=*`, GIT_TERMINAL_PROMPT=0,
GIT_OPTIONAL_LOCKS=0, 10 s. GitHub (`_gh(path, params, tok)`, MAXXING_GITHUB_API): `tokens()` (vault values matching `GH_TOKEN_RE` under any name + GITHUB_TOKEN/GH_TOKEN + backup `github_token`, deduped by value), `github_repos` (per token /user + /user/repos ≤ 500, in parallel, merged by full name with the best permission, `keys`/`accounts`; fills `_access` = repo -> tokens best first; refused tokens in `errors`), `_gh_repo` (tries `_access` tokens then the rest, prefers not_found over bad_token),
`github_graph` (branches + commits per branch merged, `_topo` = children before parents, newest first),
`github_commit`, `github_pulls`. `overview()` joins clones and GitHub repos (`local_paths`). 60 s cache per
listing (`clear_cache()` in tests). Web: `features/git/` (GitGraph = lane layout + SVG, GitBlock = ```git in
`components/ui/markdown.tsx`, lazy; GitPage = route `/git`, shown in the nav by `useNav()` when settings `git_page`).

## maxxing.team  (owner: organisation)
Chats between people, `<state>/team/team.json` (format in the docstring), one lock (`_lock`), atomic writes, bus
topic `team`. `state()`, `messages(cid)`, `create_chat`, `send`, `react`, `create_poll`, `vote`, `mark_read`,
`mark_sent` (a "to a session" click), `edit_message` / `delete_message`, `update_group` / `leave_group` / `set_muted`,
`send_theme` (a colour theme as a card, `themes.clean_theme` here and at every receiver), `typing` and the read receipt (signals through `teampeer.signal_all`, never queued), `summarize(cid, ids, since)` (one `claude -p` without tools, Sonnet,
prompt `SUMMARY_PROMPT`, titles in the chat's language). Every local change goes to the other members (`_post_mine`: a new message, stored with its `pending` list in one save; `_broadcast`: the other events)
through `teampeer.send` (message `pending` = ids not reached yet, cleared by `delivered()`); remote events come in
through `apply_remote(frm, contact, event)` which checks membership and authorship; their messages keep `recv`
(arrival time here, unread counts on it) and an `at` never in the future. People ids = `teampeer.pid(address)`;
the user is `ME`. Numbers from peers go through `_finite`; a group roster is stored only if we are in it.
Web: `features/team/` (page `/team`, right panel `TeamPanel`, `Live.tsx` presence + notifications, `SendTo.tsx` from
the session message menu).

## maxxing.teampeer  (owner: organisation)
Server-to-server transport, stdlib + httpx, protocol in the docstring. `<state>/team/peers.json` (600): peers,
invites (the code, 15 min), shared files, outbox. `readiness()` (public https address, not Tailscale / private),
`create_invite`, `join`, `hello` (public side; 409 for an address already linked: an invitation never replaces a
key), `answer`, `forget` (a member of shared groups stays as `group`), `verify(request)` -> (sender, scope: "" =
contact key, else the one group its key is for; signature, time ±300 s and not before `_STARTED` (the nonce cache is in memory), rate limits on
`security.client_key`), `receive(frm, event, scope)` (a group key: message / vote / react of that group only),
`add_group_peer` (never for a contact or a request), `send(addresses, event, msg)` -> outbox, worker `start()` /
`_outbox_round()` (`RETRY` backoff, `OUTBOX_DAYS`; a failing address waits, the others go; no key = dropped),
`share_file` / `file_for` (scope checked) / `fetch_file` (signed GET, ≤ `upload_max_mb`, keeps
`upload_min_free_mb` free, `FETCH_DEADLINE`; `team._fetch` reserves the name, 4 downloads at a time).
Outgoing calls go through `_http()`: `_PublicBackend` resolves the name once and connects to that IP, refused
unless public (no DNS rebinding to a local address). `team_insecure` / MAXXING_TEAM_INSECURE=1 allows http and local addresses (tests only).

## maxxing.infra  (owner: organisation)
- `probe.py`: stdlib-only, Python >= 3.8, one JSON on stdout; run locally as a subprocess and remotely with
  `ssh -o BatchMode=yes ... host python3 - '<opts>'` (script on stdin). Sections (each fails alone into `errors`):
  `server` (os, ips without docker/veth, mem, disk, load), `listeners` (`ss -ltnpH` -> unit from /proc/<pid>/cgroup,
  cwd, `repo_of` = .git/config origin without credentials), `containers` (`docker ps` json, compose labels),
  `sites` (`parse_caddy` = admin API `/config/` or `caddy adapt`; walks subroutes, `vars root`, `rewrite
  strip_path_prefix`, sandbox CSP header; a static path site's folder = root + path unless stripped; `parse_nginx`),
  `databases` (native postgres via `runuser -u postgres -- psql`, docker postgres via `docker exec psql -U
  <POSTGRES_USER>`, mysql by socket, redis/mongo listed, SQLite by magic bytes under roots with a 6 s budget),
  `buckets` (Garage admin API v2 with the token of /etc/garage.toml).
- `providers.py`: Cloudflare (`_CF.get/all`, a 10000/9109 error -> `missing_permission` for that section only;
  DNS per zone; `cf_point(host, ip)` creates an A/AAAA, DNS only), Hostinger (`/api/domains/v1/portfolio`,
  `/api/vps/v1/virtual-machines`, `/api/dns/v1/zones/<d>`), RDAP. Bases: MAXXING_CLOUDFLARE_API,
  MAXXING_HOSTINGER_API, MAXXING_RDAP_API.
- `build.py`: probes + providers + rdap + registry -> resources and links (upstream port -> listener -> unit /
  container / repo; host -> domain (longest suffix); DNS A/AAAA content -> server by IP (`dns_elsewhere`); Hostinger
  VPS merged into a registered server by IP; project from `<workspace>/projects/<p>/` paths; registry annotations;
  declared but not found -> `missing`).
- `__init__.py`: `refresh()` (lock, probes + providers in parallel, RDAP once a day for at most 25 domains, `run_checks`
  = GET of each URL without redirects + TLS expiry per host, 16 threads; `check_url` streams the response and closes it
  after the status line and headers (never the body; h11 caps headers at 16 KiB) and a watchdog shuts the socket down
  after `CHECK_TOTAL_S` = 10 s in total; proxy/worker 4xx = alive; backups.json;
  `_alerts` vs the previous snapshot -> feed source `infra`, group per incident, dedupe per cert/domain threshold),
  `mark_stale()` (CLI recipes: the server loop refreshes within a minute), `view()`. MAXXING_INFRA_CHECKS=0 skips
  the network checks (tests).
- `registry.py`: `<workspace>/infra.json` `{servers, resources:{id: {declared, kind, name, project, note, hidden,
  recipe, vault_keys, urls, details}}}` - no secret ever. A server = `{name (in the resource ids, never changes),
  label (shown, renamed at will), host, user, port, key}`; `free_name()` = short host name, made unique.
- `platforms.py`: Vercel (`/v2/teams`, `/v10/projects`, `/v5/domains`, per team), Netlify (`/sites`, `/dns_zones`),
  Supabase Management API (`/v1/projects`, `.../storage/buckets`, `.../functions`), GitHub Pages (`/user/repos`
  has_pages + `/repos/x/pages`, every token of `gitview.tokens()`). Same normalised shape for all
  (`sites|databases|buckets|functions|domains`), sections fail alone; `VERIFIED` (empty) = seen on a real account,
  the others are `beta` in `source_state()`. Written from the official OpenAPI documents; tests use their shapes.
- `dnsinfo.py`: public DNS over DoH JSON (`MAXXING_DOH_API`, default Cloudflare), cache `<state>/infra/dns.json` 6 h,
  80 names a refresh (`build.hosts_to_resolve`: domains + www + custom site hosts); `dns_provider` from NS suffixes,
  `hosted_by` from CNAME suffixes then IP ranges (Cloudflare proxy last). build.py: public A records fill `records`
  when no zone was read, so sites/domains link to our servers (`hosted_by: "server"`) for any registrar.
  Registry `domains: [...]` = domains added by hand (source `added`).
- `connect.py`: Harness SSH key `<state>/ssh/infra_ed25519` (made on first need, dir 700). `auto_connect()` (in
  `refresh()`, after the providers): a running Hostinger VPS whose root keys (API `GET .../virtual-machines/<id>/ssh-keys`)
  include one of `~/.ssh/*.pub` or the Harness key, and whose IPs no registered server has, is registered (label
  "VPS Hostinger"); one look per VPS every 6 h (`<state>/infra/autoconnect.json`); no blind key tries (fail2ban).
  `connect_hostinger()` (button Connect): same, else `POST .../ssh-keys` with the Harness key then `ssh true` every
  5 s up to 60 s. `connect_host()`: Harness key, then the SSH defaults; else `need_key` + the line to paste.
- `caddy.py`: path site = `/etc/caddy/maxxing-paths/<name>.caddy` (`redir` + `handle_path` (or `handle` with
  --keep-prefix), CSP sandbox without allow-same-origin + `Access-Control-Allow-Origin *` so module scripts load from
  the opaque origin), imported inside `claude-maxxing.caddy` before `reverse_proxy` (install.sh writes the line since
  2.0.0a59, older installs get it added); host site = `/etc/caddy/sites/<name>.caddy` imported by the Caddyfile.
  `_apply`: write, `caddy validate`, reload, restore every file on failure. Reserved names = UI routes + web/dist
  entries. MAXXING_CADDY_DIR / MAXXING_CADDY_BIN / MAXXING_CADDY_RELOAD.
- `actions.py`: PostgreSQL (apt, localhost check, role refused if it exists, password via stdin, vault
  `DB_<NAME>_URL` not exposed, cron job "Infra: database backups" `30 3 * * *` `maxxing infra db backup`; dumps
  `pg_dump -Fc` + SQLite backup API into /var/backups/maxxing-db, 7 kept, state in `<state>/infra/backups.json`),
  Garage v2.1.0 (static musl binary checked against `GARAGE_SHA256` per architecture before it is installed,
  else `checksum_mismatch` and nothing written; `/etc/garage.toml` 600 with every port on 127.0.0.1, unit `garage.service`,
  single-node layout; bucket + own key, vault `S3_<NAME>_*`, `--public` = path site proxied to the web endpoint with
  `Host: <name>.web.garage.localhost`), `server_add` (probe first).
- API `api/infra.py` (loop: first run 60 s after start, then every minute checks period / stale), CLI `cmd_infra.py`,
  skill `pilot-infra`. Web: `features/infra/` (InfraPage = route `/infra`, nav `useNav()` when `infra_page`;
  InfraBlock = ```infra in `components/ui/markdown.tsx`, lazy; bus topic `infra`).

## maxxing.mcp  (owner: organisation)
Claude Code owns the data: user scope = `mcpServers` of `.claude.json` (in `CLAUDE_CONFIG_DIR` when Harness has its
own Claude folder, else `~/.claude.json`), local scope = `projects[<abs folder>].mcpServers` (= one topic),
project scope = `<folder>/.mcp.json` (read; remove edits the file). Writes go through the official CLI
(`claude mcp add-json -s user|local`, `remove`) run with the turn environment (`spawn.claude_env()`) and the topic
folder as cwd; `.claude.json` is edited directly only for what the CLI cannot do (`on_workspace_change`: a renamed
project/topic moves its `projects` keys; removing a server of a deleted folder) and to put back the literal
secrets that `_add_json` leaves out of the `add-json` argument (visible in `ps`): the CLI gets `_redacted(cfg)`, then the
real config is written in place. States: `check()` runs
`claude mcp list` per folder in a thread (`parse_list`: `name: target - ✓|!|✗|⏸ detail`), kept in memory.
OAuth: `login_start` spawns `claude mcp login --no-browser -- NAME` on a pty, reads the authorize URL (OSC 8 links
unwrapped), `login_finish` writes the pasted localhost redirect URL + CR and waits for the exit code; one attempt
per server (a new one replaces it), expired after 15 min by `_gc()` (run by GET /api/mcp, login start / finish and
a reaper thread every 30 s while attempts exist). `_Login.close()` is idempotent and frees the pty fd only after
the CLI is dead and the reader thread has returned (a freed number is reused at once by other components).
Server names never start with `-` and follow `--` on the CLI. `${KEY}` references to vault keys flip them to
`expose` on add. Masking (API and backup): a header / env value is shown only when it is references (with an
optional auth scheme word) or a `PLAIN_HEADERS` header; URL userinfo and query values are masked. `export()` /
`restore()` = `_maxxing/mcp.json` of the memory backup (masked values blanked). Every mapping read from
`.claude.json` / `.mcp.json` goes through `_dict()` (hand-edited files). `.claude.json` rewrites use a unique
0600 temp file + `os.replace`.

## maxxing.pcbridge  (owner: organisation) - Browser of my PC
State `<state>/pc/devices.json` (0600): `device` (token kept as sha256), `pairing` (code hash, 15 min, single use),
`settings.idle_min`, `mcp_secret`, `cdp_secret`; `actions.jsonl` (last 500), `tools.json` (tool list cache), `bin/`
(agent binaries), `tools/chrome-devtools-mcp-<v>/` (npm `--ignore-scripts`, installed on first use).
Path of a tool call: Claude Code -> `POST /api/pc/mcp` (user-scope MCP `harness-pc`, type http, loopback + Bearer
secret) -> `tools_call` -> `Hub.get_child()` = `chrome-devtools-mcp` (stdio JSON-RPC, `CDM_ARGS`: performance /
emulation / memory / network categories off, no usage statistics) started with `--wsEndpoint
ws://127.0.0.1:<port>/api/pc/cdp` -> `Hub.channel()` opens a channel on the agent's websocket (`open` / `data` /
`end`) -> the agent's local DevTools socket. `ensure_browser()` sends `launch` first (40 s). Nothing runs until the
first call; `_idle_watch` (30 s) closes the browser (`close`) and stops the child after `idle_min` without a call;
an agent disconnect ends every channel and the child. `BLOCKED_TOOLS` (upload_file, screencast, lighthouse) and
unknown names are refused; the offline answer is a normal tool result (`isError`). One retry when the child dies
mid-call. Agent binaries: `MAXXING_PC_BIN_DIR`, else `bin/`, else the release in `pc_agent.json` (sha256 checked);
`personalised()` appends `<json><uint32 BE len>HMPCCFG1` (server, pairing code, browser, autostart).
`pc_tools.json` = the tool list shipped for `tools/list` before the first start.
Security boundaries: `pair()` stores a `candidate` (15 min); `WS /api/pc/ws` holds a candidate's socket
(`_wait_confirmation`, nothing relayed) until `confirm()`, else sends `unpair`. `tools/list` drops `filePath` /
`sourcePath` (files of this server), `tools_call` drops them too and refuses a `url` that is not http(s) /
about:blank / data. The authoritative check is in the agent (`pc-agent/cdpfilter.go`): every DevTools command is
filtered (downloads, file inputs, drag of files, permissions, PWA / Extensions, non-page URLs). `actions.jsonl` keeps
URLs without query / fragment / userinfo. A channel with more than 64 MB waiting for the local socket is ended.

## maxxing.customs  (owner: core)
- Customizations = local commits on top of `origin/<branch>` in `config.CODE` (subject `custom: <title>`, trailers
  `Custom-Id`, `Why`, `Saved`). Git is the source of truth; `export()` rewrites `<workspace>/CUSTOMIZATIONS.md` +
  `customizations/NNNN-*.patch` (format-patch, in the backup ALWAYS list).
- `list_customs()`, `save(title, why, files)` (refuses `web/`), `drop(id)`, `restore(dir)` (`git am -3`, idempotent by
  Custom-Id), `dirty_files()`, `summary()`, `ensure_identity()` (local git user for commits/rebases).
- Pending update state: `<state>/update/pending.json` `{at, reason: conflict|health|dependencies, from, target,
  target_version, customs, conflicts}`; `refs/maxxing/pre-update` = code before the last update (rollback point).
- `cmd_core.cmd_update`: read the rollback point (HEAD + current branch, before any `--branch` checkout) -> fetch ->
  stash web/ edits -> auto-save dirty edits -> ff (no customs) or `git rebase origin/<branch>` ->
  conflict: abort + `_back_to(old)` + pending, exit 3 -> `_update_finish`: uv sync (fail: rollback, exit 4), init,
  export, restart + `_healthy(version)` (fail: rollback + restart, exit 4). `_back_to(old)` = checkout the start
  branch, `reset --hard old`, pop the web/ stash. `--resume` runs `_update_finish` from pending.from; `--rollback`
  resets to `refs/maxxing/pre-update` and refuses (exit 1, nothing changed) while the code directory has uncommitted
  changes. The branch that ran at that point is kept in `<state>/update/pre-update-branch.json` `{commit, branch}`
  (`""` = detached HEAD): `_back_to`, `--resume` and `--rollback` check it out (or detach) before the reset, so
  the branch an update switched to (or main, from a detached test checkout) is never rewritten.

## maxxing.smartupdate  (owner: core)
- `preflight(branch=None, fetch=True) -> Preflight`: `git worktree add --detach <state>/update/mx-preflight-*/code
  <target>`, then `cherry-pick --no-commit` of each customization: conflict / empty (= included) / applied (+ overlap
  with `git diff base..target` = review). Never touches the install; cached in `update/preflight.json` keyed by
  [HEAD, target, dirty files]. Extensions vs the target's `EXT_API_MIN..EXT_API` (read with `git show`); upgrade
  notes of the target that ask something (first paragraph not "Nothing to do").
- `verify() -> report` (`update/report.json`): `extensions.scan()`, `widget_card(force)`, `node --check page.js` when
  node exists, each customization's `check` (shell, cwd workspace, `MAXXING_CODE`, 60 s).
- `mark_updated(from, to, smart)` (end of `pilot update`) -> `update/after.json`; `after_update()` runs once at
  server start (api/system.startup, after `MAXXING_AFTER_UPDATE_DELAY` s): verify, feed alert if broken, and for
  `smart` the upgrade-notes session (config `update_auto_notes`, default true).
- `assist_prompt / start_assist`, `fix_prompt`: the Harness sessions ("Answer me in French." when the UI is fr).
- `pilot update` sets edits under `web/` aside (`git stash push -u -- web/`) instead of failing.
- Customization checks: commit trailer `Check:` (save `--check`), overridden by `<workspace>/customizations/checks.json`
  (`pilot custom check`).

## maxxing.license  (owner: core)
The optional Enterprise key: `activate(key)`, `release()`, `remove_key()`, `status()` (`has_key`, `key_hint` = `HM-…` + the last 4 characters, never
the key) talk to `{API}/v1/activate|release` (activation token kept as `license_seat`, only to free the seat;
machine = sha256("harness-maxxing:" + /etc/machine-id)). Also `API`, `USER_AGENT`, `disk_version()` (used by
`register.py`, `feedback.py`).
The HTTP routes `/api/settings/register|feedback|license` depend on `api/settings._legacy_cloud`: `404 not_found`
while `register._offline()` (`MAXXING_LICENSE_PING` is not `1`); the modules are kept for the update and CLI paths.
Installs from before 2.0.0a87 (`enabled()` = `license_token` in secrets.json) run the code of a signed archive
imported by their old code as a commit on `refs/remotes/origin/<branch>`. `move_to_git()` makes them a clone of
`GIT_URL` on `stable` (the `stable` commit with the same tree, else the same `__version__`; customizations
rebased; `license_token` -> `license_seat`). Triggers: `api/system._after_update` at every start (after
`MAXXING_MOVE_QUIET_S`, never while `maxxing-update` runs), the hourly loop (`move_due`, every 6 h after a
failure) and `cmd_update` (saves uncommitted non-`web/` changes first, then stops with the reason if the move
fails). Until then `_fetch` / `check_update` / `_refresh_remote` fetch nothing. Downloading and verifying archives
is gone (2.0.0a93): the old code that still runs on those servers does it.
Offline by default: `offline()` (= `register._offline()`, true unless `MAXXING_LICENSE_PING=1`) makes `_post` raise
`LicenseError(OFFLINE, "offline")` before a request is built, `move_to_git` return an error before any git command
against `GIT_URL`, and `register._call` return `{ok:false, error:"offline"}`.

## maxxing.missions  (owner: organisation) - bounded resident missions
- State: `<state>/resident-missions/<32 hex>.json` (0600, folder 0700), one file per mission; `_edit(id)` = per-mission
  `flock` (`<id>.lock`) + atomic `config.write_json`; `create.lock` serializes the 50-mission cap; `worker.lock`
  (non-blocking) elects the one process that runs `tick()`.
- `create(title, path, goal, steps, max_runs, max_minutes, max_tokens, concurrent, interval_minutes, max_cycles)`,
  `save_plan(id, steps)`, `control(id, action, fingerprint)` (`plan|start|pause|stop`), `acknowledge(id, step_id)`
  (skip, paused missions only), `retry(id, step_id)` (paused only; back to pending, a new counted run), `get` / `listing` (each with `plan_fingerprint` = sha256 of title, path, goal,
  limits, steps and `_engines()` of the roles used: role instructions + engine id, and for an extension engine its
  resolved command and capabilities). `start` requires the current fingerprint and stores it as `approved_plan`;
  `advance` pauses an active mission whose fingerprint no longer matches (`plan_changed`). Internal reads use
  `_read` / `_listing` (no fingerprint: one engine scan per API listing, none per worker pass).
- `startup()` runs `tick()` in a thread about every 2 s (`MAXXING_MISSIONS_WORKER=0`: never); `shutdown()` sets the
  stop flag and waits. `advance(id)`: relocated-state pause (`origin_state` != current state dir, active/planning
  only), `_reconcile` (session states, current companion decision of each proposal, reported tokens; it reuses
  `step.review` = {marker [turns, updated], fingerprint, has_changes}: `companions.review` (git in the copy) runs
  again only when the session moved on, and `companions.decision(sid)` reads the owner's decision from the session
  record on every pass), limits (time = working time: `_track_work` sets `active_since` while a step or the planner
  is starting/running and banks
  it into `spent_seconds` otherwise; clock `_now`), then at most one launch, reserved under the lock (`launches[]` + step `key`) before the
  clone, and sent through `companions.run(..., launch_key, timeout_s, launch_guard)`: the guard re-checks phase,
  stop flag and deadline under the mission lock just before the first message.
- `companions.run(ident, path, mission, *, purpose='experiment'|'plan', launch_key='', timeout_s=1800,
  launch_guard=None)`: an existing session tagged with `launch_key` is returned instead of a new run; `plan` =
  `plan_mode` + `permission_mode='plan'` (the engine must declare the `plan` capability) and a read-only prompt.
  Manual companion runs keep the defaults. `companions.MAX_MISSION` (6000) bounds the mission text; missions check it
  when a plan is created, saved or started (`_check_lengths`, `TooLong` with `details` {step, title, excess}, kept in the
  error body by `api/missions._call`), trim prerequisite reports at launch, and fit the planner's role catalog.

## CLI
Command names: `pilot`, and `maxxing` as a permanent alias - the same entry point `maxxing.cli:main` twice in
pyproject `[project.scripts]`. In the local setup `bash scripts/dev-local.sh cli <args>` runs it with the
exports and preparation of the local server (`MAXXING_STATE`, workspace, skills dirs, local crontab file), from
the caller's folder; a bare `uv run pilot` has no `MAXXING_STATE` and reads `/var/lib/claude-maxxing`. argparse `prog` = the name it was called by
(`cli.prog_name()`, `pilot` for `python -m maxxing`). On a server, install.sh writes `/usr/local/bin/maxxing`
(`cmd_core.BIN_LINK`: a link to the venv's script, or a wrapper exporting `MAXXING_STATE`) and every `init`
(so every update) runs `cmd_core.ensure_cli_alias()`: `/usr/local/bin/pilot` (`PILOT_LINK`) -> `maxxing`, the
same program and state; a `pilot` that is not ours is never replaced (report: `{cli: created|ok|skipped ...}`;
skipped with `MAXXING_SPAWN=direct` or without BIN_LINK). Uninstall removes it only when it is that link.
Doctor check `cli` (`cmd_core.check_cli_name()`): the first `pilot` on the doctor's PATH and on the sessions' PATH
(`sessions.spawn.base_env()`, what agents run the skills' `pilot ...` commands with) must be ours - it resolves to
BIN_LINK or to the venv's `pilot` / `maxxing` script, or it is a small script starting `maxxing.cli` (uv's console
script, install.sh's state-dir wrapper). Another program named `pilot` first -> WARN naming it, fix: `maxxing`, the
same command (or a PATH order / removal of the other program). None found while BIN_LINK exists -> INFO, fix
`maxxing init` (creates PILOT_LINK); none found in a checkout without BIN_LINK -> no check.
The crontab lines, the default jobs' commands (`crons.maxxing_bin()`) and the Python package keep the
`maxxing` name on purpose: an existing line never changes. User-facing text (docs, skills, templates, help)
says `pilot`.
`maxxing.cli.register(name, help, configure(parser), handler(args) -> int)`, called from
`maxxing/cmd_core.py` (init, doctor, update, status, harden, uninstall), `cmd_cron.py` (cron run/sync/list),
`cmd_backup.py` (backup run/restore/status), `cmd_telegram.py` (telegram status/test),
`cmd_sessions.py` (sessions compact-logs), `cmd_memory.py` (memory), `cmd_import.py` (import), `cmd_video.py` (video new/status), `cmd_voice.py` (voice status/set/download/transcribe),
`cmd_custom.py` (custom status/save/drop/export/restore), `cmd_license.py` (license activate/status/remove/release).
Startup speed: `configure(parser)` runs only for the command being run (the first non-option argument),
and the `cmd_*` modules import their domain module (crons, feed, license, urllib...) inside the handler,
never FastAPI (`maxxing.security` / `maxxing.app`): `pilot --help` ~85 ms. Keep new commands that way.
cmd_core also exposes `copy_templates(ws)` (renders `{{CODE_DIR}}`/`{{WORKSPACE}}`/`{{STATE_DIR}}`/`{{VERSION}}`, seeds each
default project/topic once - install.json `seeded`), `install_skills()` (copies the product skills - `pilot-*` and
`PRODUCT_SKILLS_EXTRA`; `maxxing-*` still counts as a product name so the copies of earlier versions are dropped:
install.json `skills` lists what was installed, an obsolete listed one is deleted, an old-named folder of
`renames.SKILL_RENAMES` that is not listed goes to `trash/skills/` - from `skills/*` to `<claude_dir>/skills`
and renders the same placeholders in their `.md`/`.json`/`.txt` files, so shipped skills never hard-code
`/opt/claude-maxxing`, `/root/maxxing` or `/var/lib/claude-maxxing`. The same copy goes to Codex's user skills
folder `codex_skills_target()` = `~/.agents/skills` (where Codex CLI reads personal skills; checked with codex-cli
0.150.1), with its own record install.json `codex_skills` (a folder it moves away goes to `trash/skills/<name>-codex-<time>`); the result keeps `installed`/`removed`/`backed_up` for
Claude and adds `codex: {target, installed, removed, backed_up}`. `skills_status()` compares with the rendered text:
`[{name, state, codex}]`, `state` for Claude's copy and `codex` for Codex's, each `ok` | `missing` | `outdated`), `default_jobs()` / `ensure_default_crons()` (install.json
`default_crons`; the morning job's prompt is `MORNING_TASKS_PROMPT`), `check_update(branch) -> {ok, current, latest, behind, available, changelog}` (no change to the
code; `update_source()` = "license" | "git" (clone with an `origin` remote) | None - None: `{ok: true, git: false,
message: "no license, no remote"}`, `update --check` exits 0 with "updates unavailable (no license, no remote)", and
`default_jobs()` creates "Check for updates" disabled). "Memory compaction" is created disabled; its id goes into
install.json `enable_after_onboarding`; `enable_pending_jobs()` (called by POST /api/onboarding/complete when
`claude_auth.status().ok`) enables each listed job still disabled and never edited (`created == updated`), then
clears the list - jobs of existing installs are never touched (their key is already in `default_crons`), `notify_update(info)` (gateway.notify_cron), `version_key(v)`, `upgrade_notes(old, new)` (docs/upgrade).
`renames.py` (called by `do_init` after the default jobs, report `renamed: {files, jobs}`): `SKILL_RENAMES`
(old -> new skill name, keep every pair), `rename_skills(text)`, `migrate(ws)`. It rewrites only the exact old
skill names, and only in what the product generated: a line of a workspace file copied from a template
(`templates/workspace/**`, `templates/packs/<id>/project/**` for `projects/<project>` and `<project>-N`)
changes when, renamed, it equals a line of the current rendered template (comparison ignores the CLI name
`maxxing`/`pilot` and the product name `Harness Maxxing`/`harness-pilot`); a job prompt changes when, renamed,
it equals a shipped prompt (`COMPACTION_JOB`, `MORNING_TASKS_PROMPT`, the packs' `crons[].prompt`). Lines and
prompts written or edited by the user are left (upgrade notes ask Claude to propose them to the user).
Idempotent, runs on every init (cheap: only template-mapped files that still contain an old name are read
twice). `tests/test_renames.py::test_no_live_text_names_an_old_skill` fails when a merge brings an old name back.

## Service sandboxing (`pilot harden`)
- `cmd_core.HARDENING` = drop-in `/etc/systemd/system/claude-maxxing.service.d/10-hardening.conf`
  (`hardening_path()` derives it from `UNIT_PATH`); install.sh writes the byte-identical text (a test checks it).
  Options: NoNewPrivileges, ProtectKernelTunables/Modules/Logs, ProtectControlGroups, RestrictSUIDSGID,
  RestrictRealtime, LockPersonality, SystemCallArchitectures=native, TasksMax=2048.
- Deliberately absent: ProtectSystem/ProtectHome/PrivateTmp (workspace, /etc/caddy and shared /tmp writes),
  RestrictNamespaces (Claude Code sandbox), MemoryDenyWriteExecute (Node JIT), UMask=0077 (files written for
  Caddy or other web servers must stay readable). Turns, updates and restarts go through `systemd-run`: PID 1
  creates those units outside this sandbox.
- `pilot harden`: write -> daemon-reload -> restart -> `_healthy(version)`; on failure the previous drop-in
  (or none) is restored, reloaded and restarted (exit 1). `--undo` removes it. Doctor check `hardening`
  (INFO when missing or different, OK when identical). `pilot uninstall` removes the drop-in.
- `systemd-analyze security --offline=true` on the generated unit: 9.4 UNSAFE without, 7.8 EXPOSED with
  (the rest is the root user and its capabilities, which the product needs).

## Signed updates (`update_verify_signature`)
- Config `update_verify_signature` (default false). `cmd_update`, right after the fetch and before anything
  changes (auto-save of dirty files, pre-update ref, merge/rebase): `verify_target(origin/<branch>)` =
  `git verify-commit <sha>`, else `git verify-tag` of each `git tag --points-at <sha>`; failure -> FAIL line,
  `_notify`, exit 1. Skipped when already up to date and on licensed installs (archive verified with ed25519).
  `--resume` / `--rollback` do not re-check (the target was checked when the update started).
- Doctor `update_signature` (only when on): verifies `origin/<current branch>` (else HEAD), WARN if unsigned.

## External components (deps.toml, deps.py)
- `server/maxxing/deps.toml` is the one list of what Harness Maxxing installs besides apt packages: version, URL
  template, sha256 per machine (`x86_64`, `aarch64`), path, links in `/usr/local/bin`, what `remove` deletes, update
  policy (`auto` = moved by every `pilot update`; `self` = Claude Code; `apt`; `manual` = Garage, whose pins stay in
  `infra/actions.py`), the OSV package for `deps check`, lockfiles. Both `deps.py` (tomllib) and install.sh (`dep`, a
  regex reader: keep the syntax to `[name]`, `k = "s"`, `k = ["a"]`, one-line `k = { a = "b" }`) read it;
  `tests/test_install_reliability.py` checks they agree.
- Every download: `fetch_verified` (install.sh, bash) / `deps.fetch_verified` (server) = HTTPS, into a private work
  folder (`$WORK`, `<state>/tmp/deps.*`), sha256 checked before use. Never `curl | sh`, never a script fetched at
  install time (`tests/test_deps.py::test_no_download_is_piped_into_a_shell_anywhere`). Children get `TMPDIR` in the
  work / state folder.
- Updates are side by side: Node.js and Scrapling in `<component>/<version>` + `current` link, Remotion in
  `remotion.new` swapped with `os.replace`, uv / binaries replaced atomically; the old copy stays until the new one
  answers its check. `deps.json` records the sha256 of the installed binaries for `verify`.
- Adding a component: a table in deps.toml, an `_up_<name>` updater in `deps.py` (`_UPDATERS`, `UPDATE_ORDER`),
  `installed()` / `owned_paths()` cases, a test; bump with `scripts/bump-pins.sh` (it rewrites deps.toml in place
  and re-resolves `templates/scrapling/requirements.txt` with `uv pip compile --universal --generate-hashes`).
- One Chromium: Playwright's build in `<state>/tools/browsers` (revision of the drivers of the Scrapling lock) serves
  Scrapling, Remotion (`templates/remotion/remotion.config.js`) and `pilot pdf` (`cmd_video.browser()`).

## Turn units (sessions/spawn.py)
`_start_unit(sid)` runs `systemd-run --collect --unit maxxing-<sid8>` (the name users pass to `journalctl -u`).
Turn and cron units get `memory_properties()`: `OOMPolicy=continue` (an OOM kill takes one process, not the
unit and its Claude) and `MemoryMax=<unit_memory_max>` (config, default 75 % of RAM).
Turn and job units also get `hardening_properties()` (see "Unit hardening" below).
When the previous runner unit of the session is still stopping ("already loaded / exists"), it polls
`systemctl show` every 50 ms (`UNIT_POLL_S`) until the unit is unloaded or inactive, at most 3 s
(`UNIT_GONE_WAIT_S`), and starts again; a unit still there after that gets `maxxing-<sid8>-<n>`.

## Unit hardening (sessions/spawn.py `UNIT_HARDENING`)
Sessions and jobs run as root with full rights on purpose (Claude administers the server: apt, systemctl, caddy,
crontab, sudo, docker/lxc CLIs, mounts); running them as another user is a separate project. Turn units and job
units get only the systemd options measured harmless for that work (transient units on systemd 259, probe of
sudo, setuid helpers, apt simulation, dpkg setuid files, modprobe, dmesg, block devices, loop/fuse/tun, sysctl
writes, mounts seen by the host, nested systemd-run, snap/lxc, Node, Chromium, ffmpeg, Python multiprocessing,
git, `claude --version`). Config `unit_hardening` (default true; false = none).

| Option | Kept? | Why |
|---|---|---|
| `ProtectClock=yes` | kept | blocks setting the clock (`date -s`, `hwclock -w`, adjtimex); `timedatectl` goes through timedated (another unit) and still works; the implied `DeviceAllow=char-rtc r` leaves the other devices open (block devices, loop, fuse, tun checked); no mount namespace |
| `LockPersonality=yes` | kept | only `personality()` changes (`setarch linux32`) fail; 32-bit binaries still run (the kernel sets their personality at exec) |
| `RestrictRealtime=yes` | kept | only realtime scheduling (`chrt -f`) fails; nothing a session runs needs it |
| `MemoryMax`, `OOMPolicy=continue` | kept | `memory_properties()` (already there) |
| `NoNewPrivileges=yes` | rejected | breaks sudo, setuid helpers (ping, fusermount, ssh-keysign) and snap (`snap-confine` is setuid). Not implied by the kept options: the units keep CAP_SYS_ADMIN (checked `NoNewPrivs: 0`) |
| `ProtectKernelTunables=yes` | rejected | /proc/sys and /sys read-only: `sysctl -w`, `sysctl --system`, ufw reloads (it writes /proc/sys/net) fail |
| `ProtectKernelModules=yes` | rejected | makes /lib/modules inaccessible: `modprobe` fails and an `apt upgrade` installing a kernel cannot write its modules |
| `ProtectKernelLogs=yes` | rejected | `dmesg` fails (the usual look for OOM kills) |
| `ProtectControlGroups=yes` | rejected | gives the unit its own mount namespace: a disk, sshfs or loop image mounted by a session is invisible to the host and gone with the turn |
| `RestrictSUIDSGID=yes` | rejected | `chmod u+s` / `g+s` fail: dpkg cannot install packages shipping setuid files (sudo, passwd, fuse3...), no setgid shared folders |
| `SystemCallArchitectures=native` | rejected | 32-bit programs (steamcmd, wine) stop working |
| `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectProc`, `RestrictNamespaces`, `MemoryDenyWriteExecute` | rejected | writes everywhere, /tmp shared with the server, devices, `ps`, Claude Code's own sandbox (namespaces), Node JIT |

The server service keeps its own drop-in (`HARDENING`, `pilot harden`), stricter because the server itself never
administers the host; units started with systemd-run are created by PID 1 and do not inherit it.

## Claude tuning variables (production)

`sessions/spawn.TUNING_ENV` - `CLAUDE_CODE_EFFORT_LEVEL`, `MAX_THINKING_TOKENS`,
`CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M`,
`ENABLE_PROMPT_CACHING_1H`, `DISABLE_PROMPT_CACHING`, `ENABLE_TOOL_SEARCH`,
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` (names checked in the Claude Code binary) - set on the
`claude-maxxing` service, reach every turn runner in direct and systemd modes (as `--setenv`, so
visible in `ps`: never add a secret to this list; credentials go through `auth_env()` inside the
runner). Simplest for users: the `env` block of `~/.claude/settings.json`, read by Claude Code itself.
To set them on the service: `systemctl edit claude-maxxing` -> `[Service]` `Environment=NAME=value`.

## Environment overrides (tests / development - never needed in production)
- `MAXXING_WEB_DIST` serve the UI from another build folder (dev)
- `MAXXING_STATE` state dir · `MAXXING_CLAUDE_BIN` claude executable (tests: server/tests/fake_claude.py)
- `MAXXING_PC_BIN_DIR` folder of Harness PC agent binaries (tests, local builds of `pc-agent/`) instead of the release
- `MAXXING_SPAWN=direct` run turns as detached subprocesses instead of systemd-run units
- `MAXXING_SKILLS_DIR` where `init` installs the product skills (`cmd_core.skills_target()`, also read by the doctor,
  uninstall and `blocks.sync_agent_files`) instead of `<claude dir>/skills`. `scripts/dev-local.sh` sets
  `<local dir>/.claude/skills` and installs them at every start: Claude Code reads a `.claude/skills` folder in the
  session's folder and its parents up to the repository root, so the local workspace's sessions get them and the
  personal `~/.claude/skills` of the computer is never written (a personal skill of the same name wins).
- `MAXXING_CODEX_SKILLS_DIR` where `init` installs the product skills for Codex (`cmd_core.codex_skills_target()`,
  also read by the doctor, uninstall and `blocks.sync_agent_files`) instead of `~/.agents/skills`.
  `scripts/dev-local.sh` sets `<local dir>/.agents/skills`: Codex reads `.agents/skills` in the session's folder and
  its parents up to the Git repository root (the default local dir is inside the checkout), so the personal
  `~/.agents/skills` of the computer is never written. Tests point it to a temporary folder (`conftest.py`).
- `MAXXING_CRONTAB_FILE` write the managed crontab block into this file instead of `crontab -`
- `MAXXING_SYSTEM_TZ=0` never switch the system time zone when the time zone setting changes (also skipped when `MAXXING_CRONTAB_FILE` is set)
- `MAXXING_TELEGRAM_API` Telegram API base URL (tests: local mock) · `MAXXING_GITHUB_API` GitHub API base URL
- `MAXXING_LICENSE_API` license server (default `https://api.harness-maxxing.com`) · `MAXXING_GIT_URL` repository an install still on archives moves to (tests) · `MAXXING_LICENSE_PING=0` no hourly loop: no registration heartbeat, no call to the cloud (tests)
- `MAXXING_AUTH_CHECK=0` no background Claude sign-in verification (tests) · `MAXXING_AUTH_CHECK_DELAY` seconds
  before the first one (default 5)
- `MAXXING_MISSIONS_WORKER=0` no resident mission worker: missions never launch an agent on their own (tests call `missions.tick()`)
- `MAXXING_CLAUDE_UPDATE=0` no background Claude Code update (tests), `=1` also on a non-default state dir · `MAXXING_CLAUDE_UPDATE_DELAY` seconds before
  the first pass (default 600)
- `MAXXING_GROQ_API` / `MAXXING_OPENAI_API` base URLs of the speech-to-text APIs (default the providers' `/v1`)
- `MAXXING_TELEGRAM_POLL` long-polling timeout in seconds (default 50) · `MAXXING_GITHUB_GIT` git base URL of the
  backup remote (default https://github.com; tests: `file:///tmp/...` with bare repos `<owner>/<name>.git`)

## Trash, import, tools (2.0.0a5)
- `maxxing/trash.py`: `list_items()`, `restore(id)`, `delete(id)`, `empty()`, `purge_old(days=30)`,
  `trash_session(sid)` (used by `sessions.service.delete_session`). Items = entries of
  `state_dir("trash")` with a `.json` sidecar `{original, at, kind?, title?, path?}` (+ `.sessions/`
  for a project / topic); `workspace.move_to_trash` writes them. API `/api/trash`. `list_items` reuses the
  last listing while the (name, inode, mtime, size) of every trash entry is unchanged (one `scandir`), keeps
  each item's size keyed by the same stat of the item and its `.sessions/` (walked again only when one
  changed), hides expired items and runs `purge_old` at most once per `PURGE_EVERY_S` (1 h);
  `invalidate_sizes()` after writing deep inside an existing item (backup restore's previous versions).
- `maxxing/importer.py`: `prompt(agent)`, `inspect(zip)` (preview, writes nothing), `apply(zip)`,
  `finish_prompt(result)`; uploads in `state_dir("import")` (24 h). Never overwrites; secret scan =
  `backup.scan_bytes`. API `/api/import`, CLI `pilot import`.
- `maxxing/videos.py`: lighter copies for the player. `probe(p)` (ffprobe, cached by `sha1(path, mtime_ns,
  size)`), `status(p)`, `prepare(p, q)` -> `_encode` on a 1-worker pool (`nice -n 10 ffmpeg ... -progress pipe:1`,
  writes `<key>.part.mp4` then renames; `_jobs[key]` = state/progress/error in memory, lost on restart: a
  half-made copy is simply made again), `_trim_cache()` (atime LRU, `VIDEO_CACHE_MAX` 4 GB; also removes
  `*.part.mp4` older than `PART_STALE_S` whose job is not running). API in `api/files.py`.
- `maxxing/cmd_video.py`: Remotion prepared once in `<state>/tools/remotion` by `install.sh`
  (`install_tools`, `--tools`); `new_project(dir)` copies `templates/remotion` and links
  `node_modules`; `pdf(src, out)` runs `maxxing/assets/print_pdf.mjs` (DevTools `Page.printToPDF`
  through Remotion's headless shell, which has no `--print-to-pdf`). Doctor: `check_tools` (warn).

## Settings files and git credentials
- `config._atomic_write`: `mkstemp` in the same folder, permissions set before writing (`mode`, else the
  existing file's, else `0666 & ~umask`), `os.replace`. `config.json` / `secrets.json` that do not
  parse are read as `{}` (defaults) and copied to `<name>.damaged-<stamp>` before any save
  (`_keep_damaged`, `damaged_copy_of`; doctor `state_files`).
- `cmd_core.git_auth_env(token)`: the update token reaches git through `GIT_CONFIG_COUNT/KEY_0/VALUE_0`
  (`http.extraHeader`), never through `-c` arguments; used by `cmd_core._git` and `api/system._git`.

