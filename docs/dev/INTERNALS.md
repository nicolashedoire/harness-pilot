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
  A discussion's second seat (meta `discussion_partner`, default `codex`; `service._check_partner` validates a `plugin:<id>` against its capabilities): `_debate_followup` alternates Claude with it, `_agent_label` writes its note (the plugin's `provider_name`), `codex_role` / `codex_model` apply to it, and `_plugin_turn(..., is_debate)` sends `_debate_history` (from `_debate_turns`, speaker-named, minus what the prompt holds) then calls `_debate_followup` (no overflow retry for a plugin: its state is its own).
- `on_turn_end(cb)` - `cb(session: dict, result: dict | None)` is awaited/called on the event loop when a
  turn of ANY session finishes, whatever started it (web, Telegram, cron). Fired per turn (the turn counter
  grows, or running -> error); turns ending within the same scan are reported once. The watcher is woken by any
  meta change (`sessions/wake.py`: one inotify watch of the sessions folder through `watchfiles`, which also wakes
  the session SSE streams; `MAXXING_INOTIFY=0` or no inotify: the old polling, 0.25 s while a session runs) and
  passes at least every 2 s while a session runs, every 1 s otherwise. A pass reads a meta again when its file's
  (inode, size, mtime_ns) changed, when it was last read less than `RACY_S` (1 s) after its mtime (two saves in one
  timestamp tick keep the mtime and can reuse the inode number at the same size), or every `RUNNING_RECHECK_S` while
  it runs; a digest of its content and the derived (turns, state, unread) tell whether it changed. `result` = last
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
- Compaction in the runner (`sessions/runner.py`): `_auto_compact` after a turn above `auto_compact_tokens` (Claude and Codex turns, not plan mode; for Codex, whose `Attempt.context_window` is set, also from `DEBATE_COMPACT_RATIO` of that window, whichever comes first: its 258 400 window is below the 400 000 default; never when the thread's first call - `Attempt.first_context` for a turn that started it, else meta `base_tokens` - already reached that limit: the continuation would start above it and be compacted again, turn after turn, as an end-to-end run with a stub whose fresh threads started at 280k did before this rule); idle
  compaction in `_pop` - `_idle_compact(meta, item, cfg, now)` returns `(away, k_tokens)` when a `user` item (not
  cron/system source, steer, plan approval) pops for a non-fresh (`resume.thread_open(meta)`: Claude `fresh` false, Codex a `codex_thread_id`), non-cron session whose last call
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
- Discussion compaction (provider `discussion` / `debate`): `_debate_followup` sets meta `discussion_compact_due` (`{tokens, agent}`) when `_debate_due(attempt, cfg)` - the agent's `context_tokens` >= min(max(`auto_compact_tokens`, `AUTO_COMPACT_MIN`), `DEBATE_COMPACT_RATIO` x context window; Claude's from its result, Codex's from its session file) - or, for a turn refused with `_context_overflow` (`CONTEXT_OVERFLOW` on the error, stderr or an error `result`), `{overflow: agent}` and puts the popped item back at the queue head with `debate_retry: true` (once; no second `mx_user` line). `_take` then inserts a `compact` item (`DEBATE_SUMMARY_PROMPT`, `auto`) before the next `user`/`debate` item (a `user` one `held`) and writes `_debate_due_note`. `turn` sends a discussion's `compact` item to `_debate_compact`: Claude, `--permission-mode plan`, a new `--session-id` (never the agents' threads), prompt = request + `_debate_transcript(log, discussion_compacted_at)` (user messages and each turn's last assistant text with its agent, summary turns skipped, last `DEBATE_TRANSCRIPT_MAX` chars of the last `DEBATE_LOG_TAIL` bytes) + the previous `discussion_summary`. On success: new `csid` + `fresh`, `codex_thread_id` dropped, `discussion_summary` (`DEBATE_SUMMARY_MAX`), `discussion_compacted_at`, due flag cleared; an agent whose thread is fresh (Claude `fresh`, Codex without `codex_thread_id`) gets `SEED_DEBATE` as preface. `_pop` lets a `compact` head run while the discussion is paused (`service.compact`).
- Discussion hand-off: `service.handoff` copies `DISCUSSION_CARRIED` (`debate_goal`, roles, `codex_model`, limits, and an agent plugin partner: `discussion_partner`, `provider_name`, `provider_capabilities`) and, when paused, `debate_pending` + `debate_next` (new one paused, reason `user`) to the continuation and queues a `handoff` item (`DEBATE_SUMMARY_PROMPT`, `target`) on the old one; `_pop` also runs a `handoff` head while paused. `_debate_compact` ends with `_debate_handoff(target, summary)`: target meta `discussion_summary` + `discussion_from` (old title: `SEED_DEBATE_HANDOFF` instead of `SEED_DEBATE`, dropped by its next compaction), an `mx_user` `kind: seed` line (`source: system`) with that seed, `_start_target(target, None)`; the old one is archived and unpaused. `resume_debate` does not start a continuation still `_handoff_held`.
- A successful turn of a `cron=True` session archives it; a message from the web/Telegram clears the flag.


## maxxing.sessions.teams  (owner: core) - mixed Claude + Codex teams
API: `/api/teams*` (API.md). A team is three ordinary sessions of one topic, each stoppable on its own: a
coordinator (the parent, returned by `create`; Claude Code or Codex) and two workers, `claude` and `codex`, in `permission_mode='plan'`.
- State: coordinator meta `team: {phase, goal, attachments, agents: [{id, provider, role, stopped}], created}`, worker meta
  `team_parent: <coordinator id>`; the Session JSON exposes `team_phase`, `team_parent` and `team_turn`
  (`service._team_turn`). Phases: `launching` -> `working` -> `synthesizing` -> `completed`, or `stopped` / `error`.
- `create(path, message, title=None, attachments=None, roles=None, coordinator='claude', models=None)`: mission of
  1-24 000 characters (else 400 `bad_mission`); `roles` `{claude?, codex?}` replace `ROLES` (the defaults) for that
  worker when not blank; `coordinator` (`claude` | `codex`, else 400 `bad_provider`) is the provider of the parent
  session; `models` `{claude?, codex?}` (`service._check_model`, 400 `bad_model`) go to that provider's worker and
  to the coordinator of that provider;
  attachments checked by `service._check_attachments` (400 `bad_attachment`) before anything is created. Creates the
  coordinator then the workers, logs the mission and its attachments as the coordinator's `mx_user` line, then, inside the coordinator's
  `store.edit`, sets `team_parent` on each worker and sends it its role and the mission with the attachments (`source='team'`; asked not
  to edit files - an instruction, not an isolation boundary). A stop during the launch -> 409 `team_stopped`; any
  failure -> phase `error` (unless stopped) and the workers stopped.
- `get(sid)` -> `{id, phase, created, coordinator, agents: [{..., state, session, started_at, finished_at, activity, report}]}`;
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
- `auth_method()` is shared by the web app and CLI, including macOS Keychain's boolean CLI status.
  Legacy non-authentication failures from an explicit test are not relevant sign-in records.
- `record(ok, error=None, source="turn"|"test"|"check")` - outcome of a real call; `detect(text) -> str|None`
  finds a sign-in error; `status() -> {ok, method, detail, checked_at, error}` (GET /api/claude/status `auth`,
  health, doctor); `needs_check()` - no verification in the last 6 h (background check in api/claude.py).

## maxxing.claude_probe (stdlib only)
- `run(model, prompt, timeout_s)` makes the one-line authentication probe used by Settings, the background
  checker and `pilot doctor --live`. A temporary directory outside the workspace is removed after the call;
  no tools, MCP servers, setting sources, skills or saved conversation are used. Results are
  `{ok, model, ms, error?}`; callers record successes or genuine authentication failures only. No FastAPI
  dependency in the CLI.
- Success = exit 0 and a result that is not an error (`is_error` false, `subtype` success) with a non-empty
  answer, whatever its wording ("OK.", "ok!"): the probe checks the sign-in, not the model's obedience. An
  answer that `claude_auth.detect` reads as a sign-in error is not a success.
- `binary()` = the executable sessions run (`spawn.claude_bin()`, executable or found on `spawn.base_env()`
  PATH; also `api/claude._resolved_bin`); none -> `{ok: false, error: NOT_INSTALLED}` ("Claude Code is not
  installed") without a call, and doctor `claude_auth` says so.
- Same as a session: the credentials the CLI reads itself (the stored token or API key that `spawn.claude_env`
  exports, `.credentials.json`, macOS Keychain) and the Claude directory (`CLAUDE_CONFIG_DIR`). Not the same:
  `--setting-sources ""` loads no `settings.json`, so what only settings provide is missing - `apiKeyHelper`,
  the settings `env` (`ANTHROPIC_BASE_URL`, proxies, `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX`...). A setup that
  depends on them can fail the probe while sessions work. Kept on purpose: loading the user's settings would
  also run the user's hooks in a connection test (docs/user/16-troubleshooting.md says it).

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

## maxxing.codex_models - the Codex model pickers
`GET /api/system/codex/models` -> `codex_models.models()`, read by `features/codex/CodexModelField.tsx` (new session:
Codex, discussion and mixed team; cron editor: Codex jobs). codex-cli 0.150.1 has no `models` command, but
`codex debug models` prints its model catalog as JSON: `{"models": [{slug, display_name, description, visibility:
"list"|"hide", priority, default_reasoning_level, supported_reasoning_levels, ...}]}` - refreshed for the signed-in
account (the shipped catalog when signed out, checked with a throw-away `CODEX_HOME`), and `--bundled` gives only
the one shipped with the binary (10 models, 5 with `visibility` "list": gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
gpt-5.5, gpt-5.2). The pickers get what the CLI's own picker shows (`visibility` "list", sorted by `priority`, ids
matching `sessions.service._MODEL_ID`, no repeats): `debug models` (15 s), else `--bundled`, else `KNOWN_MODELS` (the
same five, to update with a Codex release that changes them). Cached 10 min per binary path + mtime, dropped by
`invalidate()` (`codex_login` calls it when the sign-in changes; the web drops its `codex-models` query then too).
Nothing is stored: a session or a job keeps the id it was given, and an id outside the list shows as "Other…" with its
text. `debug` is a CLI debugging command: if a release drops or changes it, the list falls back without breaking the
pickers. Tests: `tests/test_codex_models.py` (fake `codex`), `web/tests/components/codex-model-field.test.tsx`.

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
- Agent of a new session (`NEW_COMMANDS`): `/new` = Claude Code (the default, also a plain message in the main chat),
  `/codex` = provider `codex`, `/discuss` = provider `discussion` with `discussion_turn_limit` = `DISCUSS_TURNS` (6
  replies: the exchange pauses, a new message starts the next period). Same flows as `/new`: in a session thread a
  sibling in the same topic with its own thread; in the main chat or a thread the user made, the "where?" question
  (its text names the agent; the pending entry of `state/telegram/new.json` keeps `provider`, default `claude`, and a
  later `/new` / `/codex` / `/discuss` before the answer changes it); threads off, the topic's new Telegram session.
  `/codex` and `/discuss` first run `sessions.codex.status()` in a worker thread: `authenticated: false` -> the chat
  is told (not installed / not signed in: Settings → Codex, or `codex login`) and nothing is created or asked; `null` (status
  unavailable) does not block. `/model` in a session whose provider is `codex` or `plugin:<id>` shows its model and
  changes nothing (`_set_model` refuses too: a Claude id would break its turns); `/status` adds the agent (and the
  replies of the current period for a discussion). A discussion answered on Telegram (`debate_telegram`) that pauses
  on its limit (`debate_paused`, reason `limit`) gets a silent notice in its thread after the reply.
- `notify_cron(text)` - plain message in the "Crons" thread. `notify_cron_report(header, body, markdown, loud)` - a
  cron run's report: bold header + the Claude answer rendered by `fmt.render` (from its start, `fmt.head` at
  `REPORT_MAX` = 12000) or command output in `<pre>` (`fmt.code`); body packed with room for the header.
- `status() -> dict` - the GET /api/telegram payload.
- `start()/stop()/restart()` (async, server loop) and `install_hooks()` (registers
  `sessions.service.on_turn_end` + `workspace.on_change`), called by maxxing.api.telegram.
- Uses from sessions.service: `create_session` (`provider` / `discussion_turn_limit` passed only for another agent
  than Claude), `get_session`, `list_sessions`, `send_message`, `stop`,
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
  resolved count)` tuple (changes on posts, folds, reads, resolutions). `watch_id()` (the feed watcher: UI + Web Push)
  reads it through one kept connection, again only when that connection's `PRAGMA data_version` changed; never from
  the files' size / mtime (SQLite writes and syncs the WAL frames before it publishes the commit, and rewrites a
  restarted WAL in place).
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

## maxxing.extensions / maxxing.api.extensions - page modules  (owner: organisation)
- `module_file(ext, rel) -> Path | None`: the file a page may load from its folder (`MODULE_TYPES` `.js .mjs .css
  .json` -> content type). Every segment of `rel` AND of the real path relative to the resolved folder (links
  followed) matches `MODULE_SEG_RE` (starts with a letter, digit or `_`: no hidden file, no `..`, never `@`) and the
  real path has a module suffix: a link to a file outside, to `api.py` or to a hidden file gives None.
- `page_version(ext) -> int | None` = `Extension.info()["page_v"]`: newest mtime (ms) over the files `module_file`
  would serve, by an `os.walk` that does not follow folder links, skips `MODULE_SKIP_DIRS` and hidden folders, and
  stops after `MODULE_SCAN_MAX` files. Computed at each listing (in a thread: `api.extensions._infos`), not at scan
  time: a module other than page.js is not part of `_signature()` (no rescan, no api.py import when it changes).
- Routes: `/ext/{id}/page.js` and the catch-all `/ext/{eid:extid}/{rel:path}` (declared after the fixed
  `/ext/{id}/...` routes) share `_page_module` (enabled page extension without error, `module_file`). A first segment
  starting with `@` is the version and is dropped. `extid` (a Starlette convertor registered by api/extensions.py,
  the `ID_RE` pattern) never matches `_blocks`, so the catch-all leaves `/ext/_blocks/...` to api/blocks.py, whose
  router is included later. The web (`pages/ext/index.tsx`) imports `/ext/<id>/@<page_v>[-<retry>]/page.js`.

## maxxing.permissions - declared permissions of extensions  (owner: organisation)
Stdlib only (with `blocks.HOST_RE` and `vault.NAME_RE`). API.md#dashboard--extensions (Permissions).
- `parse(raw) -> dict | None`: the manifest's `"permissions"` validated -> `{network, secrets, read}` (lists in the
  manifest's order, duplicates dropped, hosts lowercased, read paths normalised: no trailing `/`, `./` dropped);
  None when the key is absent; ValueError with a readable reason otherwise. `extensions._load_one` calls it for a
  widget or page (after the agent early return) and stores `Extension.permissions`; a ValueError becomes the
  extension's `error` (`permissions: ...`). A block plugin's `Extension.permissions` is built from its `block.json`
  hosts (`{network, secrets: [], read: []}`); an agent keeps None.
- `view(perms) -> {network, secrets, read, declared}`: the Atelier's `Permissions` (API.md#atelier) of a declaration.
- `summary(perms) -> str`: one line for people and `pilot ext check` ("network: a.example.com · keys: SHOP_TOKEN ·
  reads: projects/shop", "nothing" for an empty declaration).

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

## maxxing.extcheck / maxxing.cmd_ext (`pilot ext check`)  (owner: organisation)
- `check(id) -> Result | None` (None: no such folder), `check_all() -> [Result]`, `timed_out(results)`. Both start
  with `extensions.scan()` (the server's loading: manifest / block.json, `api.py` imported apart with
  `IMPORT_TIMEOUT_S`; the other extensions are loaded too). A turned-off extension (or `restore_hold`) is `skipped`
  and none of its code runs.
- Routes taken in-process: a `TestClient` on a FastAPI app with the `api.extensions` and `api.blocks` routers,
  `require_auth` overridden (`_client()`); GET `/ext/<id>/widget-frame`, `/ext/<id>/@<page_v>/page.js` (the URL
  pages/ext imports), each module a page imports (resolved with `urljoin` against the module's URL, so
  `extensions.module_file`'s rules apply: a module the server does not serve is a 404 there too),
  `/ext/_blocks/<id>/frame`. Nothing listens, no request leaves.
- Card: `card(ctx)` through `extensions.call(..., timeout=api.dashboard.TIMEOUT_S, key="card:<id>")`, then
  `clean_card` + `widgets.strip_none` (= `widget_card(force=True)` + the dashboard, keeping the raw value to report
  dropped blocks). Exception frames inside the extension folder -> `trace`. A timed-out call keeps an extension
  thread: `cmd_ext` leaves with `os._exit` after printing (the pool's threads are joined at exit otherwise).
- JavaScript: `_node_check(code, name, module, line, col)` writes the code to a temp `.mjs` / `.js` padded with
  newlines and spaces so `node --check` reports the file's own positions (inline scripts), then rewrites the temp path
  (and its realpath) to `name`; None when `node` is missing (a warning step). `_scan_js` is a light scanner (strings,
  template literals and comments skipped) returning the specifiers after `import` / `from` / `import(` and the code
  with comments and string contents removed (for the `mount`, `eval`, `.api(`, storage patterns).
- HTML (`widget.html`, a block's entry): `html.parser` subclass `_Doc` (elements, text, scripts with their
  position, links); an unclosed `<script>` is detected by the parser never closing it.
- Permissions (widget, page): step `permissions` = OK with `permissions.summary` of what the manifest declares, WARN
  when it has no `"permissions"` key (block plugins and agents: no step). Result key `permissions` = the declaration
  or None.
- Result: `{id, name, type, kind, dir, status, error, steps:[{step, status, detail}], files, permissions, card?,
  trace?, timed_out?}`; `status` = worst step (`ok` < `warn` < `error`), `skipped` for an extension that is off.
- `cmd_ext`: `pilot ext check [ID] [--json]`, exit 0 / 1 broken / 2 unknown id / 3 the named one is off. Each result
  also carries `runtime_errors` (`exterrors.recent`), printed after the steps; never part of the status.

## maxxing.extfix - "Ask for a fix"  (owner: organisation)
Reusable by any UI that shows a broken creation (dashboard card, page error state, Settings row, the Atelier):
- `prompt(ext, seen=None) -> str`: the message (English; "Answer me in French." via `smartupdate._reply_in`): the
  extension, its kind and folder, what broke (load `error`, the 3 newest `exterrors.recent`, `seen` = `{message,
  stack?}` the user is looking at unless one of those already says it), the files (`_files`: manifest / block.json,
  entry, `api.py`, `page.js`, `widget.html`, the files the stacks name, resolved inside the folder, 12 at most), the
  skill (`pilot-blocks` for a block) and `pilot ext check <id> --json` before and after.
- `origin(id) -> {id, title, path} | None` (the single lookup of "the session that made it": a live, not archived
  session of `<state>/extension-origins.json`), `origins(ids)`, `record_origin(id, sid)` (kept: the first live one;
  called by `cmd_ext` with `$MAXXING_SESSION` after `pilot ext check <id>`). A provenance record of a creation's session
  should be read first by `origin()`.
- `target(id) -> {"session": origin} | {"topic": smartupdate.update_topic_path()}`; `ask(ext, seen) -> {session,
  reused}`: `service.send_message(origin)` (queued behind a running turn), else on `SessionError` or no origin
  `service.create_session(<harness topic>, prompt, "Fix the extension <name>")`.
- HTTP: `POST /api/extensions/{id}/fix` `{error?, dry_run?}`; `GET /api/extensions` items carry `origin`. Web:
  `features/extensions/AskFix.tsx` (`useAskFix().run(ext, error)` = dry run -> `confirm()` with the message -> send ->
  navigate to the session; `AskFixButton`, `FixTarget`), used by `pages/dashboard` (`BrokenWidget`, an extension card
  whose `card()` failed, with the recorded stack), `HtmlWidget` (the frame's last error under it), `pages/ext` (load
  error state) and `RuntimeErrors` / the load error of a Settings row.

## maxxing.exterrors - runtime errors of extensions  (owner: organisation)
- `<state>/extension-errors.json` = `{id: [{where, message, stack, at, count, sig}]}`, newest first, `KEEP` (10) per
  extension, written with `config.write_json` under a module lock (a stack's first line equal to the message is
  dropped). `record(id, dir, where, message, stack)` bumps
  `count`/`at` of the newest entry when `where`, `message` and `sig` match; `sig` = `files_sig(dir)` (newest mtime of
  the folder's files, one level down, hidden ones, `__pycache__` and `node_modules` skipped: importing `api.py` writes
  its bytecode, which must not hide the errors). `recent(id, dir)` / `all_recent(exts)` return only the
  entries whose `sig` is the current one (an edit of any file hides the older errors), without `sig`; `clear(id)`.
- Writers: `api/extensions.report_error` (browser: `where` widget / page; `allow()` = sliding windows of 60 s,
  `RATE_PER_EXT` 20 and `RATE_TOTAL` 120, in memory, before anything is written; `trim_stack()` keeps 6 lines of 240
  characters and turns `…/ext/<id>/[@v/]x.js?q:12:5` into `x.js:12:5` and `…/ext/<id>/widget-frame:L:C` into
  `widget.html:L-offset:C`, offset = `_frame_offset()` = newlines of `WIDGET_BRIDGE` + the inlined kit),
  `api/extensions.forward` (`where:"api"`: an exception other than ValueError / LookupError, a timeout, a non-JSON
  value; stack = `ext_frames(exc, dir)`, the traceback frames inside the folder) and `api/dashboard._render`
  (`where:"card"`: an exception or the 20 s timeout of an extension card, not when the extension does not load).
  Each write sends `invalidate extensions`.
- Browser side: `WIDGET_BRIDGE` posts `{mx:'error', message, stack}` from the frame's `error` (not a bare
  "Script error.") and `unhandledrejection` (not a `maxxing.api()` rejection with status 0 or 5xx: the reply now
  carries `status`); `pages/dashboard/HtmlWidget` forwards it; `pages/ext` reports a module that fails to import, a
  missing `mount`, a `mount()` that throws, and while mounted the window errors whose `filename` / stack is under
  `/ext/<id>/` and the rejections tagged by its `ctx.api()` (`mxExt`) or whose stack is (an `ApiError` 0 / 5xx left
  out). `features/extensions/report.ts` sends each `where` + message once per extension and page load, 10 at most.

## maxxing.atelier / maxxing.api.atelier / `pilot ext draft|propose`  (owner: organisation)
The Atelier (API.md#atelier): agents' creations staged as drafts, approved by the user, versioned, rolled back.
Extensions first; the other kinds are listed read-only (`atelier.items()` reads themes, skills, customizations and
cron jobs through their own modules, no copy of their data).

- **Draft folders** (where an agent writes): `<session folder>/.atelier/<id>/`, the session folder being
  `<workspace>/<session path>` of `$MAXXING_SESSION` (`<workspace>/.atelier/<id>/` without a session: the user's own
  terminal). Both agents can write there: Claude anywhere, Codex in its session folder (workspace-write sandbox;
  `.atelier` is not one of `codex.WORKSPACE_READ_ONLY`), whereas `<workspace>/extensions` is read-only for Codex
  (`codex.SERVER_CODE`). `pilot ext draft <id>` creates it and prints its path: a copy of the extension's active
  files when it exists (so a change starts from what runs), `--from-draft <did>` = the files of an earlier proposal,
  `--reset` replaces an existing folder; otherwise an existing folder is left as it is. Hidden entries, `__pycache__`
  and `node_modules` are never part of a draft (nor of a version).
- **Proposing** (`pilot ext propose <id> [--summary TEXT] [--dir PATH] [--json]`, `cmd_ext`): static check of the folder
  (`atelier.check_dir(dir, id)`, below; errors -> exit 1, nothing registered), then a request
  `<draft folder>/.proposal.json` `{draft: "d_<12 hex>", id, summary, session, agent, at}` (`session` =
  `$MAXXING_SESSION`, `agent` = `$MAXXING_AGENT`, both set by the runner for every turn: Claude, Codex and agent
  plugins), then `atelier.register(folder)` in the CLI process. Registering needs to write `<state>`: it works for
  Claude and for the user; Codex's sandbox refuses it (PermissionError), the request then stays and the server
  registers it when that session's turn ends (`service.on_turn_end` -> `atelier.ingest_session(session)`: the
  `.atelier/*/.proposal.json` of that session's folder only). Either way the draft id is the one the CLI printed, so
  the agent's `proposal` block is valid before the registration. Output: the draft id, its state
  (`pending` / `queued` - registered at the end of the turn / `active` - auto-activated), the declared network hosts
  and secrets, and the `proposal` block to put in the answer. Exit 0 registered or queued, 1 check failed, 2 no draft
  folder / bad id, 3 `restore_hold`.
- **Registering** (`register(folder, request)`, under the Atelier lock): the files are copied into
  `<state>/atelier/drafts/<did>/files/` (a frozen copy: what the user reviews is what gets installed; later edits of
  the folder need a new proposal), the check runs again on that copy, `draft.json` is written (API.md `Draft`, plus
  `source_dir` = the agent's folder and the file list `{path: {sha256, size}}`), the request file is removed, an older
  pending draft of the same id becomes `superseded` (its feed event resolved), `atelier.proposed` is posted
  (`feed.system`, group `atelier:<did>`), `rev` is touched. The origin is read from the request but checked: a
  `session` that does not exist, or (server-side registration) whose folder is not the one scanned, becomes that
  folder's ending session / unknown. Limits per draft: 2000 files, 64 MB (`413`-like CLI error `too_large`), ids
  `extensions.ID_RE`, not a reserved widget id.
- **Static check** (`check_dir(dir, id) -> {status, steps}`): never imports or runs the draft. `extensions._load_one`
  with `load_code=False` (manifest / block.json validation, no import), `compile()` of `api.py` (syntax), and the
  document / module steps of `extcheck` that do not run code (`_check_document`, the page's module walk with
  `_scan_js` + `node --check`, resolved against the draft folder instead of the routes). `pilot ext check <id> --dir
  PATH` (agent side) runs the FULL extcheck on a temporary copy (`extensions` root overridden for the process,
  `ctx.state_dir` a temporary folder): the code runs with the agent's own rights.
- **Approving** (`approve(did, base=None, by="user")`): Atelier lock, then `extensions.publishing()`; check again;
  `stale` when `base` is given and differs from the active version; the live folder is snapshotted first when it
  differs from the active version (`direct` version, `approval.by: null`); the frozen files are written to
  `<workspace>/extensions/.atelier-new-<did>/`, the live folder renamed to `.atelier-old-<id>-<ns>` and the new one
  renamed to `<id>` (both renames inside `publishing()`, so a scan never sees the gap; hidden folders are never
  scanned), the old one removed; version `n = max + 1` recorded (`base`, origin, approval); `extensions.scan()`
  in a thread (hot reload would see it too); feed resolved; `rev` touched; bus `atelier` + `extensions`. A failure
  before the second rename leaves the live folder untouched; after it, the old folder is renamed back.
- **Versions store** (content-addressed): `<state>/atelier/objects/<sha[:2]>/<sha256>` = file contents (0600, shared
  by every version and draft that has them); `<state>/atelier/items/<kind>/<id>.json` = `{kind, id, active,
  versions: [{n, at, files: {path: {sha256, size, mode}}, hash, base, origin, approval, restorable, health, error,
  note}], history: [Event], live: {sig, hash, checked}, unreviewed_since}`. `hash` = sha256 of the sorted
  `path\0sha256\n` lines. A rollback (`rollback(kind, id, n)`) installs version `n`'s blobs the same way as an approval
  and moves `active`; no new version. Health: when a version stops being active, `health` = `error` when an error
  was recorded for the extension while it was active (`exterrors` entries newer than its activation, or a load
  error), else `ok`; the active one is `unknown` until then.
- **Changes outside the Atelier**: `live.sig` = sha256 of the folder's `(path, size, mtime_ns)` list (same walk and
  exclusions as a snapshot); `refresh()` (each listing, at most every 2 s) re-hashes the files of a folder whose
  `sig` changed and compares the result with the active version: equal (a touch) -> new `sig` stored; different ->
  `unreviewed_since` set (nothing else: it keeps running as before). `accept` makes those files a version
  (`approval.by: "user"`); an approval or a rollback first keeps them as a `direct` version, so nothing is lost.
- **Migration**: the first `refresh()` after the Atelier exists (`<state>/atelier/state.json` without `migrated_at`)
  records every extension folder as v1, `approval.by: "migration"`, origin unknown; later, a folder with no record
  (written outside the Atelier) gets v1 with `approval.by: null` and `unreviewed`. Pins written by `blocks.pin` and
  extensions installed by packs are recorded as approved by the user (`origin.agent: "user"`).
- **Retention** (`prune()`): versions older than config `atelier.keep_days` (90) beyond the `keep_versions` (10) newest
  go, never the active one nor a pending draft's base; decided drafts after 30 days; then unreferenced objects.
  After each approval and from the daily server loop.
- **Lock**: `atelier.locked()` = thread RLock + flock on `<state>/atelier/lock` (the CLI and the server); it is
  always taken before `extensions.publishing()`, never inside it.
- **Bus**: `rev` (`<state>/atelier/rev`, its mtime) is touched by every write; `api/atelier` polls it every 2 s and
  sends `invalidate atelier`, so a proposal registered by the CLI reaches open browsers.
- **Backup**: the GitHub memory backup adds `_maxxing/atelier.json` (`export_meta()`: each item's versions - `n, at,
  hash, base, origin, approval, health, error, note, size, file_count` - and its 50 newest history events, never file
  lists nor contents: a few kB). A restore (`backup._apply`, after the files) calls `import_meta()`: an item this server
  approved nothing for (no version `approval.by` user / auto) gets the backup's record with `restorable: false`
  versions and `live.sig` null; the next `refresh()` sees its folder, and when the files hash to the active version's
  `hash` it snapshots them (that version is restorable again) - no `unreviewed` flag. Older versions stay
  metadata (`409 not_restorable`). The extension files themselves are the workspace's (`extensions/**` include
  pattern). The complete instance backup has all of `<state>/atelier/`.
- **Rollback / diffs**: `rollback(kind, id, n)` (`400 bad_version`, `404`, `409 not_restorable` when a blob is missing,
  `422 not_versioned`); `version_detail(kind, id, n, against)` diffs blob contents (`diff_files`).
- **Retention**: `prune(now)` runs inside `approve` and from the API watcher once a day (`prune_due`: `pruned_at` of
  `state.json` older than `PRUNE_EVERY_S`, checked every hour); it returns the counts dropped.
- **Other kinds** (`maxxing/atelier_kinds.py`, `items()` / `detail()`): themes = `themes.saved()` (active = the
  applied palette by `themes._colours`, else `disabled`; origin only for `created` / `received` entries); skills =
  `<workspace>/.claude/skills/*/SKILL.md` and `<workspace>/.agents/skills` (product skills excluded; `agents` = which
  agent reads it); customizations = `customs.list_customs()` cached 30 s per `.git/HEAD` mtime (`review` while
  `customs.pending()` is a `conflict` whose files touch it, or lists its title when it names no file); cron jobs =
  `crons.list_jobs()` (`disabled`, `error` after a failed last run). Read-only: `actions` is empty, rollback is
  `422 not_versioned`. One kind failing never hides the others.
- **Workspace skills for Codex** (`atelier_kinds.mirror_skills()`): Codex reads its personal skills folder
  (`cmd_core.codex_skills_target()`, where the product skills are) and `.agents/skills` from a session's folder up to
  its Git root, never Claude's `.claude/skills`. Each `<workspace>/.claude/skills/<name>/` (not a product skill name, not
  a link) is copied there with a marker `.pilot-workspace-skill` (= the source's stat signature: copied again when it
  changes); a folder there without the marker (the user's own, a product skill) is never touched; a marked one whose
  source is gone is removed. Run at the API's startup and every 5 minutes. Project-level skills
  (`projects/<p>/.claude/skills`, loaded by Claude only in that project's topics) are not mirrored: in Codex's folder
  they would reach every session - a known gap.
- **Runner**: every turn's environment carries `MAXXING_SESSION` (the session id) and `MAXXING_AGENT` (`claude`,
  `codex`, `plugin:<id>`): Claude turns, Codex turns and agent plugin turns.
- **Hooks in `extensions`**: `_load_one(d, load_code=False)` validates a folder without importing `api.py` (drafts;
  the permissions declaration is parsed before the import, so a draft gets it too); `_import(ext, name)` imports a
  draft's `api.py` under `mx_draft_<did>` for a preview (kept per draft while its files are unchanged, dropped on a
  decision: `atelier.forget_preview`); `_root_override` / `_state_override` (the extensions root and the extensions'
  data folder of the process) are set only by `pilot ext check --dir`, on a temporary copy, and restored after it.
- **Preview** (`api/atelier.preview`): `preview_ext(did)` (pending, check not failed) + `preview_ctx` (the installed
  extension's ctx; `secret()` limited to the declared secrets when the draft declares `permissions`); card widgets run
  `card()` with `api.dashboard.TIMEOUT_S` on the extension threads (key `draft:<did>`) and get the dashboard's
  cleaning; HTML widgets get `/ext/_drafts/<did>/widget-frame` (the `widget-frame` document of api/extensions.py) and
  `/api/atelier/drafts/<did>/api/<path>` (their `handle()`, the `/api/ext/<id>` rules). Pages, blocks and agents:
  `kind: none`.
- **User installs**: `record_user_install(id, note)` records an extension the user made in the app as a version
  approved by the user (`blocks.pin` calls it for dashboard pins).
- Mock: `web/mock/atelier.mjs` (`installAtelier`, `serveDraftFrame`): every route above, with seeded items of every
  state and kind (pending, active, error, disabled, review, unreviewed; extension, pin, theme, skill, customization,
  cron) and two drafts (a new HTML widget, a change with a diff).

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
- Web: `features/notifications/push.ts` (`subscribeBrowser`, `usePushSync`) through `enrollment.ts` (`enrollPush`,
  `activeRegistration`) and `lib/browser-request.ts`: each native step (permission, subscription, key replacement)
  runs under one 30 s deadline and stops on abort; a late native answer is ignored, never sent to the server.

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

## maxxing.local_service  (owner: organisation)
- `status() -> dict` - GET /api/system/local-service, read-only: `{supported: false}` unless `HARNESS_PILOT_LOCAL_MODE=1`
  and `is_mac()`. Looks for `<agents_dir()>/<label>.plist` (labels tried: `XPC_SERVICE_NAME`,
  `HARNESS_PILOT_SERVICE_LABEL`, `DEFAULT_LABEL` `local.harness-pilot`, only `[A-Za-z0-9._-]`), read with `plistlib`
  (64 kB at most, a broken file = absent); it is this installation's when `ProgramArguments` holds this checkout's
  `scripts/dev-local.sh` and its `HARNESS_PILOT_LOCAL_DIR` (if set) is this local dir (`HARNESS_PILOT_LOCAL_DIR`, else
  `config.STATE.parent`). `running` = `XPC_SERVICE_NAME` is that label (launchd sets it for the jobs it starts; dev-local.sh,
  uv and the server inherit it), `since` = `STARTED` (module import, with the API routers). `commands(label, port,
  local)`: `bash <repo>/scripts/dev-local.sh service <action>` prefixed by the settings that are not the defaults,
  shell-quoted, plus `update` = `git -C <repo> pull`. Never calls `launchctl`, never writes a LaunchAgent.
- `agents_dir()` = `MAXXING_LAUNCH_AGENTS_DIR` or `~/Library/LaunchAgents`; conftest points every test to a temporary
  folder.

## maxxing.hostcheck (DNS rebinding)
`HostCheck` (ASGI, inside `_SecurityHeaders`, outside every other middleware) refuses an HTTP request with `421
bad_host` and closes a WebSocket (1008) before it is accepted when `allowed(host)` is false. `allowed`: no Host, an IP
literal, `localhost` / `*.localhost` / `*.ts.net` / `*.local` (`_OWN_SUFFIXES`), else the hostnames of config `public_url`, `bind`, `allowed_hosts` (list or one
string) and `MAXXING_ALLOWED_HOSTS` (comma separated, `*` = off); `hostname()` drops port, case and a trailing dot.
Config is read only for names. Tests: conftest sets `MAXXING_ALLOWED_HOSTS=testserver,t` (the test clients' hosts).

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
- CLI `pilot 2fa status|off|forget-browsers` (`cmd_twofactor.py`): the way back in when Telegram does not answer
  or the phone with the authenticator app is lost (`off` turns both methods off).
- `required()` = `enabled()` or `totp.is_on()` (what `POST /api/auth/login` checks). A `login` challenge carries
  `methods`: `"totp"` when the app is on, `"telegram"` when the app is off (as before) or Telegram is on and linked
  (an `enable` challenge is Telegram only). Telegram is sent only with `"telegram"`; when that send fails and the app is on, the challenge
  keeps `("totp",)`. A TOTP-only challenge lives `TOTP_TTL` (300 s). `check(id, code)` tries `totp.verify(code)` first
  (`via` `totp` | `recovery`), then the Telegram code; wrong ones share `CODE_TRIES` and `BAD_MAX`.

## maxxing.totp (two-step sign-in with an authenticator app)
- RFC 6238: HMAC-SHA1, 6 digits, `STEP` 30 s, `DRIFT` 1 step either way; `hotp()`, `code_at()`, `uri()` (otpauth link,
  issuer `harness-pilot`). Secret: 20 random bytes, base32.
- secrets.json (mode 600, no other encryption, like the password hash): `totp_pending` `{secret, created}` (`begin()`,
  `PENDING_TTL` 600 s) and `totp` `{secret, last_step, enabled_at, recovery:[sha256 hex]}` (`confirm(code)` -> the 10
  plain recovery codes, 80 bits each, returned once).
- `verify(code)` under `config._lock`: a 6-digit code must match a step > `last_step` (stored on success: no replay,
  the enrolment code included); otherwise a recovery code (normalised: case, spaces, dashes, 0/1/8 -> O/I/B) is
  removed from the list on use. `regenerate(code)` (under the same lock): a verified code -> a new list of
  `RECOVERY_COUNT` codes replaces the old one (`TotpError` `bad_code` / `not_on`). `disable(code=None)`: with a code only when it verifies (Settings), without at once
  (`pilot 2fa off`). Throttling is the callers': `twofactor.check` at sign-in, `api/auth._reauth` (password-change
  throttle) for enable / disable.

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
  `--if-due`), `backup.run()` (code `paused`, not recorded in the history) and scheduled instance archives
  (`instance_backup.schedule_delay()` is None) do nothing.
- Scheduled instance archives: config `instance_backup_schedule` `{frequency, hour, keep, since}` + secret
  `instance_backup_schedule_key` `{salt, kdf, key}` (hex; a key derived from the passphrase, never the passphrase).
  `instance_backup.set_schedule()` / `disable_schedule()` / `schedule_status()`; `schedule_delay()` -> seconds until
  due (None: off or paused); `export_scheduled()` = `export(None, sealed=(salt, kdf, key), keep=keep)` (marks the
  export `scheduled`, prunes the older scheduled ones under the operation lock); `record_scheduled(result | code,
  message)` keeps `<state>/instance-backups/schedule.json` (last success, error, `retry_at`, `notified`) and posts
  or resolves the feed group `instance-backup-schedule`. The loop is `api.instance_backup.scheduler(export)`, a task
  of the app lifespan outside the pausable modules, given the app's snapshot wrapper (`export_instance(None,
  scheduled=True)`): pausing services for the snapshot never cancels it.
- Copy folder: config `instance_backup_copy` `{folder}`; `instance_backup.set_copy_folder()` (absolute, existing,
  writable, outside the included roots) / `disable_copy()` / `copy_status()`; `copy_export(id)` streams, fsyncs,
  reads back and compares size + SHA-256 before the rename, stores the record in the export's `.json` and posts or
  resolves the feed group `instance-backup-copy`. The app's `export_instance` calls it after services resume and
  outside the activation lock, for manual and scheduled exports alike.
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
- Claude and Codex jobs (`_run_agent`) call `sessions.service.create_session(..., provider=<kind>, source="cron", cron=True,
  env={MAXXING_CRON_ID, MAXXING_CRON_NAME}, timeout_s)` (or `send_message` when `reuse_session`; a remembered session of
  the other agent - the job's kind changed - is not reused), then `wait_turn` + `last_result` + `last_assistant_text`.
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
- Local mode (`HARNESS_PILOT_LOCAL_MODE=1`, no crontab): `api/crons._local_schedule` runs `localcron.catch_up()`, then
  `localcron.boot()` once (every enabled `@reboot` job -> `spawn_run`; `already_running` skipped; nothing while
  `integrations_paused`), then `localcron.tick()` every 15 s (the current minute, claimed in
  `<state>/local-cron-minutes.json`; never `@reboot`).
- Local scheduler catch-up (`localcron.catch_up(now)`): heartbeat
  `<state>/local-cron-alive.json` `{at}` written by `tick()` once per minute (also while `integrations_paused`) and by
  `catch_up` itself before it starts anything (a crash never repeats it). For each enabled job with `catch_up` (not
  `@reboot`, not due this minute) and at least one `iter_runs` time after max(heartbeat, job `created`, `updated`) and
  before the current minute: one `spawn_run` + `feed.system` `cron.caught_up` (info). No heartbeat yet = first start: nothing.
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

Codex turns get the same servers (`sessions/codex.mcp_config(cwd, env)`, called by `runner._codex_turn`): the
servers Claude Code would load in the session's folder (`mcp_auto.candidates`: user scope minus the folder's disabled
ones, local scope, approved `.mcp.json` of the folder and its parents; `harness-pc` excluded), turned into
`-c mcp_servers.<name>={...}` inline TOML tables (checked with codex-cli 0.150.1, `codex mcp list --json`), next to
`--ignore-user-config`, so the user's own Codex config is never read nor changed. `${KEY}` / `${KEY:-default}`
references are expanded from the turn environment plus the vault keys flagged `expose`; no secret is put on the
command line: a stdio `env` value that is not plain goes in the Codex process environment under its own name and in
`env_vars`, a non-plain HTTP header in `MAXXING_MCP_H<n>` and `env_http_headers`; plain values stay in `env` /
`http_headers`. Skipped, with the reason (`-> skipped [(name, reason)]`): names outside `[A-Za-z0-9_-]{1,64}`,
`sse` / `ws` transports (Codex has streamable HTTP and stdio only), an address or program arguments carrying a key
(literal, or a reference to a vault key: it would be on the command line), a secret env value whose name is reserved (`PATH`, `HOME`, `CODEX_*`, `OPENAI_*`...) or already set in
the turn environment with another value (the same value is forwarded as is and not hidden), a reference with no value.
Every server gets `default_tools_approval_mode = codex.tools_approval(mode)`: `codex exec` never asks and its sandbox
does not cover MCP tools; checked with codex-cli 0.150.1 against a stub model and MCP server: unset / `auto` /
`writes` run only `readOnlyHint` tools and refuse the others ("requires approval, but approval policy is never"),
`prompt` refuses all, `approve` runs all. So `writes` in plan / default / acceptEdits, `approve` in bypass only; the
runner notes once (meta `codex_mcp_tools`) when the read-only rule applies. Claude's OAuth sign-ins and claude.ai connectors are not shared (Codex keeps its own tokens).
The runner notes the skipped servers in the conversation when that list changes (meta `codex_mcp_skipped`).

## maxxing.sessions.codex - sandbox and Protect the secrets
`codex.sandbox_args(mode)` is the sandbox of every `codex exec` the server starts (`command()`: turns, scheduled jobs,
companions, summaries; `fork_command()`: side questions, always read-only): read-only in `default` / `plan`,
workspace-write otherwise, never full access. Read-only with config `protect_secrets` off, or when none of
`spawn.secret_paths()` exists (`<state>/secrets.json`, `~/.ssh`, `codex.home()/auth.json` = CODEX_HOME else
`~/.codex`, `config.claude_dir()/.credentials.json`; the same list gives Claude's deny rules): `--sandbox read-only`.
Otherwise a Codex permission profile: `-c default_permissions="protected"` and `-c permissions.protected={extends =
":read-only" | ":workspace", filesystem = {...}}`, with `"<path>" = "deny"` for each existing secret path (absolute,
not resolved: Codex canonicalizes). `_deny`: codex-cli 0.150.1 reads a path holding `* ? [ ] { }` as a glob, so
`<state [1]>/secrets.json` as is matched `<state 1>/...` and protected nothing (checked); `_glob_literal` brackets
those characters, and a folder written that way also gets `<folder>/**` (a pattern of a folder does not cover its
files, checked). No `--sandbox` then: it silently replaces `default_permissions`.
Workspace-write is ALWAYS that profile (whatever `protect_secrets`; `command(..., cwd=)` gets the turn's folder from
`runner._codex_turn`), with `_write_entries(<workspace>, cwd)`: what the server or Claude runs outside Codex's
sandbox, as the server's user (root on a server installation), so that a write there would escape it. A Codex session
can run at the workspace root (`topic_dir("")`) or a project, whose writable folder holds other session folders:
- `":workspace_roots"` (relative to the turn's folder): `"." = "write"`, `WORKSPACE_READ_ONLY` = `.git`, `.codex`,
  `.agents` and the folder's own `SESSION_CONFIG` (`.maxxing.json`: its permission mode, setting `bypass` frees Claude
  there; `.claude`: Claude Code's settings with hooks / MCP servers / helpers, hook scripts, skills; `.mcp.json`) =
  `"read"`; plus `SESSION_CONFIG` of every session folder below it, listed when the turn starts
  (`_session_folders_below`: at the root every `projects/<p>` and `projects/<p>/topics/<t>`, at a project its
  topics; slug names only), and at the root `SERVER_CODE` = `extensions` (api.py imported by the server, agent
  providers it starts, block plugins), `customizations` (patches `pilot custom restore` applies to the code),
  `infra.json` (ssh targets of the server; Claude's deny rules have it too).
- The same `SERVER_CODE` and root `SESSION_CONFIG` as absolute `"read"` entries (they also cover a workspace under
  `/tmp`, writable to every turn), except for a workspace path holding glob characters: Codex refuses `"read"` on it
  ("filesystem glob path ... only supports `deny` access") and the turn would not start; the relative entries cover
  it from the root. `extensions/` is created first.
- `SESSION_PATTERNS`, `"deny"` patterns `<workspace>/projects/*[/topics/*]/{.maxxing.json, .claude/settings.json,
  .claude/settings.local.json, .claude/hooks/**, .mcp.json}`: on macOS they also cover a folder made during the turn
  (and Codex cannot read those files there); on Linux they protected nothing in our checks.
- A profile longer than `PROFILE_MAX` (120 000 characters: Linux refuses one argument over 128 KiB), i.e. hundreds of
  topics below a root or project turn: that turn gets the read-only sandbox instead of an unprotected one.
- Way out: config `codex_plain_sandbox` (default false, set by hand in config.json) gives the plain `--sandbox` in
  every mode, without the secrets denied and without any of the entries above, for a machine where bubblewrap cannot
  start a profile's sandbox. `runner._codex_turn` notes `codex.SANDBOX_HINT` (namespaces, or that key and what it
  loses) when a failed Codex turn's stderr has one of `SANDBOX_START_ERRORS` ("fs sandbox helper failed", "No
  permissions to create new namespace").
Checked with codex-cli 0.150.1, `codex exec` with the argv of `command()` / `fork_command()` against a stub Responses
API (no model call; temporary `CODEX_HOME` and `HOME`, workspace outside `/tmp` and `$TMPDIR`), a shell tool call
trying 27 reads and writes from the root, `projects/p` and `projects/p/topics/t`, in every mode, with secrets, and in a
workspace path with `[ ]` and a space; on macOS (Seatbelt) and in Debian 12 arm64 containers (codex-cli from npm,
bubblewrap 0.8.0) as root in a privileged container and as uid 1000. Before (the same matrix on main), a write turn at
the root wrote `extensions/x/api.py`, created `extensions/new/`, renamed `extensions/`, wrote `customizations/`,
`infra.json`, every folder's `.maxxing.json`, `.claude/settings*.json`, `.claude/hooks/x.sh` and `.mcp.json`. After:
every turn starts; all of those are refused (write, create, rename, delete, through a symlink) at every level, while
the turn's folder and the ordinary files of the folders below stay writable and reads work; the same in the `[ ]`
path. Left: on Linux, a session folder created during the turn (`projects/p/topics/n/.maxxing.json` from a root or
project turn) is writable until the next turn lists it (macOS: refused by the patterns). Side effect: renaming or
deleting a folder that holds a protected file is refused. In a default (unprivileged) container every profile turn
fails at start ("failed to load AGENTS.md instructions ...: fs sandbox helper failed"), read-only ones too when a
secret path exists; with `codex_plain_sandbox` the turn runs and each command fails ("bwrap: No permissions to create
new namespace"), the behaviour before.
Also found, not changed here: on Linux a secret path holding glob characters (`<state [1]>/secrets.json`) is not
denied, as before (`_glob_literal` fixes it on macOS only); and `exec fork` of a thread started in a write mode keeps
that thread's writable folder despite `fork_command()`'s read-only profile (a side question can write the topic
folder; its protected entries stay protected), on main as well.
Claude in `bypass` can write all of this as the server's user: that is the mode's documented meaning (15-security), a
separate design point not changed here; Claude's deny rules keep only `.maxxing.json` and `infra.json` out of its edits.
Checked with codex-cli 0.150.1 on macOS (Seatbelt), `codex exec` against a stub Responses API and fake secrets:
- `deny` refuses read, write, rename, delete, `stat` and directory listing to every command Codex runs (shell,
  `python open()`, `cp`, `find`), through a symlink, through `/tmp` vs `/private/tmp`, inside the writable folder (it
  beats `"." = "write"`), and makes `ln` (hard link) fail; spawned sub-agents (`multi_agent_v1.spawn_agent`), `exec
  resume` (also of a thread started with `--sandbox`) and `exec --ephemeral fork` get the same profile. A missing
  path is accepted (only existing ones are passed anyway).
- A profile that `extends = ":workspace"` loses the built-in's read-only `.git`, `.codex` and `.agents` (the built-in
  `:workspace` and `--sandbox workspace-write` keep them), hence the `:workspace_roots` table; with it, writes match
  `--sandbox workspace-write` (folder and below, `/tmp`, `$TMPDIR`; not the repository root above the folder, its
  `.git`, nor other folders; `.git` / `.codex` / `.agents` cannot be created), network stays off, and MCP tool
  approval (`tools_approval`) behaves the same.
- A topic's `.codex/config.toml` with `sandbox_mode` does not switch the profile off (`--ignore-user-config`: no
  folder is trusted); a `sandbox_mode` in `/etc/codex/config.toml` would (the docs say any loaded `sandbox_mode` or
  `--sandbox` wins over `default_permissions`).
- Not covered: MCP servers (Codex starts them outside its sandbox: a server could read the file), `view_image`
  (read by the Codex process: a real image in those folders still reaches the model; a key or `secrets.json` gives
  "unsupported image data"), and `apply_patch`'s verification, done in the Codex process before the sandboxed write
  is refused: it never returns the file, but its error tells a matching context line from a wrong one.
Linux (bubblewrap): the same checks in Debian 12 arm64 containers (codex-cli 0.150.1 from npm, bubblewrap 0.8.0), as
root (privileged container, like the server's own root) and as uid 1000 (user namespaces): the argv of `command()` /
`fork_command()` in every mode, resume and fork refuse both paths (`Permission denied`; the path is masked, so `ln`
gives "Invalid cross-device link" and `mv` "Device or resource busy"), writes / `.git` / `/tmp` / network match
`--sandbox`, and a missing deny path is accepted. Where bubblewrap cannot create namespaces (a default unprivileged
container): with `--sandbox` the turn runs and every command fails ("No permissions to create new namespace"); with
the profile the turn fails at start ("fs sandbox helper failed": Codex reads AGENTS.md through the sandbox). Codex
refuses to put its `codex-linux-sandbox` helper under `/tmp`: a `CODEX_HOME` there breaks both forms. Managed
`requirements.toml` `deny_read` would work with `--sandbox` but lives in `/etc/codex` (root, every Codex run of the
machine): not used.
The agents' sign-ins: denying Codex's own `auth.json` does not stop Codex, whose process reads it outside its sandbox.
Checked on macOS and in the Linux containers (root and uid 1000) with a fake CODEX_HOME (`auth.json` in API-key
mode; `cli_auth_credentials_store` defaults to `file` in 0.150.1) and a stub provider with `requires_openai_auth`: the
stub got the key from `auth.json` in `exec`, `exec resume` and `exec --ephemeral fork` while `cat` of `auth.json` and
of Claude's `.credentials.json` was refused; `codex login status` (no sandbox) still reports the sign-in and the
file is left as it was. A ChatGPT sign-in refreshes its tokens from the same process (not exercised: it needs the
real service). Codex's MCP OAuth tokens (`mcp_oauth_credentials_store`, keyring or a file of CODEX_HOME) are not in
the list. On macOS Claude Code keeps its sign-in in the Keychain: no file to deny there.

Token counts. `turn.completed.usage` of `codex exec --json` (`input_tokens` with the cached ones inside,
`cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`) is the thread's
running total, not the turn's: the sum of every model call of every turn of the thread so far, `exec resume`
included. Checked with codex-cli 0.150.1 against a stub Responses API that reports growing usage per call: a turn
of two calls (102k + 103k input) reported 205k; the next turn, resumed in a new process (104k), reported 309k; the
one after (105k + 106k), 520k. `codex.usage_totals(event)` reads those counters; `runner._codex_turn` passes meta
`codex_usage` `{thread, total}` (the totals after that thread's last turn) as `codex_base` when it resumes the same
thread, and `codex.events(event, base)` maps `turn_usage(totals, base)` - what they grew by (the totals as they are
for a new thread, an unknown base, or a total below its base). After the turn the runner stores the new totals
with the thread id `thread.started` gave. Tokens of a failed or stopped turn (no `turn.completed`) are counted with
the thread's next turn. Turns recorded before this change keep the totals they were given (the log does not say
where a Codex thread starts, so they are not recalculated).

Context size. The JSON stream carries neither the context of a model call nor the window (nor the model's name):
`turn.completed` only has the running totals above. Codex writes both to its own session file,
`<CODEX_HOME, else ~/.codex>/sessions/YYYY/MM/DD/rollout-<local start time>-<thread id>.jsonl` (the day the thread
started; `exec resume` appends to it; not written with `--ephemeral`): after every model call an `event_msg` line
`{"type": "token_count", "info": {"total_token_usage": {...}, "last_token_usage": {"input_tokens", "cached_input_tokens",
"output_tokens", ...}, "model_context_window": 258400}}`, and `task_started` / `turn_context` lines with the window and
the model. Checked with codex-cli 0.150.1 against the stub: `last_token_usage.input_tokens` is the input of that call
(102k, 103k... as served), `model_context_window` is the catalog's `context_window` x `effective_context_window_percent`
(`codex debug models --bundled`: 272 000 x 95 % = 258 400 for every listed model, `gpt-5.6-sol` - the default -,
`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`...; a model without metadata gets the same fallback;
`-c model_context_window=150000` gives 142 500). Codex compacts its own thread at 90 % of the catalog window (244 800:
a 240k call did not trigger it, a 245k one did); the file then has a `compacted` line and a `token_count` whose
`last_token_usage` is 0 until the next call, and the JSON stream only an `error` item ("Heads up: Long threads and
multiple compactions..."). The TUI's `/status` reads the same events; `codex exec` has no command or flag that prints
them.
`codex.session_file(thread, env)` finds the file in `codex.home(env)` (the Codex process environment: `CODEX_HOME`,
else `$HOME/.codex`); thread ids are UUIDv7, so the day of their timestamp (+-1) is looked at first, then every day
folder; an id that is not `THREAD_ID_RE` is never looked up. `codex.context_usage(thread, env, first)` reads the last
`token_count` in the file's last 256 KB (4 MB when none is there) -> `{tokens: last_token_usage.input_tokens, window:
model_context_window (DEFAULT_WINDOW 258 400 when missing), first: the input of the file's first call (with `first`)}`,
None without file, without a call or when the last call is 0 (just compacted). `runner._codex_turn` calls it after the
turn (also in discussions, for `_debate_due`) and sets `Attempt.context_tokens`, `first_context` and `context_window`; `_record` stores
meta `context_tokens`, `base_tokens` (a thread this turn started) and `context_window`, as for Claude. It is Codex's
own count, not an estimate, measured against the window Codex itself uses; it depends on a file format internal to
Codex: when the file is missing or its format changes, the session keeps its last values (none at first) and the gauge
stays hidden rather than guessing. No setting overrides the window: Codex records the one it applies.

## maxxing.codex_login - signing Codex in from the web app
Settings → Codex and the wizard's Codex step sign the CLI of `sessions.codex.binary()` in, with the server's own
environment (the same `CODEX_HOME` as `codex.status()` and the turns). Codex keeps the credentials in its folder
(`auth.json`, 0600) as `codex login` in a terminal does; harness-pilot stores nothing. What codex-cli 0.150.1 offers
(checked with a throw-away `CODEX_HOME`): `login --device-auth` (ChatGPT account), `login --with-api-key` and
`--with-access-token` (read on stdin), `login status` (exit 0/1, one line on stderr), `logout`. Not used:
`--with-access-token`, and the browser flow of plain `codex login`, which signs in through a browser on the machine
that runs Codex (not tried: it would open one).
- Device code: `start()` runs `codex <privacy_args> login --device-auth` (stdin closed, stdout+stderr piped,
  `NO_COLOR=1`, own process group) once per server process; a second start joins it. A reader thread strips ANSI
  and takes the first `https://` link (a later one with `/device` or `auth.` replaces a notice's link), then the first
  code shaped `XXXX-XXXXX` after it, and "expires in N minutes": both seen → `waiting`. Exit 0 → `succeeded`
  (`bus.invalidate("health")`), else `failed` with the CLI's last line (codes and `sk-…` masked). A watcher thread
  stops the CLI (SIGTERM then SIGKILL on the group, then reaps it) with no code after `SHOW_TIMEOUT_S` (30 s) or
  `GRACE_S` (30 s) after the expiry → `failed` / `expired`. `cancel()` → `cancelled`; the first final state wins.
  Nothing of the output is logged; the code lives in memory until the flow ends.
- API key: `with_api_key()` stops a device flow, then `codex login --with-api-key` with the key on stdin (30 s);
  the error is the CLI's last line with the key and `sk-…` masked. The route checks the key itself (`valid_key`:
  20-4096 printable ASCII characters, no spaces) so that no validation error repeats it. Codex does not verify a key
  when it stores it. `logout()` = `codex logout` ("Not logged in" counts as done).
- `codex.status()` now captures the status line (stderr) to tell `method` (`chatgpt` / `api_key`); the line itself
  (a masked key) never leaves the function.
- Tests: `tests/test_codex_login.py` (a fake `codex` with each subcommand, its state in the test folder).

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
`pc_agent.json` = `{version, url ("…/releases/download/pc-agent-v{version}/{name}" of this repository), files:
{<file name of TARGETS>: sha256}}`, written by `pc-agent/build.sh` (`dist/pc_agent.json`, docs/dev/PC-AGENT.md);
empty `files` = nothing to download (`available()` false, `PcError 409 no_agent` / `404 no_agent`); a release file
that cannot be fetched is `PcError 502 download_failed`, one that does not match is `502 checksum`.
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
- `verify() -> report` (`update/report.json`): `extensions.scan()`, `extensions.compute_card` for each Card widget
  (no cache; fails on an exception, an invalid card, or a non-empty `error` card() returned instead of raising -
  `card_error`, read from the raw card because `clean_card` drops that key; `status: "error"` alone is a data alarm,
  not a failure), `node --check page.js` when node exists, each customization's `check` (shell, cwd workspace,
  `MAXXING_CODE`, 60 s).
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

## maxxing.sessions.spawn - companion sandbox
`settings_args(cfg, sandbox)` adds `COMPANION_SANDBOX` (`{enabled, failIfUnavailable: true, allowUnsandboxedCommands:
false, autoAllowBashIfSandboxed: false}`) to the turn's `--settings`; the runner passes `companion_sandbox(cfg, meta)`
= config `companion_sandbox` and `meta.companion` set (experiments, mission steps, planner). Codex turns and external
adapters are unchanged. Options and limits: `docs/dev/COMPANION-SANDBOX.md`.

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
- Plan mode in a discussion (runner): its turns use `DEBATE_PLAN_PREFACE` instead of `PLAN_PREFACE` (Claude, agent plugin and Codex paths); a `plan_approved` item becomes `DEBATE_PLAN_APPROVED_PREFACE` + text in `turn`, and `_debate_followup` pauses the exchange after it (`discussion_pause_reason` `user`, next reply in `debate_pending`).
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
Doctor on macOS (`cmd_core`, read-only): `_listen_addrs` runs `lsof -w -nP -a -iTCP:<port> -sTCP:LISTEN -Ftn`
(`-w`: lsof warnings such as a stale network mount stay out of the output `run()` merges; `-Ftn`: each socket's
type before its address, as lsof writes `*` for both wildcards: IPv4 -> `0.0.0.0`, IPv6 -> `::`, unknown -> `*`).
Exit 1 with no output = nothing listens; any other failure or unreadable line = None, and check `bind` WARNs
instead of saying nothing listens. IPv6 addresses are shown in brackets (`[::]`, `[::1]`). `check_service`
describes the launchd configuration (`local_service.status()`, INFO: a terminal run cannot tell whether another
process is the agent); `check_security` is INFO (ufw, fail2ban, unattended-upgrades do not apply); repair advice
names the local app instead of systemctl. With `HARNESS_PILOT_LOCAL_MODE=1`, `check_managed_deps` is
`check_local_tools()` (check `deps_files`): claude, uv and node, their link targets and every parent of both. An
owner other than root or the current user, or a path writable by everyone (sticky folders aside) -> FAIL;
writable by the group `admin` (`MAC_ADMIN_GID` 80: Homebrew's `/opt/homebrew/bin` and `Cellar`, and Intel's
`/usr/local/bin`, are `drwxrwxr-x <user>:admin`) -> fine; writable by another group -> WARN; else INFO (package
contents are not verified). On Linux, manifest pins, root ownership and the firewall/service checks are unchanged.
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
`renames.py` (`migrate(ws)` called by `do_init` after the default jobs, report `renamed: {files, jobs}`): `SKILL_RENAMES`
(old -> new skill name, keep every pair), `rename_skills(text)`, `migrate(ws)`. It rewrites only the exact old
skill names, and only in what the product generated: a line of a workspace file copied from a template
(`templates/workspace/**`, `templates/packs/<id>/project/**` for `projects/<project>` and `<project>-N`)
changes when, renamed, it equals a line of the current rendered template (comparison ignores the CLI name
`maxxing`/`pilot` and the product name `Harness Maxxing`/`harness-pilot`); a job prompt changes when, renamed,
it equals a shipped prompt (`COMPACTION_JOB`, `MORNING_TASKS_PROMPT`, the packs' `crons[].prompt`). Lines and
prompts written or edited by the user are left (upgrade notes ask Claude to propose them to the user).
Idempotent, runs on every init (cheap: only template-mapped files that still contain an old name are read
twice). `tests/test_renames.py::test_no_live_text_names_an_old_skill` fails when a merge brings an old name back.

`renames.refresh_cli_guidance(ws)` (`do_init` after `ensure_cli_alias()`, report `cli_guidance: [files]`; also
`scripts/dev-local.sh` after `migrate_workspace(ws)`) gives the current CLI name to the product lines of the workspace's
template `CLAUDE.md` files, once per workspace: install.json `cli_guidance` lists the resolved workspaces done, so a
line the user changes back to `maxxing` afterwards stays. It does nothing, and records nothing, while
`cmd_core.sessions_run_our_pilot()` is false: the first `pilot` on the sessions' PATH (`spawn.base_env()`, the rule of
the doctor's `cli` check) is another program (ensure_cli_alias kept it, the agents use `maxxing`) or there is none;
the next init or local start-up tries again. The pass, `renames.migrate_cli_workspace(ws)`: a line naming `maxxing`
as the command becomes the current rendered template line equal to it once CLI and product names are ignored
(`_neutral`), or, for the exact earlier lines that differ by more than the name (`_CLI_LINES`: the root and help-topic
lines before 2.0.0a109 and the first help-topic alias note), their new version while it is a line of the template.
A line is replaced by the template's own line, so paths (`/root/maxxing`), `python -m maxxing` and `claude-maxxing`
stay as the template writes them; edited and custom lines are left. The templates name
`pilot` with the alias note "`maxxing`, its earlier name, still works" (root, system project, help topic).
Both migrations of workspace files (`migrate_workspace`, `migrate_cli_workspace`) skip a linked file or parent, a
file over `MAX_FILE_BYTES` (1 MiB, logged) and a read-only one (no write bit, or `os.access(W_OK)` false), keep each
line's own end (`\r\n`, but also the form feed, U+2028... that `str.splitlines` cuts on), and rewrite atomically
keeping the permissions. Conversation history is never rewritten.

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
- `MAXXING_CODEX_MCP=0` Codex turns get no MCP server (`codex.mcp_config`; tests: they never read the real
  `.claude.json`, `test_codex_provider.py` opts back in with a temporary `CLAUDE_CONFIG_DIR`)
- `MAXXING_CODEX_SKILLS_DIR` where `init` installs the product skills for Codex (`cmd_core.codex_skills_target()`,
  also read by the doctor, uninstall and `blocks.sync_agent_files`) instead of `~/.agents/skills`.
  `scripts/dev-local.sh` sets `<local dir>/.agents/skills`: Codex reads `.agents/skills` in the session's folder and
  its parents up to the Git repository root (the default local dir is inside the checkout), so the personal
  `~/.agents/skills` of the computer is never written. Tests point it to a temporary folder (`conftest.py`).
- `scripts/dev-local.sh` (local setup): `HARNESS_PILOT_LOCAL_DIR` (default `<repo>/.harness-pilot-local`: state,
  workspace, skills, local crontab file, `logs/`) and `HARNESS_PILOT_PORT` (default 8787: `serve --port`, written to
  the config so `link`, `cli doctor` and `cli status` name it; the start refuses a port that already has a
  listener). `dev-local.sh service install|status|restart|uninstall` runs `scripts/macos-service.sh` (macOS only): a
  launchd agent `HARNESS_PILOT_SERVICE_LABEL` (default `local.harness-pilot`) in
  `~/Library/LaunchAgents/<label>.plist` running `/bin/bash <repo>/scripts/dev-local.sh` in `gui/<uid>` with the PATH
  of the installing terminal, the local dir and the port as EnvironmentVariables, RunAtLoad, KeepAlive
  `{SuccessfulExit: false}`, ThrottleInterval 10, stdout/stderr to `<local dir>/logs/server.log` / `server.err.log`.
  `install` refuses a port in use or an existing plist, and removes the agent again when its error log says
  "Operation not permitted" (TCC: a clone in Desktop, Documents, Downloads, iCloud Drive or on an external disk).
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

