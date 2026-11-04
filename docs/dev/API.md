# API contract (v2.0)

Single source of truth between `server/` and `web/`. Change it here first, then on both sides.

## Conventions
- Base path `/api`. JSON in and out (`Content-Type: application/json`) unless stated.
- Auth: signed cookie `mx_session` (HttpOnly, SameSite=Strict, `Secure` when the request came over HTTPS
  i.e. `X-Forwarded-Proto: https`). Unauthenticated → `401 {"error":"auth_required"}`.
- CSRF: every non-GET request must carry header `X-Maxxing: 1`, else `403 {"error":"csrf"}`.
- Multipart requests (uploads, import, voice): the cookie and the CSRF header are checked **before** the body is
  read (`401` / `403`). Then `413 too_large` if `Content-Length` (or the streamed body) exceeds config
  `upload_max_mb` (default 2048; 0 = no cap; + 1 MB of multipart framing), and `507 disk_full` if the body does not fit
  in the temp dir (where the server spools uploads, often a small tmpfs) with min(`upload_min_free_mb`, 128 MB)
  to spare. The full `upload_min_free_mb` reserve (default 1024) is checked on the destination disk per file.
  Both keys are read from config.json on every request (no restart).
- Other request bodies (JSON, forms...) are capped before they are read (`maxxing/bodylimit.py`), on the declared
  `Content-Length` and, for a chunked body, while it streams: without a valid cookie a mutating request to a route
  that needs one gets `401 auth_required` before a byte is read; the public `/api/auth/*` routes check the CSRF header
  first (`403 csrf`) and take at most 64 kB, `/api/hooks/{token}` 1 MB. Signed in: 1 MB by default; 16 MB for
  `PUT /api/files/write` (the editor opens text up to 2 MB, JSON escaping can grow it), 8 MB for the session routes
  that carry a prompt (`POST /api/sessions`, `/messages`, `/steer`, `/ask`), 5 MB for `/api/ext/*`. Over it:
  `413 {"error":"too_large"}` (`Connection: close`).
- Errors: `{"error": "<machine_code>", "message": "<human text>"}` with a 4xx/5xx status.
- Compression: JSON responses >= 1 kB are gzipped (`Content-Encoding: gzip`, `Vary: Accept-Encoding`) when the
  client accepts gzip and the request did not come through a proxy (no `X-Forwarded-For`; Caddy's `encode` does it
  in domain mode). SSE streams and file downloads are never compressed by the server.
- Timestamps: Unix seconds (float) named `at`, `created`, `updated`.
- Paths:
  - *topic path* = path relative to the workspace root, e.g. `projects/acme/topics/blog`
    (`""` = workspace root).
  - *file path* = absolute path, must be inside `files_root`.
- IDs: sessions = UUID4; tasks/crons/projects = short random ids (`t_…`, `c_…`).

## Auth & setup
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/auth/state` | – | `{setup_required, authenticated, version, onboarding_completed, language, look:{theme:"dark"\|"light"\|"system", accent, tint:"neutral"\|"tinted", palette:Theme\|null, rev:int}\|null}` (public; `look` = the last one chosen in a signed-in browser, shown by the sign-in page and by browsers that never chose one; `palette` = the colour palette, a Theme object (DESIGN.md "Themes"), `rev` grows with each palette change: every signed-in browser whose palette is older adopts it, so the palette follows the user on every device; `accent` = its nearest named accent and `tint` for older clients) |
| POST | `/api/auth/setup` | `{token, password}` | `200 {ok}` + cookie. Only while `setup_required`; token = one-time setup token. `403 bad_token` |
| POST | `/api/auth/login` | `{password}` | `200 {ok:true}` + cookie, or with two-step sign-in on and no trusted-browser cookie `200 {ok:false, two_factor:{challenge, expires_in}}` (no cookie; `429 throttled` past 5 requests / 15 min per client or 10 pending; `503 two_factor_unavailable` when Telegram refused the message) · `401 bad_password` (after a delay) · `429 throttled` (checked before the password: 8 failures / 15 min per client, or the global cap - 30 failures from all clients - then one check per 5 s) |
| POST | `/api/auth/two-factor` | `{challenge, code?, trust?:bool(true)}` | poll: `{ok:false, status:"pending", expires_in}` · `{ok:true, status:"approved"}` + session cookie (+ `mx_device` cookie, path `/api/auth`, 30 days, when `trust`) - once only · `400 bad_code` `{tries_left}` (also a code that is not 6 ASCII digits) · `429 codes_paused` (20 wrong codes server-wide in the last hour: only Allow works) · `403 denied` · `410 expired` (also after 5 wrong codes, after TTL + 60 s even once approved, and after a password change / 2FA off / forget-browsers). A challenge of `PUT /two-factor` needs the session cookie and turns two-step sign-in on instead |
| PUT | `/api/auth/two-factor` | `{enabled}` | auth. `false`: off at once (trusted browsers forgotten) → `{ok, enabled:false}`. `true`: `409 not_linked` without a Telegram chat; already on → `{ok, enabled:true}`; else `{ok:false, two_factor:{challenge, expires_in}}`, on only once approved (poll `POST /two-factor`), this browser becomes trusted |
| POST | `/api/auth/two-factor/forget-browsers` | – | auth. New `device_key`: every trusted browser asks again, this one is re-trusted → `{ok}` |
| POST | `/api/auth/logout` | – | `{ok}` + cookie cleared. The cookie is also revoked server-side (`secrets.revoked_sessions`, kept until it would have expired): a copy of it is refused afterwards; other browsers stay signed in |
| POST | `/api/auth/password` | `{current, new}` | `{ok}` (min length 12, `security.MIN_PASSWORD`; `400 weak_password`, `400 bad_password` for a character UTF-8 cannot store, same on setup) + new cookie · wrong `current`: `401` after the sign-in delay, `429 throttled` past `FAIL_MAX` (own counter `pw:<client>`); rotates the cookie key: every other browser is signed out |

## Onboarding
| GET | `/api/onboarding` | – | `{completed, steps:{password:bool, claude:bool, workspace:bool, telegram:bool, backup:bool, profile:bool}}` (`profile` = the Profile step was answered, `register.asked`) |
| POST | `/api/onboarding/complete` | – | `{ok, jobs_enabled:[cron_id]}` (Claude signed in: the default jobs created off until then - Memory compaction - are turned on, once) |

## Claude
| GET | `/api/claude/status` | – | `{installed, version, auth:{ok, method:"oauth_token"\|"credentials"\|"api_key"\|null, detail, checked_at:float\|null, error:string\|null}, default_model, permission_mode, auto_compact_tokens, idle_compact_tokens, idle_compact_after_s, smart_resume_tokens, protect_secrets:bool, short_titles:bool, short_titles_model:bool, auto_update:{enabled:bool, checked_at:float\|null, latest:string\|null, last:{from, to, at:float, ok:bool, error:string\|null}\|null}, models:[{id,label,context_window:int\|null}]}` (`context_window`: as last reported by Claude Code on this server, null if never seen) |
| POST | `/api/claude/auth` | `{kind:"oauth_token"\|"api_key", value}` | stores the secret then runs a test call → `{ok, error?}`; 400 `invalid` if `value` is shorter than 10 characters or not printable ASCII without spaces |
| DELETE | `/api/claude/auth` | – | removes stored token/key |
| POST | `/api/claude/test` | – | `{ok, model, ms, error?}` (real one-line call) |
| PUT | `/api/claude/settings` | `{default_model?, permission_mode?, auto_compact_tokens?, idle_compact_tokens?, idle_compact_after_s?, smart_resume_tokens?, protect_secrets?, short_titles?, short_titles_model?, claude_auto_update?}` | `{ok}` · protect_secrets: deny rules on secrets.json and ~/.ssh for every turn · short_titles (default true): a session created with a message and no title gets a short title in the background, made locally, or by the smallest model with short_titles_model (default false) (INTERNALS.md `maxxing.sessions.titles`) · claude_auto_update (default false): the server runs `claude update` while idle, only for a release out for 2 days (INTERNALS.md#maxxingclaude_update) · permission_mode ∈ `bypass` (default) \| `acceptEdits` \| `default` · auto_compact_tokens: 0 = off, else a turn ending above it (at least 100 000) queues a summary turn + fresh thread (default 400 000) · idle_compact_tokens (0..2 000 000, default 200 000; 0 = off, else at least 20 000) / idle_compact_after_s (300..604 800, default 3600): a user message to a session idle for longer, with at least that context, is preceded by a summary turn and runs in the fresh thread · smart_resume_tokens (0..2 000 000, default 60 000; 0 = off, else at least 20 000): a user message after a pause of 5 min+ to a session with at least that context (cache expired, or 100 000+) is sorted by a small model call: NEW -> summary turn first, CONTINUE -> no summary, failure -> the idle rule |

`auth` reflects REAL calls, not the presence of a credentials file: the last session turn or test call with the
current method (success → `ok`, `checked_at`; a sign-in error such as "OAuth session expired…" or "Invalid API
key" → `ok:false`, `error`). A new `claude /login` (credentials file rewritten) or a new token clears an old
failure. With no recent result the server verifies in the background (`claude -p`, cheapest model, 60 s timeout)
at startup and at most every 6 h; a background timeout/network error does not mark the sign-in as failed.
`checked_at:null` = configured but not verified yet.

`models` = known ids (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-4-5-20251001, claude-fable-5-1, …) + ids observed in logs.

## Workspace
| GET | `/api/workspace/tree` | – | `{root, projects:[Project]}` |
| POST | `/api/workspace/projects` | `{name, description?}` | `Project` (creates folder, CLAUDE.md, memory.md) |
| PATCH | `/api/workspace/projects/{project}` | `{name?, description?, emoji?}` | `Project` (rename moves the folder and remaps sessions; `emoji` = one emoji, `""` removes it, else `400 bad_emoji`; stored in `projects/<p>/.maxxing.json`) |
| PUT | `/api/workspace/order` | `{names: [project]}` | `{projects}` (tree order, stored in `projects/.order.json`; unlisted projects follow A-Z) |
| PUT | `/api/workspace/projects/{project}/order` | `{names: [topic]}` | `{topics}` (stored in `projects/<p>/.maxxing.json`) · `404` |
| DELETE | `/api/workspace/projects/{project}` | – | moves to trash · `409 has_running_sessions` |
| POST | `/api/workspace/projects/{project}/topics` | `{name, description?}` | `Topic` |
| PATCH / DELETE | `/api/workspace/projects/{project}/topics/{topic}` | `{name?, description?, permission_mode?}` | `Topic` · `permission_mode` ∈ `bypass` \| `acceptEdits` \| `default` \| `""` (the global setting), else `400 bad_permission_mode`; stored in `topics/<t>/.maxxing.json` |

```
Project = {name, path, description, topics:[Topic], session_count}
Topic   = {name, project, path, description, permission_mode:""|"bypass"|"acceptEdits"|"default", session_count, archived_count:int, running:int, unread:int, telegram_thread:int|null}
```
Names: `^[a-z0-9][a-z0-9-]{0,47}$` (slug); the UI slugifies the label. Description goes into the CLAUDE.md header.

## Sessions
```
Session = {
  id, title, path,                    // topic path
  state: "idle"|"running"|"error",
  queue: int,                         // messages waiting
  queue_items: [{text, attachments: int, source: "web"|"telegram"|"cron"|"system", kind, voice?:true}],  // the waiting messages, in order (text cut at 280 chars): the queue stack shows them even when this tab did not queue them
  created, updated, turns, cost_usd,
  model: string,                      // chosen ("" = default)
  real_model: string|null,            // model that actually answered last turn (from the log)
  context_tokens: int|null,           // last turn input+cache tokens
  context_window: int|null,           // context window of the model of the last turn (Claude Code `modelUsage[..].contextWindow`, e.g. 1000000); null = unknown
  archived: bool, favorite: bool, notify: bool,
  source: "web"|"telegram"|"cron",
  cron: bool,                         // started by a scheduled job (not mirrored on Telegram)
  unread: bool,                       // finished after the last /seen
  last_text: string,                  // first 200 chars of the last assistant text
  error: string|null,
  plan_mode: bool,                    // turns run read-only (`--permission-mode plan`) and end with a plan
  permission_mode: string,            // set by its cron ("" = the topic's, else the global mode)
  plan_ready: bool,                   // a plan-mode turn finished OK: its plan waits for POST /plan/approve
  provider: "claude"|"codex"|"discussion"|"debate",
  // Mixed teams (POST /api/teams):
  team_phase: "launching"|"working"|"synthesizing"|"completed"|"stopped"|"error"|null,   // on the coordinator
  team_parent: string|null,           // on a worker: its coordinator session
  team_turn: bool,                    // a worker whose last turn ran its team assignment: its stop raises no
                                      // notification (feed, push, browser); the team notifies once, at the end
                                      // of its coordinator's synthesis. A message sent to it later is its own turn
  // Claude Code + Codex conversations (provider discussion / debate; null / 0 / false for the others), see
  // "Discussion periods" below the table:
  debate_paused: bool,                // the automatic exchange is paused (Resume continues it)
  discussion_pause_reason: "limit"|"user"|null,   // why: a limit reached, or the pause button
  discussion_paused_at: number|null,  // when it paused (limit or pause button); null while not paused
  discussion_turns: int,              // replies of the current period
  discussion_elapsed: int,            // seconds the current period has run, paused time excluded (live while it runs)
  discussion_turn_limit: int|null,    // replies per period (1-200), null = no limit
  discussion_duration_seconds: int|null   // duration of a period (60-86400 s), null = no limit
}
```
| GET | `/api/sessions?path=&archived=0\|1` | – | `[Session]` sorted by `updated` desc (no path = all) |
| POST | `/api/sessions` | `{path, message?, title?, model?, attachments?:[filepath], plan_mode?:bool, voice?:filepath, swarm_agents?:2..6}` | `Session` (starts the first turn if message or voice). `swarm_agents` is available only with `provider: "claude"`; it requests that Claude delegate to that many native subagents when appropriate. This is an instruction, not a hard concurrency limit or a guarantee that subagents will be created. The resulting session includes `swarm_agents`; normal permissions and stop behavior apply. |
| POST | `/api/teams` | `{path, message, title?}` | Start a mixed team: independent Claude and Codex sessions analyze the mission concurrently, then a Claude coordinator synthesizes their results in the returned parent session. The agents use the selected topic and existing account permissions. The independent analyses are instructed not to edit files; this instruction is not an isolation boundary. |
| GET | `/api/teams/{sid}` | – | Team phase and its two worker sessions, including individual status and links. The team is retained with the coordinator session. |
| POST | `/api/teams/{sid}/agents/{agent_id}/stop` | – | Stop one independently launched team worker; other workers continue. Returns 404 for sessions outside this team. |
| POST | `/api/teams/{sid}/stop` | – | Stop the team, including any running workers and coordinator. |
| GET | `/api/sessions/{id}` | – | `Session` |
| PATCH | `/api/sessions/{id}` | `{title?, model?, archived?, notify?, plan_mode?, favorite?, path?}` | `Session` (`plan_mode:false` also clears `plan_ready`; `favorite` is carried over by a hand-off; `path` moves the session to another topic and its Claude transcript with it - `400 bad_path`, `409 busy` while a turn runs or messages wait; `model`: an id of letters, digits and `._:@/[]-`, 100 characters at most, not starting with `-`, else `400 bad_model`, also on create) |
| POST | `/api/sessions/{id}/plan/approve` | `{text?}` (shown in the thread as the user's message) | `{queued:bool, session:Session}` — plan mode off, then a turn that tells Claude to implement its latest plan (queue item flag `plan_approved`, kept by steer like `hud`) |
| DELETE | `/api/sessions/{id}` | – | `{ok}` (stops a running turn, moves the session to the trash) |
| POST | `/api/sessions/{id}/messages` | `{text, attachments?:[filepath], hud?:bool, voice?:filepath}` (`hud`: sent from the HUD - the prompt gets a short preface: answer short, annotate the screen capture if useful; `voice`: a voice message sent directly - uploaded first with `/api/uploads`, queued at once, transcribed by the server, then its transcript is the prompt) | `{queued:bool, session:Session}` · `409 voice_off` (transcription not ready) |
| DELETE | `/api/sessions/{id}/queue` | – | clears queued messages |
| POST | `/api/sessions/{id}/ask` | `{question}` | `{answer, cost_usd, duration_ms}` — side question: Claude answers from a throwaway copy of the session's thread (read-only, nothing saved: the running turn, queue and log are untouched). 409 `no_thread` (never answered yet) / `busy` (one already running for this session), 429 (2 running), 504 (240 s) |
| POST | `/api/sessions/{id}/queue/take` | – | `{messages:[{text, attachments}], session}` — removes the queued user messages and returns them (the composer's **Edit**: they come back in the composer and are sent again as a normal message) |
| POST | `/api/sessions/{id}/hide` | `{at, hidden=true}` | `{ok}` — hides (or shows again) the user message whose `at` is given: appends `{type:"mx_hide", ref, hidden}` to the raw log (nothing is erased; Claude's own thread is untouched), streamed as a `hide` event; 404 when no user message has that `at`, nothing written when it is already in that state. The UI offers it for a message whose turn ended without any answer (stopped) and drops that turn's rows |
| POST | `/api/sessions/{id}/steer` | – | `{steered:bool, interrupted:bool, session}` — while a turn runs: the queued user messages become ONE message (`steer: true`) at the head of the queue and the runner gets SIGUSR1: it ends the current turn (only that one: meta `steer_turn` = `turn_id`) and runs that message next in the same Claude thread, prefaced so Claude continues the task with it. A compact / handoff turn is not interrupted (`interrupted:false`, the message runs right after it). `steered:false` when idle or nothing is queued |
| POST | `/api/sessions/{id}/stop` | – | `{ok}` (clears the queue, aborts the running turn; returns once settled, ≤ ~10 s). During an idle-compaction summary only the summary is aborted: the message waiting behind it (queue item `held`) stays and runs |
| POST | `/api/sessions/{id}/discussion/pause` | – | `Session` — a discussion / debate pauses after the current reply (reason `user`) · `400 unsupported` (not a discussion), `409 not_running` |
| POST | `/api/sessions/{id}/discussion/resume` | – | `Session` — continues from the saved next prompt (see *Discussion periods*) · `400 unsupported`, `409 not_paused` |
| PATCH | `/api/sessions/{id}/discussion` | `{turn_limit?: int\|null, duration_minutes?: int\|null}` | `Session` — changes the limits of a discussion / debate (running, paused or stopped): `turn_limit` 1-200 replies, `duration_minutes` 1-1440 (stored as `discussion_duration_seconds`); a field left out keeps its value, `null` removes that limit. They apply to the current period: while it runs, a limit already reached pauses it after the current reply; paused on its limit, Resume continues the period once no limit is reached any more · `400 unsupported` (not a discussion), `422 invalid` (out of range, not an integer) |
| POST | `/api/sessions/{id}/compact` | – | `{ok}` summary → fresh Claude context, same session · `409 busy` while running · `400 empty_session` |
| POST | `/api/sessions/{id}/handoff` | – | `Session` (new session seeded with a summary; old one archived). Messages sent to the new session before the summary arrives are queued (`queued:true`) and run after the seed (10 min at most, or at once when the summary fails) |
| POST | `/api/sessions/{id}/seen` | – | `{ok}` |
| GET | `/api/sessions/{id}/events?tail=N` | – | last events, read backwards from the end (whole log lines, at least N events when available, max 5000): `{events, start, next, more_before:bool, state}` — `start` = offset of the first line returned, `next` = end offset (start the stream there). What the UI uses to open a thread |
| GET | `/api/sessions/{id}/events?before=<offset>&limit=N` | – | events strictly before `offset` (backward paging, "Show earlier messages"): `{events, start, next:offset, more_before, state}` · `{events:[], reset:true, state}` when `offset` is not a line boundary of the current log |
| GET | `/api/sessions/{id}/events?from=0` | – | forward reading `{events:[Event], next:int, state, more:bool}` (≤ 4 MB of log per call; `more` = call again from `next`) · `reset:true` when `from` is beyond the end / not a line boundary |
| GET | `/api/sessions/{id}/stream?from=0` | – | **SSE**. `event: events` `data: {events, next}` · `event: state` `data: Session` · `event: reset` `data: {}` then end of stream when the log was rewritten or shrank (or `from` is stale): reload with `?tail=` · heartbeat comment every 15 s. New lines and state changes are pushed ~0.05-0.15 s after they are written (inotify on the sessions folder; without it the stream polls every 0.1 s while the session runs) |
| GET | `/api/sessions/search?q=` | – | `[{id, title, path, snippet, at}]` (served by the full-text index, see Search; max 50) |
| POST | `/api/uploads?path=<topic path>` | multipart `file` (multi) | `{files:[{path, name, size, mime}]}` saved in `<topic>/attachments/YYYY-MM/` · each file `413 too_large` over `upload_max_mb`, `507 disk_full` when it would leave less than `upload_min_free_mb` free on the destination disk (files saved before it in the same request are kept); the whole request is capped too (see Conventions) |

**Discussion periods.** A Claude Code + Codex conversation counts its replies and its running time per *period*: the
first message starts one, and the exchange pauses after the reply that reaches a limit (`debate_paused`, reason
`limit`, feed event `discussion.paused`). Resume (or a new message) after a limit pause starts a new period (counters
back to 0) when a limit is still reached, and continues the current one when the limits were changed so that none is
reached any more; after the pause button the period always continues. Stop ends the exchange; the next message
starts a new period. `discussion_paused_at` is set by both pauses and cleared by Resume, a new message and Stop (the
thread can show it as a dated separator).

`from`/`next`/`start`/`before` = byte offsets in the raw log (always line boundaries). Backward reads scan at
most 64 MB per call (then `more_before` with the `start` reached). A `task` whose `task_started` line is before the
page gets that line's `kind`/`background`/`description`/`agent_type` on its first event of the page (looked up at
most 32 MB further back). The runner clips tool outputs before
writing them (2 000 characters per tool result, images → `[image]`, Write/Edit inputs beyond 20 kB; the block
gets `mx_clipped`), keeps only `cwd, session_id, model, permissionMode, apiKeySource, claude_code_version,
output_style, fast_mode_state, mcp_servers, uuid` of `system/init` lines (the tool / skill / slash-command
lists, ~20 kB per turn, are dropped), drops the `signature` of `thinking` blocks and the `data` of
`redacted_thinking` blocks (read by the API only) and does not write `system/thinking_tokens` lines; `pilot sessions
compact-logs [--dry-run]` applies the same to existing logs (atomic
rewrite, running sessions skipped), and the server does it every night at 04:30 for the logs written since the
previous night — open streams then receive `reset`. **Event** (normalised):
```
{type:"user", text, attachments:[path], at, source, voice?:[path]}   // voice: a voice message sent directly (its audio)
{type:"voice_text", text, error:str|null, stopped?:true, at}   // transcript of the voice message just above (error: not transcribed, nothing sent to Claude)
{type:"assistant", text, at}                       // markdown
{type:"thinking", text, at}
{type:"tool_use", id, name, input, summary, at}     // summary = one-line human string ("Read src/app.py", "Bash: ls -la")
{type:"tool_result", tool_use_id, text, is_error, at}   // text truncated to 20 kB
{type:"init", model, cwd, at}
{type:"result", ok, cost_usd, duration_ms, model, usage:{input,output,cache_read,cache_write}, at}   // cost_usd = this turn only (the raw total_cost_usd is the thread's running total)
{type:"note", text, level:"info"|"warn"|"error", at}   // compact, handoff, resume fallback, stop…
{type:"hide", ref, hidden, at}                      // ref = `at` of a user event: hidden (true) or shown again{type:"task", id, tool_use_id?, at, state?, kind?, background?, description?, agent_type?, activity?, last_tool?, tokens?, tools?, duration_ms?, summary?}
                                                    // background work of Claude Code (task_started / _progress / _updated / _notification):
                                                    // a partial update, merged on `id`; `tool_use_id` = the Agent / Bash call that started it.
                                                    // state: running|completed|failed|stopped · kind: agent|shell|other ·
                                                    // summary = the agent's final report (≤ 20 kB) · commands run by a sub-agent are dropped.
                                                    // Not counted in `tail` / `limit` (they are not thread rows).
```

## Global bus
`GET /api/stream` — **SSE**, `event: invalidate`, `data: {"topics": ["sessions"|"workspace"|"tasks"|"crons"|"telegram"|"backup"|"health"|"extensions"|"trash"|"feed"|"look"|"themes"|"space-labels"]}` (`look`: the palette changed, `PUT /api/settings/look`; the UI refetches the auth state and adopts it; `themes`: the saved themes changed). The UI refetches the matching queries. Heartbeat every 15 s. Both SSE streams (this one and `/api/sessions/{id}/stream`) re-check their cookie before each frame (one stat of secrets.json while unchanged, a full check at least every 15 s): signed out, password changed, `sessions_not_before` or expired -> the stream ends without sending anything more (the browser's reconnect then gets `401`). Concurrent SSE streams are capped (both kinds together): 24 per sign-in, 96 in total (`streamcap`); beyond that `429 {"error":"too_many_streams"}` with `Retry-After: 5`. A session that appears, goes away or changes state/unread (turn started or ended) sends `sessions` and `workspace` together; the UI relies on that pair to refresh the workspace tree, the Claude status and the token stats.

## Space labels

`GET /api/space-labels` returns explicit labels keyed by absolute path. `PUT /api/space-labels` accepts `{path, label}` with `label` one of `personal`, `agents`, `shared`, or `unclassified`. Paths must exist inside the configured workspace or files root. Labels express the user's organization, not verified authorship, and do not grant or restrict access. Unlabelled or replaced items are `unclassified`; paths moved through the app retain their labels. Labels live in local state and are not automatically inherited by children.

## Files
Every `path` is absolute and inside `files_root` (else `400 bad_path` / `403 forbidden`); a path with a NUL byte or a symlink loop is `400 bad_path`.
| GET | `/api/files/list?path=` | – | `{path, parent, root, entries:[{name, path, type:"file"\|"dir", size, mtime, mime}]}` dirs first |
| GET | `/api/files/read?path=` | – | `{path, content, mtime, size, mime, editable}` (text ≤ 2 MB; else `413`; binary / non-UTF-8 → `415 binary`) |
| GET | `/api/files/raw?path=&download=0&v=` | – | bytes, Range supported (video). Every type but images (not SVG), audio, video and PDF gets `Content-Security-Policy: sandbox; default-src 'none'; …` (+ `nosniff` always). `v` (the file's mtime, set by the UI when it knows it) = cached by the browser for good, else `no-cache` + ETag. `download=1`: `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<name>` (`downloads.content_disposition`: a name that is not UTF-8 on disk is read as Latin-1; slashes, control and bidi characters replaced or dropped; cut at 200 characters keeping the extension) |
| GET | `/api/files/zip?path=&check=0` | – | the folder as a zip (`application/zip`, `<folder>.zip`, `no-store`), made while it is sent: ZIP64, deflate level 6, stored for already-compressed types (images, video, audio, archives, office, PDF, fonts). Everything the listing shows; symlinked folders are not followed, a symlinked file only when its target is a regular file inside the files root; sockets / FIFOs / devices left out; names not UTF-8 read as Latin-1 · not a folder `404` · over 2 GB uncompressed or 100,000 entries `413 too_large` (checked before the first byte) · `check=1`: `{count, size}` (files, uncompressed bytes) or that `413`, nothing zipped: the UI asks first, a refused link download shows no reason |
| POST | `/api/files/zip` | `{paths: [abs path]}` (1-1000) | several files and folders in one zip, checked: each path confined like every other (symlinks followed, `403` outside, `404` missing, `400` relative), duplicates and entries inside another selected folder left out, a name already taken gets ` (2)`; the 2 GB / 100,000 caps apply to the whole set (`413 too_large`) → `{count, size, name, token, expires_in}` (`name`: `<their folder>.zip`, or `files.zip` when they come from several folders) |
| GET | `/api/files/zip?token=` | – | the zip of that POST (same session cookie only, valid `expires_in` = 120 s), planned again from the paths as they are now (`413` if it grew past a cap) · unknown / expired / another session `404`. A link download cannot POST: the browser follows this URL |
| GET | `/api/files/thumb?path=&w=320&v=&anim=0` | – | webp thumbnail for images, videos and PDFs (ffmpeg, video: frame at 1 s; PDF: first page through `pdftoppm`), cached server side; without ffmpeg images fall back to the original · other types `415`. `w` ≤ 4096. `anim=1` (chat): a `.gif` of at most 8 MB (`GIF_ANIM_MAX`) is served as it is (`image/gif`, it moves), a bigger one gets the still. Cache: `no-cache` (revalidated), or for good with `v`. Same CSP rule as `/raw` (an SVG fallback is sandboxed) |
| POST | `/api/files/stat` | `{paths: [str]}` (≤ 500) | `{mtimes: {path: float \| null}}` - current mtime of each file (null = missing, outside the files root, not absolute). The UI puts it in preview URLs (`v`) so a file rewritten under the same name shows its new version |
| GET | `/api/files/video?path=` | – | `{width, height, codec, bitrate, duration, fps, has_audio, rotation, qualities: [{q, state: none\|queued\|running\|ready\|error, progress 0-1, error?}], auto}`: `width`/`height` as coded (`rotation` 90 / 270 = shown sideways), `has_audio` false = no audio stream (the UI plays a clip of ≤ 15 s without sound like a GIF); the lighter copies offered (1080 / 720 / 480 below the original's height) and `auto`, the copy the UI falls back on when the browser cannot decode the original (it checks `canPlayType` with `codec`) or it struggles: 1080 above 1080p, 720 for a heavy original ≤ 1080p (not H.264 / VP8 / VP9, or > 6 Mbit/s), `null` = none (light original, or nothing lighter) · not a video `415` · no ffprobe / no video stream `422 video_unavailable` |
| POST | `/api/files/video/prepare` | `{path, q}` | queues the copy at height `q` (H.264 crf 20 `faster` + AAC 128k, maxrate 8M / 4M / 1.5M with a buffer twice that, `+faststart`, `nice 10`, 2 threads, one encode at a time) in `<state>/videos/<sha1(path, mtime, size)>-<q>-r2.mp4` (`r2`: copies made with older settings are never served); no-op when ready or queued; returns the same as GET · `q` not offered or no ffmpeg `422`. Poll GET for progress |
| GET | `/api/files/video/stream?path=&q=&v=` | – | the ready copy (`video/mp4`, Range requests) · not made yet `404 not_ready`. Sets the copy's access time only (its mtime, so the ETag / Last-Modified, never change: the browser's `If-Range` requests keep getting 206). Past 4 GB (`VIDEO_CACHE_MAX`) the least recently played copies are removed after each encode, never one played in the last 30 min (`COPY_KEEP_S`) |
| GET | `/api/files/site-url?path=` | – | `{url, expires_in}`: `/api/files/site/<token>/<name>` renders an HTML file (`.html`/`.htm` only, 415 otherwise) with its relative assets for 2 h. Folder token: only static web assets of the page's folder tree (`html htm css js mjs wasm`, fonts `woff woff2 ttf otf eot`, pictures, audio, video; never `.md .json .txt .csv .pdf .xml`, code or settings); from a topic's `attachments/`, pictures and media only. When the page's folder is the files root, the home directory, `/`, under a dot folder, the workspace root, `projects/`, a project, its `topics/` or a topic's `attachments/`, the token covers that file only (never under a dot folder). The token carries its issue time and session id: refused after that session signs out, when it is older than `sessions_not_before`, or after a password change |
| GET | `/api/files/site/<token>/<rel path>` | – (**no cookie**: the token, scoped to the page's folder, is the permission) | the file, with `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads` (no `allow-same-origin`: opaque origin, no session; no `allow-popups-to-escape-sandbox`: popups and `target=_blank` links inherit the sandbox; the UI iframe uses the same flags) + `frame-ancestors 'self'`; outside the folder, any dotfile / dot folder in the path, another file of a single-file token, or a file type outside the list above `403`; expired, revoked / forged token `403 expired` |
| PUT | `/api/files/write` | `{path, content, expected_mtime?}` | `{ok, mtime}` · `409 conflict` when mtime differs · `400 bad_content` (a lone surrogate) |
| POST | `/api/files/mkdir` | `{path}` | `{ok}` · `409 exists` when something (a file, a dangling link) is already there or a file is in the way |
| POST | `/api/files/move` | `{from, to}` | `{ok}` · moving the workspace or a folder holding it `403 forbidden`; a folder with a running session in it `409 has_running_sessions` (same rule as the workspace API) |
| POST | `/api/files/delete` | `{path}` | `{ok}` (to trash) · same `403` / `409 has_running_sessions` rules as `move` |
| POST | `/api/files/upload?dir=` | multipart | `{files:[…]}` · same limits as `/api/uploads` (`413 too_large`, `507 disk_full`) |
| GET | `/api/files/search?q=` | – | `[{path, name, type}]` (workspace, max 50) |

## Trash
Everything deleted (files, folders, topics and projects with their sessions, single sessions) lands in
`state_dir("trash")`; items older than 30 days are hidden from the list and purged when the trash is listed (at most once an hour).
| GET | `/api/trash` | – | `{items:[{id, kind:"file"\|"folder"\|"topic"\|"project"\|"session"\|"previous_versions", name, original, at, size, sessions:int, restorable}], keep_days}` newest first (`original` workspace-relative; for a session: its topic path) |
| POST | `/api/trash/{id}/restore` | – | back where it was - a free name next to it if the place is taken (`<name> (restored).ext`, topics/projects `<name>-restored`, `<name>-restored-2`…, the name cut so the result stays a valid name of at most 48 characters); sessions come back with their topic (a session whose topic is gone comes back at the workspace root) → `{ok, kind, restored_to, sessions}` · `404 not_found` · `409 not_restorable` (backup "previous versions") |
| DELETE | `/api/trash/{id}` | – | deletes one item forever → `{ok}` |
| DELETE | `/api/trash` | – | empties the trash → `{ok, deleted}` |

## Tasks (`<workspace>/tasks.json`)
```
Task    = {id, title, notes, status:"todo"|"doing"|"done", priority:0|1|2|3, due:"YYYY-MM-DD"|null,
           project_id|null, topic_path|null, labels:[str] (max 50, 40 chars each), created, updated, done_at|null, order:float}
TaskProject = {id, name, color, workspace?: str, hidden?: true}
```
Workspace link: every workspace project has one task project with `workspace = <project folder name>`. `GET` creates the
missing ones (an unlinked project with the same name, case-insensitive, is linked instead; `system` starts `hidden`),
fills `project_id` of tasks that have a `topic_path` but no project, and frees (removes `workspace`) a project whose folder
is gone; a workspace rename moves `workspace`, `name` (when it was the old name) and the tasks' `topic_path`; a deleted
project leaves a free task project (its tasks keep it), a deleted topic clears `topic_path`. POST with a `topic_path` and no
`project_id` takes the topic's project. `DELETE` of a linked project whose folder exists: `409 linked_project` (hide it).
A hand-written file is normalised on read (missing fields filled in, `id` / `title` / `notes` / `project_id` / `topic_path` of
another type turned into text, non-numeric `created` / `updated` / `done_at` replaced). Every write (POST / PATCH / DELETE
below) is a read-modify-write under one lock; when the file changed on disk between the read and the write (Claude edited it),
the change is re-applied on the fresh file (3 tries), then `409 conflict`. Not valid JSON: every route `409 corrupt_file`.
| GET | `/api/tasks` | – | `{projects:[TaskProject], tasks:[Task]}` |
| POST | `/api/tasks` | partial Task (title required) | `Task` · `422` when `order` is not a finite number |
| PATCH | `/api/tasks/{id}` | partial Task | `Task` · `422` when `order` is not a finite number |
| DELETE | `/api/tasks/{id}` | – | `{ok}` |
| POST | `/api/tasks/bulk` | `{ids:[id], patch?:{status?, priority?, project_id?, due?, topic_path?, labels?}, labels_add?:[str], labels_remove?:[str], delete?:bool}` | `{ok, updated, deleted}` — one atomic write; unknown ids ignored; tasks entering a column keep their relative order (top of `done`, bottom elsewhere) · `400 invalid_ids`/`too_many_ids` (more than 1000 ids)/`invalid_labels` (more than 50 labels on a task)/validation codes of PATCH |
| POST / PATCH / DELETE | `/api/tasks/projects[/{id}]` | `{name, color, hidden?}` | `TaskProject` · DELETE `409 linked_project` |

## Crons
```
Cron = {id, name, schedule,            // 5-field cron expression
        kind:"shell"|"claude", command, // shell
        topic_path, prompt, model, reuse_session:bool,  // claude
        permission_mode:""|"bypass"|"acceptEdits"|"default",  // claude; "" = the topic's, else the global mode
        enabled, notify:"never"|"failure"|"always", timeout_s,
        last_run:{at, ok, code, duration_s}|null, next_run:float|null, human:string,
        running:bool}                  // a run is in progress (flock held); overlapping runs are skipped
Run  = {id, cron_id, name, at, ok, code, duration_s, output_tail, session_id|null}   (output_tail: a Claude job keeps the first 2048 characters of its answer, a command the last 2048 of its output)
```
| GET | `/api/crons` | – | `{jobs:[Cron], external:[{schedule, command, human}]}` (external = crontab lines outside the managed block, read-only) |
| POST | `/api/crons` | Cron fields | `Cron` (validates expression; syncs crontab) · `409 damaged_jobs` (jobs.json cannot be read: nothing is written) |
| PATCH / DELETE | `/api/crons/{id}` | | `409 damaged_jobs` as for POST |
| POST | `/api/crons/{id}/run` | – | `{ok}` (runs now in a transient unit) · `409 already_running` |
| GET | `/api/crons/runs?cron_id=&limit=50` | – | `[Run]` |
| GET | `/api/crons/{id}` | – | `Cron` |
| GET | `/api/crons/preview?schedule=` | – | `{valid, human, next:[at×5], error?}` (next runs in the configured time zone) |

## Telegram
| GET | `/api/telegram` | – | `{configured, running, bot:{id, username, name}\|null, chat:{id, title, type}\|null, topics_enabled, threads:[{path, thread_id, name, session_id?}], settings:{notify_crons, notify_system:bool(true), login_alerts, two_factor:bool, reply_mode:"progress"(default)\|"final", thread_days:int(30), mirror_web:bool(false)}, linking:bool, link:{code, deep_link, expires_at, expires_in, expired}\|null, poll_error, poll_error_code:"token_rejected"\|"conflict"\|"unreachable"\|null, sync_error, topics_notice, last_poll_ok, last_poll_age, last_error}` (special threads: path `"#crons"` / `"#alerts"`; session threads: `session_id`, path `""`). `running`: in the server, the poller itself; in another process (CLI, doctor), the `poller_pid` of the server's heartbeat is alive. `poll_error` is set and cleared only by the poller (getUpdates: 401 → `token_rejected`, the poller stops; 409 → `conflict`, another program reads the bot); `sync_error` only by the thread sync; `topics_notice` = threads are off for the bot (BotFather "Threaded Mode") - information, not an error. `last_poll_ok` = last successful getUpdates (Unix s, written at most every 30 s). `link` = the last link code, pending or expired (kept until a chat links). `last_error` (older readers) = `poll_error` or `sync_error`. Setup is done once a chat is linked (same rule as `/api/onboarding`) |
| POST | `/api/telegram/token` | `{token}` | getMe, getWebhookInfo, then a short getUpdates probe → `{ok, bot}` · `400 {error, message}` with `error`: `bad_token` (bad format or rejected) · `unreachable` · `webhook_set` (the bot sends its updates to a webhook; also `pending_updates`) · `webhook_check_failed` (getWebhookInfo failed) · `conflict` (409: another program polls this bot). Saving the stored token again pauses our own poller during the probe. A different bot resets the chat link; the same bot (a new token after a revoke) keeps it |
| POST | `/api/telegram/webhook/remove` | `{token?}` | deleteWebhook (pending updates kept) for `token` (the one being saved) or the stored token → `{ok}` · `400 bad_token\|not_configured\|unreachable`. The UI then saves the token again |
| POST | `/api/telegram/link` | – | `{code, deep_link, expires_at, expires_in}` (`https://t.me/<bot>?start=<code>`, valid 15 min) — starts polling and waits for `/start <code>` from a private chat; threads are synced right after linking. Empties the refused list. Messages dated before the link was created are ignored (a Start pressed too early); while a code is pending or expired less than 24 h ago, `/start` with a wrong, expired or no code gets "this link expired or is not valid - create a new one" (the chat is not refused) · `409 not_configured`. Also works with a chat linked: the new chat replaces it |
| GET | `/api/telegram/link` | – | `{linked, chat, pending:{code, deep_link, expires_at, expires_in, expired}\|null}` |
| POST | `/api/telegram/sync` | – | makes the threads match: "Crons" + "Alerts" + one per open session (human, not archived, active in the last `thread_days` days, ≤ 50; created / renamed / deleted; a thread found deleted - on a send or a rename - is reopened for its session; Telegram has no silent check, so threads are not probed) → `{created:int, deleted:int, topics_enabled:bool, error:string\|null, notice:string\|null}` (topics disabled for the bot → `topics_enabled:false`, `notice` set and `error` null, everything goes to the main chat). Also automatic: a few seconds after any session change and every 10 min |
| PUT | `/api/telegram/settings` | partial settings (`thread_days` 1–365) | `{ok}` |
| POST | `/api/telegram/test` | – | sends a test message and checks the receiving side → `{ok, sent, poller:{running, last_poll_ok, last_poll_age, error, error_code}, webhook:{url, pending_updates, last_error}\|null, problems:[string]}` (`ok` = sent and no problem: poller stopped or in error, no getUpdates for 5 min, webhook set) · `409 not_linked` · `502 telegram_error` (not sent; same fields) |
| DELETE | `/api/telegram` | – | unlink + forget token, threads and the Telegram sessions map |

## Resident companions

Companions are persistent, editable role definitions stored in private local state. In this first version, starting a review is explicit and uses Codex in a disposable, shallow clone of the installed Git checkout. Nothing is applied, pushed, merged or scheduled automatically.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/companions` | – | `{companions:[{id,name,role,provider}], runs:[Session]}` |
| POST | `/api/companions` | `{name,role}` | Creates a persistent Codex role definition. |
| PUT | `/api/companions/{id}` | `{name,role}` | Updates a role; existing runs retain their original instructions. |
| POST | `/api/companions/{id}/runs` | `{path,mission?}` | Clones the installed source at its committed HEAD into private state, starts a Codex session in that clone, and returns the session. The clone has no remote. |
| GET | `/api/companions/runs/{sid}/review` | – | Session, bounded patch and untracked-file summaries, plus a fingerprint for the current proposal. |
| POST | `/api/companions/runs/{sid}/pull-request` | `{fingerprint,title,body}` | Publishes the previously approved exact proposal as a draft GitHub PR; never merges. Requires a GitHub origin and authenticated GitHub CLI. |
| POST | `/api/companions/runs/{sid}/decision` | `{decision:"approved"\|"rejected",fingerprint}` | Records a decision on the exact finished proposal; a changed or running proposal is refused. This does not apply or publish the patch. |

On completion, a proposal is posted to the existing notifications feed with a link to its review. Sound follows the browser's notification and audio settings. Role instructions and logs are local and no background monitoring is enabled by this feature.

## Backup
| GET | `/api/backup` | – | `{configured, repo, private:bool\|null, schedule, include:[glob], always:[glob], last:{at, ok, commit, files, error}\|null}` (`always` = CLAUDE.md/memory.md globs, always included) |
| POST | `/api/backup/config` | `{repo:"owner/name", token, create?:bool}` | verifies access/private/push (creates the private repo if asked; token may be omitted to keep the stored one) → `{ok, private, created?, warning?, error?}`; on success creates/updates the "Memory backup" cron job; `ok:false` while a backup or restore runs |
| PUT | `/api/backup/settings` | `{schedule?, include?}` | `{ok}` |
| POST | `/api/backup/run` | – | `{ok, commit, files, changed?, error?, code?, leaks?:[{file, kinds}]}` (`code`: `secret_found`, `public_repo`, `not_configured`, `file_too_large`, `read_failed`, `git_failed`…; `409 busy`; `409 paused` while the integrations of a restored instance copy are paused, see Complete instance backup). Selected files that cannot be read or are too large, and failed MCP exports, abort the snapshot before push. |
| GET | `/api/backup/history?limit=100` | – | `[{at, ok, commit, files, changed, error, code?, duration_s}]` newest first |
| POST | `/api/backup/preview` | `{ref?}` | Read a backup revision without changing workspace files. Returns the resolved commit SHA, counts and a bounded list of workspace files to create, replace, leave unchanged, hold aside, or skip, plus flags for saved settings, jobs and MCP. Preview is advisory: local files can change before restore. Restore the returned SHA to pin the reviewed revision. |
| POST | `/api/backup/restore` | `{ref?}` | restores whitelisted files (current files saved to trash first) + cron jobs + server-independent settings → `{ok, files, restored:[path], unchanged, skipped:[path], skipped_count, crons:bool, mcp:int, held:{crons, extensions, hooks, mcp, review, outside?}, warnings:["crons"\|"mcp"\|"settings"], trash}` (`skipped` is capped at 200 paths; `skipped_count` is the full count; local MCP servers and new jobs/extension code are held, see Backup docs) · `409 not_configured\|empty\|busy` |
| DELETE | `/api/backup` | – | forget repo + token (`409 busy` while a backup or restore runs) |

## Settings & secrets
| GET / PUT | `/api/settings` | `{timezone, language:"en"\|"fr", public_url, files_root, presentation_default?, usage_widget:bool, git_page:bool, infra_page:bool, maxxing_mode:bool, memory_max_lines:int, result_line_hidden:["model"\|"duration"\|"cost"\|"tokens"\|"cache"], donation_hidden:bool}` (`donation_hidden`: hides the donation links of What's new, Feedback and Settings -> License for every browser, default false; Settings -> Support stays) (`result_line_hidden`: parts of the line under each answer that are hidden, default `[]`, unknown values = 422, stored in canonical order) (`git_page`: the Git page `/git` and its sidebar entry, default false) (`maxxing_mode`: beta, Maxxing mode of the Sessions page - its switch, meter, driver and Alt+M -, default false) (`memory_max_lines`: 0 = no limit, else 50-5000, default 200) — a new `timezone` also switches the server zone (`timedatectl`, cron restarted) |
| PUT | `/api/settings/look` | `{theme:"dark"\|"light"\|"system", palette?:Theme, accent?:"blue"\|"clay"\|"violet"\|"green"\|"amber"\|"rose", tint?:"neutral"\|"tinted"}` | `{ok, look}` (`look` as in `/api/auth/state`) · sent by the web app 600 ms after a change of theme or palette; `palette` only when the user changed it (validated by `maxxing/themes.py` `clean_theme`: unknown keys dropped, colours only, 16 KB at most; `accent` = its nearest named accent, computed by the browser). A palette that differs from the stored one increments `rev` and sends the bus topic `look`. Without `palette`, an `accent` / `tint` different from the stored ones (a client from before palettes) becomes a palette that keeps the stored base and buttons · `422` bad value, `422 invalid_theme` unsafe or unusable palette (config `look`) |
| GET | `/api/settings/themes` | – | `{themes:[SavedTheme], max:50}` newest first. The user's saved themes ("My themes", Settings -> Appearance), kept in `<state>/themes.json` (private: never in `/api/auth/state`); `SavedTheme = {id:"th_<10 hex>", theme:Theme, source:"created"\|"imported"\|"received"\|"custom", from:string, saved:float}` (`created` = by the theme generator, `imported` = a file or a pasted code, `received` = a Team contact's theme, `from` = who sent it, `custom` = the palette composed in the settings). An entry the file no longer validates is skipped |
| POST | `/api/settings/themes` | `{theme:Theme, source?:"created"\|"imported"\|"received"\|"custom" ("imported"), from?:string}` | `SavedTheme` (bus `themes`). `theme` validated by `clean_theme` (unknown keys dropped, colours only, 16 KB at most); a theme with the same colours already saved (base, accent, buttons, tint, tokens) is returned as it is, nothing added · `422 invalid_theme` · `409 too_many_themes` (50 kept) |
| PATCH | `/api/settings/themes/{id}` | `{name}` | `SavedTheme` (renames `theme.name`; cleaned like a theme's name, 60 characters at most) · `422 invalid_theme` empty name · `404 not_found` |
| DELETE | `/api/settings/themes/{id}` | – | `{ok}` · `404 not_found` |
| GET | `/api/settings/themes/session/{sid}?since=<at>` | – | `{theme:Theme, file, at}`: the newest `*.theme.json` the session wrote in its topic folder or its `themes/` sub-folder, modified at or after `since` (default: the session's `created`), validated by `clean_theme` (the theme generator of Settings -> Appearance; skill `pilot-theme`). Regular files only (a symbolic link is never read), 16 KB at most · `404 not_found` (session) · `404 no_theme` (none yet) · `422 invalid_theme` (not JSON, too big, a value that is not a colour: `message` says which) |
| GET / PUT | `/api/settings/profile` | `{name ≤32, color: "clay"\|"blue"\|"violet"\|"green"\|"amber"\|"rose"\|"teal"\|"zinc", emoji}` | `Profile` (bus `profile`) |
| GET / PUT | `/api/settings/register` | `{count?, email?, news?, asked?}` (email: valid or `""`) | `RegisterState` `{count, count_blocked, email, news, asked, registered, error, synced_at}` (bus `register`). Optional hello to the authors (`maxxing/register.py`): `count` (default `true`) = anonymous daily signal (cloud id + version + `os`, `arch`, `health` codes), `count_blocked` = `MAXXING_NO_TELEMETRY` / `DO_NOT_TRACK` set in the service environment (counter off whatever `count`); `email` (+ `news`) adds pseudo and language; neither = cloud row archived (kept, never contacted again). An update never turns on the email or the news; 2.0.0a94 turned `count` on once where `asked` was false. |
| GET / POST | `/api/settings/feedback` | POST `{email, type: bug\|idea\|other, message}` | GET `{email, version}` (prefill); POST `{ok}`. Feedback to the authors (`maxxing/feedback.py` -> cloud `/v1/feedback`). Errors: 400 `invalid_email` / `message_required` / `too_long` / cloud codes, 429 `rate`, 502 `unreachable`, 503 `offline`. |
| GET / PUT / DELETE | `/api/settings/license` | PUT `{key}` (`HM-XXXX-XXXX-XXXX-XXXX`) | `{has_key, key_hint, kind, email, max_servers, expires_at, activated_at, enabled, moved_to_git}` (bus `license`, never the key). Optional Enterprise key: PUT = `license.activate` (cloud `/v1/activate`: checks it, counts this server; 400 `invalid_key` / `limit` / `revoked` / `expired` with the cloud message), DELETE = `remove_key` (frees the seat). Changes nothing else: code and updates stay on git. |
| GET | `/api/secrets` | – | `[{name, note, expose, updated, preview}]` (preview = first 4 chars + …, only `…` for values < 8 chars) |
| PUT | `/api/secrets/{name}` | `{value?, note?, expose?}` | `{ok}` · `400 invalid_name\|reserved_name\|value_required\|invalid_value\|invalid_note` (PATH, HOME…, MAXXING_* are reserved; a value has 1 to 16384 characters, no null byte, no lone surrogate) — `expose` = exported as env var to Claude sessions |
| GET | `/api/secrets/{name}/reveal` | – | `{value}` |
| DELETE | `/api/secrets/{name}` | – | `{ok}` |

## MCP servers
Claude Code's MCP servers (maxxing/mcp.py), shown in Settings -> MCP. Bus topic `mcp`.
```
McpServer = {id:"<scope>|<folder>|<name>", name, scope:"user"|"local"|"project",
  where:{rel:"projects/acme/topics/ads"|null, project, topic, exists, path:"/abs/folder"|null},
  type:"http"|"sse"|"stdio", url?, command?, args?, headers?, env?,   (secrets shown as "•••": every header / env
    value that is not only ${KEY} references (an auth scheme word aside; Content-Type, Accept... stay), the
    user:password and query values of url)
  literal_secret:bool, keys:[vault names referenced as ${KEY}],
  state:"connected"|"needs_auth"|"failed"|"pending"|"unknown", detail, checked_at, approved? (project scope)}
```
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/mcp` | – | `{servers:[McpServer], checking, checked_at, config_file, auto}` (first call starts a check; `auto` = config `mcp_auto`) |
| PUT | `/api/mcp/auto` | `{enabled}` | `{ok, enabled}` - config `mcp_auto` (turning it on starts a check: it lists the claude.ai connectors) |
| POST | `/api/mcp/check` | – | `{checking:true}` - `claude mcp list` per folder in the background, then bus `mcp` |
| POST | `/api/mcp` | `{name, where:"" \| "projects/…", type:"http"\|"sse"\|"stdio", url?, command?, args?, headers?, env?}` | `{id, exposed:[vault keys now exposed]}` · `400 bad_name\|bad_url\|bad_command\|bad_type\|bad_where\|too_long` (a value over 8192 characters, or 32768 in all), `404 folder_missing`, `409 exists` |
| DELETE | `/api/mcp?id=` | – | `{ok}` |
| POST | `/api/mcp/login` | `{id}` | `{login, url}` - runs `claude mcp login --no-browser` in a pseudo-terminal; replaces an attempt already open for that server · `400 no_login_url`, `404 folder_missing`, `500 no_claude\|cli_failed` |
| POST | `/api/mcp/login/{login}` | `{redirect}` (the localhost callback URL) | `{ok, message}` · `400 bad_redirect\|login_failed`, `404 login_expired` (also cancelled meanwhile), `409 busy` (already being finished), `504 timeout` |
| DELETE | `/api/mcp/login/{login}` | – | `{ok}` |

## Browser of my PC
`maxxing/pcbridge.py` + `api/pc.py`. One paired PC runs the Harness PC agent (`pc-agent/`, contract
`pc-agent/PROTOCOL.md`); Claude reaches its browser through the user-scope MCP `harness-pc`.
```
PcStatus = {available, device:{id,name,os,arch,browser,browsers,version,created,last_seen}|null, online,
  browser_running, mcp_running, last_use|null, mcp_registered, pairing:{expires_at,browser,os}|null,
  candidate, settings:{idle_min}, browsers:[…], targets:[…], actions:[{at,tool,ok,ms,args:{url?,…}}]}   (newest first, 20)
available = a Harness PC can be downloaded (MAXXING_PC_BIN_DIR, or files listed in pc_agent.json); the UI hides the
  card while it is false and no PC is paired
candidate = {id,name,os,arch,version,created,ip}|null in PcStatus: a PC that paired with a code and waits for the user
PcPairing = {code, expires_at, expires_in, server, downloads:{<target>:url}, commands:{windows,darwin,linux}}
target = windows-amd64|windows-arm64|darwin-arm64|darwin-amd64|linux-amd64|linux-arm64
```
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/pc` | – | `PcStatus` |
| POST | `/api/pc/pairing` | `{browser, os, autostart?}` | `PcPairing` (code valid 15 min, replaces the previous one) · `422 invalid`, `409 no_agent` (nothing to download) |
| POST | `/api/pc/confirm` | `{id, ok?:true}` | `{ok}` - yes: the candidate becomes the PC (replaces the previous one, MCP registered); no: its agent gets `unpair` · `ok:false` when it is not the candidate or expired (15 min) |
| PUT | `/api/pc/settings` | `{idle_min}` (1–240) | `{idle_min}` |
| POST | `/api/pc/stop` | – | `{ok}` - closes the browser and the tools |
| POST | `/api/pc/wipe` | – | `{ok}` · `409 offline`, `502 pc_error` |
| POST | `/api/pc/test` | – | `{ok, text}` (`list_pages` through the MCP path) |
| POST | `/api/pc/mcp/register` | – | `{ok}` · `409 not_paired` |
| DELETE | `/api/pc` | – | `{ok}` - unpairs (the agent removes its autostart and exits), MCP removed |
| POST | `/api/pc/pair` | `{code, name, os, arch, version, browsers}` | `{device_id, token}` - the PC is a `candidate` until `/confirm` · public, `403 bad_code\|expired` |
| GET | `/api/pc/download/{target}?code=` | – | the agent binary + config trailer, streamed from the cached agent (`Content-Length` set) · public, `403`, `404` |
| GET | `/api/pc/install.ps1\|sh?code=&target=` | – | install script (downloads, starts) · public |
| WS | `/api/pc/ws` | `Authorization: Bearer <device token>` | agent control + DevTools frames (PROTOCOL.md) · close `4401` |
| WS | `/api/pc/cdp` | `X-PC-Secret` | loopback only: DevTools relay for chrome-devtools-mcp · close `4403` |
| POST | `/api/pc/mcp` | JSON-RPC, `Authorization: Bearer <mcp secret>` | loopback only: MCP (streamable HTTP, JSON) `initialize`, `ping`, `tools/list`, `tools/call` · `403` - a `url` of the PC itself or its local network (localhost, private / link-local IPs in any IPv4 form, bare names, `.local`, `.lan`…) is refused like `file:` |

## Voice (speech-to-text)
Claude cannot listen: audio is transcribed on the server (web mic button + Telegram voice notes).
```
VoiceStatus = {settings:{engine:"off"|"local"|"groq"|"openai", model:"tiny"|"base"|"small"|"medium", language:"auto"|"<iso>", auto_send:bool, direct:bool},   // direct (default true): the web mic sends the recording at once
  ready:bool, reason:"off"|"no_ffmpeg"|"not_installed"|"no_key"|null, ffmpeg:bool,
  local:{installed, loaded:str|null, recommended, ram_gb, cpus, models:[{id, size_mb, present}]},
  keys:{groq:bool, openai:bool}, key_names:{groq:"GROQ_API_KEY", openai:"OPENAI_API_KEY"},
  install:{state:"idle"|"running"|"done"|"error", step:"deps"|"model"|null, progress:0..1|null, model, message, error, at},
  max_seconds:900}
```
| GET | `/api/voice` | – | `VoiceStatus` (the UI polls it every second while `install.state = running`) |
| PUT | `/api/voice/settings` | partial settings | `{ok, settings}` · `400 invalid_language` · `422` bad enum. Default model when never chosen: `small` (`base` with < 4 GB RAM) |
| POST | `/api/voice/install` | `{model?}` | starts the background job: `uv sync --extra voice` when faster-whisper is missing, then the model download → `install` object · `409 busy` |
| DELETE | `/api/voice/models/{model}` | – | `{ok}` (deletes a downloaded local model) |
| POST | `/api/voice/transcribe` | multipart `audio` (+ form `path`? topic path, `language`?) | `{text, language, duration_s, engine, model, ms, audio_path}` — `path` keeps the original file in `<topic>/attachments/voice/YYYY-MM/` (`audio_path`, else null). Any format ffmpeg reads (webm/opus, ogg/opus, m4a, mp3, wav, mp4), ≤ 100 MB, ≤ 15 min · `409 voice_off` · `503 not_installed\|no_key\|no_ffmpeg` · `413 too_long\|too_large` · `422 bad_audio\|empty_audio` · `502 engine_error\|bad_key\|download_failed` |

Telegram: voice notes and video notes in a session thread (not audio files: attachments) are downloaded, transcribed, echoed as
`🎤 <transcript>` and sent to the session as the user message (attachment = the audio file). Engine off → a hint.

## System
| GET | `/api/system/health` | – | `{ok, issues:[{level, code, text}], cpu_pct, load, mem:{total,avail}, disk:{total,free,pct}, uptime_s, claude_auth, claude_auth_error, claude_checked_at, backup_age_h, failed_logins_1h, at}` (each issue also has `id` and `seen`; issue `claude_auth`: "Claude is not connected" or "Claude sign-in expired…") (cached 30 s, `?force=1`) |
| POST | `/api/system/health/seen` | `{id, seen=true}` | the health above, fresh - marks a current issue as seen (or not): it stops counting in the sidebar dot until its text changes (numbers left out of the `id`) or for 24 h; marks in `<state>/health-seen.json` · `404 not_found` |
| GET | `/api/system/services` | – | `[{name, label, active:bool, enabled:bool, since:float\|null, state}]` (claude-maxxing, caddy, tailscaled, cron + config `services_extra`; units not installed are omitted; one `systemctl show` call, cached 10 s, dropped by a service action) |
| POST | `/api/system/services/{name}/{start\|stop\|restart}` | – | `{ok}` (self restart deferred 2 s) |
| GET | `/api/system/logs?unit=&lines=200` | – | `{lines:[str]}` |
| GET | `/api/system/version?refresh=1` | – | `{version, commit, latest_commit\|null, behind:int\|null, checking:bool, checked_at:float\|null, custom:{count, titles, dirty, rebase}, pending:{at, reason:"conflict"\|"health"\|"dependencies", target_version?, conflicts?}\|null, license:{enabled, key_hint, email, kind, updates_until, expires_at, channel, latest, message, max_servers, moved_to_git, move_error}, report:{at, version, ok, problems}\|null, after:{to, at, notes_session?, notes_path?, done}\|null}` (remote checked every 10 min with git and the update token; nothing on an install still on archives until it has moved to git; `refresh=1` checks now and waits; `commit` and `custom` count/titles/dirty are cached 30 s and while the clone's HEAD / branch ref / index are unchanged, `refresh=1` re-reads them, `rebase` and `pending` are always fresh) |
| POST | `/api/system/update` | – | `{ok}` starts `pilot update --smart` in a transient unit (after the restart the server verifies, then opens the upgrade-notes session) |
| GET | `/api/system/update/preflight?refresh=` | – | `Preflight` = `{ok, verdict: up_to_date\|simple\|adapt, current, latest, behind, customs:[{id, title, why, files, status: ok\|review\|included\|conflict\|unknown, conflicts, overlap}], unsaved, unsaved_overlap?, web_changes, extensions:[{id, name, api, reason}], notes:[{version}], changelog}` - the update simulated in a throw-away git worktree; cached until HEAD / target / unsaved files change; `refresh` fetches first · `502 preflight_failed` |
| POST | `/api/system/update/assist` | – | `{session}`: a session in the update topic that adapts this server's changes then updates |
| GET | `/api/system/update/report` | – | `{report}` = last verification `{at, version, ok, problems, extensions:[{id, name, type, ok, error, skipped?}], checks:[{id, title, check, ok, output}]}` or null |
| POST | `/api/system/update/verify` | – | `{report}`: verify now |
| POST | `/api/system/update/fix` | – | `{session}`: a session that fixes what the last report found · `409 nothing_to_fix` |
| GET | `/api/system/changelog?limit=10` | – | `{version, entries:[{version, label, current:bool, body:markdown}]}` newest first, parsed from the public `CHANGELOG.md` (`2.0.0-alpha.6` matches `2.0.0a6`); `limit` 1-500 (Settings -> Updates asks 500) |
| GET | `/api/usage` | – | experimental Claude plan usage `{available, five_hour:{pct, resets_at}\|null, seven_day:{…}\|null, reason?, stale?, retry_at?}` (off unless settings `usage_widget`; 60 s cache, `?force=1`). Token: the stored long-lived `claude_oauth_token` first, else the `claude login` credentials file. `reason`: `disabled`, `no_oauth_credentials`, `api_key` (no plan usage with an API key), `rate_limited` (429: no call before `retry_at` = now + Retry-After, even forced; the last good values are returned with `stale`), `http_<status>`, or an exception name |

## Import (from another agent)
Zip layout and merge rules: `server/maxxing/importer.py` and docs/user/21-import.md.
| GET | `/api/import/prompt?agent=hermes\|claude-code\|openclaw\|other` | – | `{agent, agents, prompt}` |
| POST | `/api/import/upload` | multipart `file` (≤ 600 MB) | preview, writes nothing → `{id, name, projects:[{name, exists, topics:[{name, source, files, exists}]}], skills, aside, root_memory, files, size, skipped:[{file, reason}], secrets:[{file, kinds}], renamed:[{from, to}]}` · `400 bad_zip\|empty` · `413 too_big\|too_many_files` |
| POST | `/api/import/{id}/apply` | – | imports (never overwrites: memory/CLAUDE.md get an "## Imported" section, other files `<name> (imported)`, skills `<name>-imported`; files with secrets refused; Claude Code settings and Harness folder settings `.maxxing.json` / `.order.json` refused; a file whose place is taken by a folder, sits behind a file, or would be written through a link leading out of the workspace is added to `skipped` and the import goes on) → `{ok, projects, topics, files, merged, renamed, skills, aside, secrets, skipped, folder, report, finish_prompt}` · `400 bad_zip` · `404 not_found` (expired, 24 h) · `409 busy` (another import is being applied) `\|conflict` |
| DELETE | `/api/import/{id}` | – | forgets an upload → `{ok}` |

## Docs
| GET | `/api/docs` | – | `[{slug, title, section, order}]`; `?full=1` adds `markdown` to every page (full-text search, one request) |
| GET | `/api/docs/{slug}` | – | `{slug, title, markdown}` |

## Git

Read-only (`maxxing/gitview.py`). `repo` = an absolute path of a clone inside the files root (a sub-folder resolves
to its clone), or `github:owner/name` (every GitHub token of the server: vault keys whose value looks like one - any name - plus `GITHUB_TOKEN` / `GH_TOKEN` and the backup token; a repository call uses a token that listed it, then the others). Errors: `400 bad_path|bad_sha|
bad_repo|git_failed`, `403 outside_root`, `404 not_a_repo|not_found|no_branch`, `401 bad_token`, `400 no_token`,
`502 github_unreachable|github_error`, `504 git_timeout`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/git/repos?refresh=` | – | `{root, local:[{path, name, branch, upstream, ahead, behind, changed, untracked, last_commit, last_subject, remote, github, error, worktrees}], github:{connected, login, accounts:[{login, name, avatar, keys:[key name], repos}], errors:[{key, error}], error, repos:[{full_name, owner, name, description, private, fork, archived, permission: admin\|maintain\|push\|triage\|pull\|none (best of the tokens), default_branch, pushed_at, url, language, stars, open_issues, keys, accounts, local_paths}]}}` (token values never returned) — cached 60 s (`refresh=1` rescans); clones found under the files root, depth ≤ 6, `node_modules`-like and dot folders skipped, a clone's tree not searched; linked worktrees of a listed clone counted in its `worktrees`, not listed; remote URLs without credentials |
| GET | `/api/git/graph?repo=&limit=200&branches=a,b` | – | `{repo:{kind: local\|github, id, name, branch, github, ...summary or {url, private, permission, description, branches, branches_shown}}, commits:[{sha, parents, refs:[{name, kind: head\|branch\|remote\|tag, current?}], author, date, subject}], truncated}` — newest first, children before parents; subject and author cut at 500 characters (`…`); limit ≤ 1000; GitHub = default branch (100) + the 12 other branches (40 each) merged |
| GET | `/api/git/commit?repo=&sha=` | – | `{sha, parents, author, email, date, message, files:[{path, additions, deletions}], files_total, url?}` (a merge: diff against its first parent; message cut at 50 000 characters (`…`); ≤ 300 files; an annotated tag shows its commit; `sha` is an object id, never a branch or tag of that name; 404 `no_commit` for a tree or blob id) |
| GET | `/api/git/pulls?repo=github:owner/name` | – | `[{number, title, author, head, base, draft, url, updated}]` (open, 30) · `400 not_github` |

## Infra

Inventory (`maxxing/infra/`, Settings -> Features -> `infra_page`, off by default). One snapshot
(`<state>/infra/snapshot.json`) refreshed in the background (`infra_refresh_min`, 15) while the page is on, or on
demand. Every route: `409 disabled` when the page is off (except `GET`).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/infra` | – | `{enabled, refreshing, error, refresh_min, generated_at, took_ms, harness_host, sources:{servers:{<name>:{ok, error, took_ms}}, cloudflare:{connected, key, error, sections:{zones, workers, worker_domains, pages, r2, d1, registrar, dns: "ok"\|"missing_permission"\|…}}, hostinger:{connected, key, sections:{domains, vps}}, vercel|netlify|supabase|github:{connected, key, error, label, beta, token_url, keys, sections:{sites, databases, buckets, functions, domains}}}, resources:[Resource], servers:[{name, label, host, user, port, note}]}` |
| POST | `/api/infra/refresh` | – | `{started, refreshing}` (`started:false` when one is already running) |
| POST | `/api/infra/annotate` | `{id, project?, note?, hidden?}` | the registry entry (`project:""` clears it) |
| GET | `/api/infra/reserved` | – | `{names}`: names a path site cannot take |
| POST | `/api/infra/servers/connect` | `{id: "server:hostinger:<n>", label?}` or `{host, user?, port?, label?}` | `{connected:true, name, label, host, user, port, via: existing_key\|added_key\|harness_key}`; `{connected:false, message, public_key, command}` when no key works on a non-Hostinger server; `409 exists`, `422 <code>` (`not_found`, `no_key`, `missing_permission`, `ssh_refused`…). A Hostinger VPS may get the Harness key in its root `authorized_keys` (the only provider write) and takes up to a minute |
| POST | `/api/infra/servers/rename` | `{name, label}` | `{name, label}` (the label shown; the name never changes) |
| POST | `/api/infra/servers/remove` | `{name}` | `{removed}`; `404` |
| POST | `/api/infra/domains` | `{name}` | `{name}` (normalised: lower case, IDNA, no scheme/path); `400 invalid_domain`. A domain from any registrar, read through RDAP + public DNS |
| POST | `/api/infra/domains/remove` | `{name}` | `{removed}`; `404` when it was not added by hand |

Resource: `{id, kind: server|site|worker|pages|database|bucket|domain, name, location: local|<server>|cloudflare|hostinger|other,
provider, urls, status: ok|warn|down|unknown, status_detail (http_<code>, unreachable, timeout, tls_invalid, cert_expiring,
cert_expired, dns_elsewhere, domain_expiring, domain_expired, missing, disk_low, backup_failed, deploy_failed,
list_failed, file_missing), details, links:[id], project, note, hidden, declared, missing}`. Ids: `server:<name>`,
`site:<server>:<host><path>`, `db:<server>:<engine>:<container|native>:<db>`, `db:<server>:sqlite:<path>`,
`db:cloudflare:d1:<name>`, `bucket:<server>:garage:<name>`, `bucket:cloudflare:r2:<name>`, `worker:cloudflare:<name>`,
`pages:cloudflare:<name>`, `domain:<name>`, `server:hostinger:<id>` (a Hostinger VPS not registered for SSH).

## Team

Chats between people (`maxxing/team.py`, `maxxing/teampeer.py`, Settings -> Features -> `team_page`, off by default).
Errors: `{error, message}`: `400 empty|no_members|invalid_poll|invalid_emoji|bad_file|bad_id|bad_invitation|self|
not_https|not_public|invalid_theme`, `404 not_found`, `409 nothing_new|not_reachable`, `422 invalid_theme`,
`502 summary_failed|unreachable|bad_answer`, `504 timeout`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/team` | – | `{me, people:{<id>: Profile + {server, status, address?, peer?, contact?}}, chats:[Chat + {last, unread, updated}], reactions}` |
| POST | `/api/team/chats` | `{kind: dm\|group, members:[contact ids], name?, emoji?}` | Chat (a DM with the same person returns the existing one); a group is sent to every member with its pair keys |
| GET | `/api/team/chats/{cid}` | – | `{chat, messages:[Message]}` (format: `team.py` docstring) |
| POST | `/api/team/chats/{cid}/read` | – | `{ok}` |
| POST | `/api/team/chats/{cid}/messages` | `{text, reply_to?, files?:[{path}]}` | Message (`pending` = members not reached yet) |
| POST | `/api/team/chats/{cid}/messages/{mid}/edit` | `{text}` | Message (`edited`; own messages only) |
| POST | `/api/team/chats/{cid}/messages/{mid}/delete` | – | Message (`deleted`; own messages only) |
| POST | `/api/team/chats/{cid}/typing` | – | `{ok}` (signal to the members, at most every 3 s, never queued) |
| POST | `/api/team/chats/{cid}/group` | `{name?, emoji?, add?:[contact ids], remove?:[ids]}` | Chat (creator only) |
| POST | `/api/team/chats/{cid}/leave` | – | Chat (`left: "self"`, read-only, final) |
| POST | `/api/team/chats/{cid}/mute` | `{muted}` | Chat |
| POST | `/api/team/presence` | – | `{ok}` (the UI is open; sent to the contacts at most every 2 min) |
| POST | `/api/team/files` | multipart `file` (≤ `upload_max_mb`) | `{files:[{path, name, size, mime}]}` saved under `<workspace>/team/attachments/YYYY-MM/` |
| POST | `/api/team/chats/{cid}/messages/{mid}/react` | `{emoji}` | Message (toggle) |
| POST | `/api/team/chats/{cid}/polls` | `{question, options:[2..12], multi}` | Message |
| POST | `/api/team/chats/{cid}/themes` | `{theme:Theme}` | Message `kind: theme`, `theme` = the theme validated by `themes.clean_theme`, `text` = its name (`422 invalid_theme`). Received: validated again by the receiving server (a theme that is not colours only refuses the whole message: `400 invalid_theme`), shown as a card with a preview and **Install**; it is never applied nor saved by itself. Cannot be edited; deleting it drops the theme. A summary names it only (`[colour theme] <name>`) |
| POST | `/api/team/chats/{cid}/messages/{mid}/vote` | `{option}` | Message (toggle; one answer clears the others unless `multi`) |
| POST | `/api/team/chats/{cid}/summarize` | `{ids?, since?}` | Message `kind: summary` (`ids` = the chosen messages, else after `since`, else after the last summary) |
| POST | `/api/team/chats/{cid}/messages/{mid}/forward` | `{text, session?}` or `{text, path, title?}` | `{session, message}`; the message's files go as attachments |
| GET | `/api/team/connections` | – | `{ok, address, reason: ""\|no_address\|not_https\|tailscale\|local, insecure, contacts:[{address, id, name, emoji, color, status: accepted\|request\|waiting, fingerprint, since, last_seen}], open_invites}` |
| POST | `/api/team/connections/invite` | – | `{invitation: "<address>#<code>", expires}` (15 min, one use) |
| POST | `/api/team/connections/join` | `{invitation}` | `{address, fingerprint}` (status `waiting` until the other side accepts) |
| POST | `/api/team/connections/answer` | `{address, accept}` | `{ok}` (accept is delivered at once, or fails) |
| POST | `/api/team/connections/remove` | `{address}` | `{ok}` (the other server is told) |

Between servers (public, no cookie, `404` while `team_page` is off; protocol in the `teampeer.py` docstring):

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/team-peer/hello` | `{from, to, nonce_b, proof, profile}` | `{nonce_a, proof_a, profile}` · `403` no matching invitation · `429` after 5 bad hellos/h/IP |
| POST | `/api/team-peer/inbox` | signed event `{type: accept\|refuse\|bye\|profile\|presence\|chat\|message\|vote\|react\|typing\|read\|edit\|delete\|leave, …}` | `{ok}` · `401` unsigned / stale / replayed · `403` bad signature · `429` `too_many_groups` (a new group past 50 open groups from that sender) |
| GET | `/api/team-peer/files/{fid}` | signed | the file, when the sender is a member of a chat where it was shared (`Content-Disposition` built by `downloads.content_disposition`) |

## Dashboard & extensions
```
Card = {title?, status?:"ok"|"warn"|"error", link?:string, blocks:[Block], updated?:float}
Block =
  {type:"stat", label, value, unit?, hint?, delta?, tone?:"ok"|"warn"|"error"}
    // a number value / delta is written in the user's language (Intl.NumberFormat), `unit` after it ("%" as a percentage)
| {type:"stats", items:[stat…]}
| {type:"list", items:[{title, subtitle?, value?, href?, status?, icon?, emoji?}], empty?, grid?} (grid = tiles 2-3 per row; icon = lucide name drawn with the accent colour, preferred over emoji)
| {type:"chart", kind:"bar"|"line", series:[{name, points:[[x,y]]}], unit?}
| {type:"table", columns:[str], rows:[[cell]]}
| {type:"progress", label, value, max, hint?, unit?, format?:"percent"|"fraction"}
    // format "percent" -> "4.5 %" (value/max×100) · default "fraction" -> "2.3 / 16.4 GB" (unit appended)
| {type:"markdown", text}
| {type:"timeline", start, end, now?, more?, lanes:[{name, sub?, color?, href?, dense?, events:[{at, state?:"ok"|"error"|"running"|"planned", label?}]}]}
    // unix seconds; one row per lane: filled dot = ok/error, hollow = planned, pulsing = running, line = now.
    // dense: too many events to tell apart -> a band (only error/running dots drawn). A 24 h span is
    // labelled 00:00..24:00 from start (server time zone). Built-in "day" widget = today's crons.
```
| GET | `/api/dashboard` | – | `{widgets:[{id, title, icon, span:1\|2\|3, source:"builtin"\|"extension", card:Card\|null, error:string\|null, hidden:bool, pending?:true}]}` — hidden widgets are listed with `card:null` so the UI can show them again; a widget still computing after 1.5 s comes as `pending:true` (fetch it with the route below, which joins that computation); the `crons` and `day` cards are reused while jobs.json, runs.jsonl, the job locks and config.json are unchanged (10 s at most); `?force=1` recomputes everything |
| GET | `/api/dashboard/widgets/{id}?force=1` | – | one widget (refresh) |
| PUT | `/api/dashboard/layout` | `{order:[id], hidden:[id]}` | `{ok}` |
| GET | `/api/extensions` | – | `[{id, name, type:"widget"\|"page"\|"block", icon, version, enabled, error, has_api, pinned, page_v, renders?}]` (pinned: page shown in the sidebar; page_v: page.js mtime in ms, the UI imports `page.js?v=<page_v>` so the module is reused until the file changes; `block` = a conversation block plugin described by `block.json`, `renders` = its block types, see Conversation blocks) |
| PATCH | `/api/extensions/{id}` | `{enabled?, pinned?}` | `{ok}` (`pinned` on a widget -> 400 `not_a_page`) |
| POST | `/api/extensions/reload` | – | rescans `<workspace>/extensions` |
| ANY | `/api/ext/{id}/{path}` | – | forwarded to the extension's `api.py` `handle()`: return value → JSON, `(status, body)` tuple sets the status, `ValueError` → 400, `LookupError` → 404, other → 500 `extension_error`, 30 s timeout (504 `extension_timeout`), 503 `extension_busy` at once while an earlier timed-out `handle()` of the same extension has not returned, or when the 4 extension threads are all still running earlier calls. A `.` / `..` segment in `path` → `400 bad_path` |
| GET | `/ext/{id}/page.js` | – | page module (ES module) |
| GET | `/ext/ui-kit.css` | – | the UI kit of extensions (`server/maxxing/assets/ui-kit.css`): `ui-*` classes scoped to `.mx-ext` (page host) and `[data-mx-kit]` (widget frame), built on the theme variables; the app adds it once when a page extension opens; `ETag` (content hash), `If-None-Match` -> `304` |
| GET | `/ext/{id}/widget-frame` | – | HTML widget document: the bridge (`maxxing.api / resize / theme`, theme from the URL fragment) + the UI kit inlined (`<html data-mx-kit>`) + `widget.html`, `Content-Security-Policy: sandbox allow-scripts allow-pointer-lock` (the UI frames it with the same sandbox; an srcdoc frame would inherit the app's script policy). `/ext/{id}/widget.html` stays the raw file (text/plain) |

The app page (`index.html`) is served with `script-src 'self'` plus the hashes of its inline boot scripts
(`app._app_csp`): a page extension's `page.js` runs in the app, so it may not inject inline `<script>` nor use
`eval` / `new Function` (load code as modules from its own folder).

Extension folder: `<workspace>/extensions/<id>/manifest.json`
`{"id", "name", "type":"widget"|"page", "icon":"<lucide name>", "version", "span"?, "ttl"?: seconds}` +
`api.py` (widget: `def card(ctx) -> dict` returning a Card; page/API: `def handle(ctx, method, path, query, body) -> dict`) +
`page.js` (page: `export function mount(el, ctx) { …; return () => cleanup }`, `ctx = {api(path, opts), navigate, theme, lang, t, icon(name, {size?, className?}) -> <svg>}`).

Extension details: `ctx` (Python) = `{id, workspace, state_dir, secret(name) -> str|None, config:{timezone, language,
public_url}}`; `state_dir` = `<state>/extensions/<id>/` (created). Extensions are rescanned automatically when a
folder, `manifest.json`, `api.py` or `page.js` changes (hot reload). Widget ids of the built-ins (`activity, tasks,
crons, server, backup, telegram, usage`) are reserved. In `page.js`, `ctx.api(path, {method, body})` is expected to
call `/api/ext/<id>/<path>` with the CSRF header and resolve to the parsed JSON (see examples/extensions/notes-page).
Built-in card links are SPA routes: `/sessions/<id>`, `/sessions`, `/tasks?task=<id>`, `/crons?job=<id>`,
`/settings/{system,backup,telegram}`. Built-in card labels follow the configured language (en/fr).

## Conversation blocks

An assistant answer shows a **block** for each fenced code block whose info string is a block type and whose body is
one JSON object, or `block:<type>` (always a block: a type no plugin draws shows "not installed"):

````
```chart
{"kind": "line", "unit": "€", "series": [{"name": "October", "points": [["1 Oct", 320], ["8 Oct", 410]]}]}
```
````

- Built-in types are blocks when the body looks like a JSON object (anything else stays code); `terminal`, `diff` and
  `app` also take raw text (output, unified diff, HTML: field `raw` of the plugin). A plugin type is a block only when
  an installed block extension draws it and the body is a JSON object; otherwise the fence stays ordinary code.
- The web app (`web/src/features/blocks`) parses the body (512 kB at most), checks it against the type's `schema`
  (the subset below) and draws it. Fallbacks, with the raw data on demand: unknown type ("not installed", link to the
  catalogue), turned off ("Turn on"), plugin error, invalid data (the reasons + "Ask for a fix", which sends a message
  to the conversation after a confirmation), render error, network consent (block extensions).
- Every block has a header (type icon, title, source), a body, and actions: open beside (side panel; a
  `mx-block-open` window event, and the conversation's `BlockHostProvider.openPanel`: the session column's panel,
  docked beside the thread when there is room), pin to the dashboard (pinnable
  types), copy / download (JSON, CSV, PNG, text, diff, HTML).
- Forms, checklists, "Ask for a fix" and `maxxing.send()` from a frame send **text the user sees and confirms** as
  their next message: `POST /api/sessions/{id}/messages` (session: `BlockHostProvider.sessionId`, else the nearest
  `[data-mx-session]`, else the URL's `session=`).

Built-in types (`maxxing/blocks.py` `BUILTINS`, the source of the schemas):

| Type | Body |
|---|---|
| `chart` | `{kind?: "line"\|"bar", series: [{name, points: [[x, y]]}] (1-6), unit?, title?, source?}` - pinnable |
| `table` | `{columns: [label \| {label, type?: "text"\|"number"\|"percent"\|"delta"\|"bar", align?}], rows: [[cell]], page_size?, title?, source?}` - sort, filter, CSV; pinnable |
| `stats` | `{items: [{label, value, delta?, hint?, tone?: "ok"\|"warn"\|"error"}] (1-12), title?}` - pinnable |
| `list` | `{items: [{title, subtitle?, value?, status?, icon?, href?}], grid?, title?}` - pinnable |
| `timeline` | `{lanes: [{name, sub?, events: [{at: unix s \| ISO date, state?, label?}]}], start?, end?, now?, title?}` - pinnable |
| `progress` | `{items: [{label, value, max, unit?, hint?, format?}]}` or `{label, value, max, …}` - pinnable |
| `terminal` | `{output, command?, exit_code?, duration_ms?, cwd?, title?}` or raw text |
| `diff` | `{diff, path?, title?}` or a raw unified diff |
| `file` | `{path, caption?}` or `{items: [{path, caption?}]}` (absolute paths; the file viewer opens them) |
| `link` | `{url (https:// or an app route), title?, description?, site?}` (nothing is fetched) |
| `form` | `{fields: [{id, label, type: text\|textarea\|number\|select\|choice\|multi\|checkbox\|range\|date\|time, options?, min?, max?, step?, unit?, default?, required?, placeholder?, hint?}], title?, description?, submit?}` |
| `checklist` | `{items: [label \| {label, checked?, hint?}], title?, submit?}` (ticks remembered by the browser) |
| `app` | `{html, height?, title?}` or raw HTML: sandboxed frame, no network |
| `created` | `{items: [{kind: task\|cron\|notification\|file\|session\|project\|extension\|other, title, subtitle?, id?, path?, href?}], title?}` |

Schema subset (`blocks.check_schema` refuses anything else): `type` (string or list), `properties`, `required`,
`additionalProperties` (bool or schema), `items` (schema or tuple), `enum`, `const`, `anyOf` / `oneOf` (= anyOf),
`minItems` / `maxItems`, `minLength` / `maxLength`, `minimum` / `maximum`, plus the annotations `title`,
`description`, `default`, `examples`, `format`, `$comment`, `$schema`. Depth <= 12. Error lines look like
`series[0].points[1][1]: expected number` (same text on both sides).

```
BlockPlugin = {id, kind:"builtin"|"extension", name, names:{<lang>: name}, renders:[type], icon, category:
  "data"|"code"|"media"|"interactive"|"organisation"|"other", hint, fields, schema, raw:string|null, version,
  description, enabled, error:string|null, network:[host], consent:"granted"|"denied"|"ask"|null, pin:bool,
  entry_v:int|null, height:int|null}
// built-in: id = type, name = type (the UI names it), fields = body summary given to the agents
// extension: id = extension id, consent null when it declares no network
```

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/blocks` | – | `{plugins:[BlockPlugin], agents:{types:[type], count, skill, codex, reference, synced_at}}` — built-ins first (fixed order), then block extensions A-Z (a type already drawn by an earlier extension -> that plugin's `error`); also rewrites the agents' files when the enabled set changed |
| PATCH | `/api/blocks/{id}` | `{enabled}` | `{ok, plugin}` · built-in: config `blocks.disabled`; extension: config `extensions.disabled` (the extension itself) · `404 not_found` · bus `extensions` |
| POST | `/api/blocks/{id}/consent` | `{decision:"always"\|"once"\|"deny"\|"reset"}` | `{ok, consent, grant?}` — `always`: the declared hosts are allowed (config `blocks.consent.<id> = {state:"granted", hosts, at}`; a host added later asks again) · `deny`: never asked again · `reset`: asked again · `once`: `grant` = a token valid one hour for one frame (in memory) · `400 no_network` (declares none) · `404` (unknown or built-in) |
| POST | `/api/blocks/pin` | `{type, data, title?}` | `{ok, id}` — writes the widget extension `extensions/pin-<slug>-<hex>/` (manifest + `card.json` snapshot + a fixed `api.py` that returns it); chart, table (50 rows), stats, list, progress, timeline · `400 not_pinnable` (type or invalid data, with the reasons) · `413 too_large` (data over 512 kB) · bus `extensions` |
| GET | `/ext/_blocks/app-frame` | – | the `app` block's frame: a loader that receives the HTML by message and writes it over itself after the bridge and the UI kit · `404 block_disabled` |
| GET | `/ext/_blocks/{id}/frame?grant=&v=` | – | a block extension's frame: bridge + UI kit + its entry (`block.html`) · `404` when unknown, off or broken |

Both frames: auth cookie required, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and
`Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src
'unsafe-inline'; img-src data: blob: [hosts]; media-src data: blob: [hosts]; font-src data: [hosts]; connect-src
[hosts | 'none']; form-action 'none'; base-uri 'none'; frame-ancestors 'self'` where `[hosts]` = `https://<host>` of the
declared hosts when consent is `granted`, or with a valid `grant` (never when `denied`). The UI frames them with
`sandbox="allow-scripts"` (opaque origin: no cookie, no app API, no storage of the app) and `referrerpolicy=no-referrer`.

Frame bridge (`window.maxxing`, injected first): `data` / `onData(fn)` (the block's JSON, by message), `type`,
`theme` / `onTheme(fn)`, `lang`, `resize(px)` (automatic otherwise), `send(text)` (≤ 4 000 characters; the app shows
it and sends it only if the user confirms), `error(message)` (the block shows the error state). Messages parent ->
frame: `{mx:"data", data}`, `{mx:"theme", theme, vars}`, `{mx:"html", html}` (app loader); frame -> parent:
`{mx:"ready"|"loader"|"resize"|"send"|"error"}`. The theme's CSS variables come in the URL fragment for the first paint,
never the data. A frame whose document stops speaking the bridge (it navigated elsewhere) is stopped.

Block extension: `<workspace>/extensions/<id>/block.json` (no `manifest.json`, no Python code):
```
{"type": "block", "name": "Map" | {"en": "Map", "fr": "Carte"}, "version": "1.2.0", "renders": ["map"],
 "schema": {…} | "schema.json", "entry": "block.html", "permissions": {"network": ["tiles.example.com"]},
 "hint": "Places, addresses and routes.", "icon": "map", "category": "data", "description": "…", "height": 320}
```
`renders`: 1-8 slugs `^[a-z][a-z0-9-]{1,31}$`, not a built-in type nor a reserved fence language (`json`, `js`, `ts`,
`text`, `md`, `html`, `xml`, `yaml`, `toml`, `mermaid`, `git`, `infra`, `block`, `code`…). Folder name: not a built-in
type. Limits: block.json 64 kB, schema 64 kB, entry 512 kB (one self-contained HTML file), 8 hosts (host names,
optional `*.` and `:port`, no scheme or path). Listed by `GET /api/extensions` as `type: "block"` with `renders`;
never a dashboard widget. Hot reload like other extensions (block.json, block.html, schema.json watched).

What the agents get (never the user's own CLAUDE.md files): the product skill `pilot-blocks`, rendered with the
enabled types (its description, listed in every Claude Code prompt, and its body); `<state>/blocks/agents.md`, added
to every Codex turn's shared context; `<state>/blocks/reference.md` (full schemas). Rewritten on server start, on
`GET /api/blocks`, on a toggle, after an extension rescan, and by `pilot init`.

## Memory

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/memory` | – | `{max_lines, files:[{path (workspace-relative), level:"global"\|"project"\|"topic", lines, bytes, over:bool}]}` |
| POST | `/api/memory/compact` | – | `{session: Session}` — a session at the workspace root runs the memory-compaction skill now with the line limit |

## Stats

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/stats/tokens?force=1` | – | `{totals, projects:[{name, …}], topics:[{path, …}], sessions:[{id, title, path, archived, updated, …}] (top 100), days:[{date, tokens, cost_usd}] (90 days), latency:{start_s, first_answer_s, turns}, at}` (latency: medians over the last 20 turns of every session: seconds from starting `claude` to its first event / first answer); each group has `input, output, cache_read, cache_write, total, cost_usd, turns, sessions` (sorted by `total`; project `""` = workspace root). Cached 20 s |

## Feed (notifications)
```
FeedEvent = {
  id, at, source, level: "info"|"success"|"warning"|"error", title, body, url, count, read,
  kind: string,              // stable dotted key (table below); "custom" for external posts and rows written before kinds existed
  params: {[name]: string|number|boolean|null},   // values of the kind's translation (table below)
  actions: FeedAction[],     // [] when none
  category: "sessions"|"crons"|"system"|"webhooks",   // the type filter, from the source (below)
  pending: bool,             // needs attention: level warning|error AND unread AND not resolved
  resolved_at: number|null,  // the problem went away (resolved by its producer, or POST /api/feed/resolve)
  first_at: number,          // first occurrence of a folded row (= at while count is 1)
  quiet: bool                // posted with `quiet` (`pilot feed post --quiet`): never sent to Telegram nor pushed,
                             // and the web shows no notice / sound for it (it is in the feed like any other)
}
FeedAction = {id, label, type: "link"|"post", url}
FeedDetail = FeedEvent & {occurrences: [{at, title, body, params}]}   // newest first, at most 20 (body <= 300 chars);
                                                                      // one entry (the event itself) when never folded
```
`count` > 1 = folded repeats. Kept 30 days in `<state>/feed.db`.

- **Text and translation.** `title` / `body` are the English fallback (CLI, Telegram, scripts, old rows). The web shows
  `feed.kind.<kind>.title` (and `.body` when it has one) interpolated with `params`, and falls back to `title` / `body`
  for an unknown kind or a missing translation. For `session.*` and the webhook kinds the `body` is content (Claude's
  last text, a customer e-mail...): show it as it is.
- **Category** (from `source`): `sessions` -> sessions; `crons` -> crons; `system`, `security`, `infra` -> system;
  anything else (webhook sources, scripts) -> webhooks.
- **Folding** (`group`): a post with a group folds into the latest row of the same source + group + level that is
  unread, NOT resolved and younger than 24 h: `count` + 1, `at` / `title` / `body` / `url` / `params` / `actions`
  replaced by the new ones, the occurrence added to `occurrences`. A resolved or read row is never grown: a new one
  starts.
- **Pending / resolved.** "À traiter" = `pending` events. Built-in producers resolve their own problems (column
  *Resolved by* below): `resolved_at` is set and `pending` turns false, the row stays in the activity (still unread
  until read). Resolution only touches warning / error rows.
- **Actions.** `label` is the English fallback; the web translates `feed.action.<id>` (ids are shared between kinds).
  `link`: navigate (an app path in the SPA, an `https://` URL in a new tab). `post`: the web sends `POST <url>` (no
  body, usual cookie + `X-Maxxing` header), then refetches the feed. Only built-in server producers can create `post`
  actions, and only for these paths: `/api/crons/{id}/run`, `/api/sessions/{id}/discussion/resume` - the web should
  run a `post` action only when its url matches one of them. External events (`POST /api/feed`, `pilot feed post`,
  webhooks) may only carry `link` actions whose url is an app path (`/…`, not `//…`) or an `https://` URL:
  `POST /api/feed` refuses anything else with `400 bad_action`, a webhook's are dropped. At most 4 actions per event;
  `id` matches `[a-z0-9_-]{1,32}`, `label` <= 60 characters.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/feed?source=&category=&kind=&unread=1&pending=1&before=<id>&limit=50` | – | `{events: FeedEvent[], more, unread, pending, sources: [{source, total, unread, pending}], categories: {<category>: {total, unread, pending}}, kinds: {<kind>: {total, unread, pending}}}` newest first (`limit` <= 200). The counts cover the last 30 days and ignore the filters; every category is always present · `400 bad_category` |
| GET | `/api/feed/summary` | – | `{unread, pending, sources, categories, kinds}` (the same counts, no events: badges) |
| GET | `/api/feed/{id}` | – | `{event: FeedDetail}` · `404 not_found` |
| POST | `/api/feed` | `{title, body?, level?, source?, url?, dedupe?, group?, kind?, params?, actions?, quiet?: bool}` | `{event, duplicate}` (`quiet`: in the feed only - no Telegram, no push, no notice in the web; `dedupe` = idempotent per source; `group` folds, see above; `kind` defaults to `custom`, the built-in kinds of the sessions / crons / system categories are reserved; `params`: at most 20 names `[a-z_][a-z0-9_]{0,31}`, values string (<= 500 chars) / number / boolean / null; `actions`: links only) · `400 empty\|bad_level\|bad_source\|bad_kind\|bad_params\|bad_action` |
| POST | `/api/feed/read` | `{ids?: number[], source?, all?: bool}` | `{unread, pending}` |
| POST | `/api/feed/resolve` | `{ids: number[]}` | `{pending}` (resolved by hand: out of "À traiter", read state unchanged) |
| DELETE | `/api/feed/{id}` | – | `{ok}` |
| GET / PUT | `/api/feed/settings` | PUT `{telegram?: bool, rules?: {<source>: Rule}, kind_rules?: {<kind>: Rule}}` (`Rule` = `"auto"\|"off"\|"silent"\|"loud"`; both maps merged into the saved ones, `"auto"` removes an entry) | `{telegram, sources: [{source, label, builtin, rule, own_thread}], hooks: FeedHook[], kinds, rules, kind_rules: {<kind>: Rule}, event_kinds: EventKind[]}` (`kinds` = the webhook kinds, unchanged) · `400 bad_rule\|bad_kind` |
| POST | `/api/feed/hooks` | `{name, kind: "stripe"\|"shopify"\|"github"\|"generic", secret?}` | `FeedHook = {id, name, kind, created, url, has_secret}` · `409 exists\|reserved`, `400 bad_kind` |
| PATCH | `/api/feed/hooks/{id}` | `{secret?, regenerate?: bool}` | `FeedHook` (regenerate = new token, the old URL dies; a non-empty secret resolves the hook's `webhook.refused`) |
| DELETE | `/api/feed/hooks/{id}` | – | `{ok}` |
| POST | `/api/feed/hooks/{id}/test` | – | `{event}` |
| POST | `/api/hooks/{token}` | the service's payload (<= 1 MB) | **public** (no cookie, no CSRF header: the token is the permission). Signatures: Stripe `Stripe-Signature` (5 min tolerance), Shopify `X-Shopify-Hmac-Sha256`, GitHub `X-Hub-Signature-256`, generic `X-Signature: sha256=<hex>` - checked when the hook has a secret; a stripe/shopify/github hook WITHOUT a secret refuses every delivery with `401 secret_required` (+ one folded `webhook.refused` warning in the feed); a generic hook without a secret accepts the token alone. `200 {ok, duplicate, id}` / `{ok, ignored}` (Shopify / GitHub: a delivery whose signed body was already posted is a duplicate whatever its delivery-id header; Shopify keys a known topic too) · `401 bad_signature\|secret_required`, `404` (unknown token: checked before the body is read), `413` (Content-Length or streamed body over 1 MB), `429` (120/min/hook), `400 bad_json` (also for JSON nested too deep), `400 bad_payload` (valid JSON whose fields have an unexpected shape for that service). A generic payload may add `actions` (links only; others dropped) |

`EventKind = {kind, category, source, level, builtin, rule, default, own_thread}`: every built-in kind (table order),
then the kinds seen in the last 30 days that are not built-in (`builtin: false`, `source` / `level` of their latest
event). `rule` = the kind's own rule (`"auto"` = none); `default` = what `"auto"` gives now (`"off"\|"silent"\|"loud"`):
the rule of its source when one is set, else `"off"` for the sources that have their own Telegram thread or are already
mirrored (`crons`, `system`, `security`, `sessions`: `own_thread`), else by `level` (error -> loud, warning -> silent,
else off). Effective rule of an event: its kind's rule unless auto, else its source's rule unless auto, else that
default. Telegram posts only new rows (a fold never posts again), never a `quiet` one.

**Kinds.** `params` always hold what the English title says; names in *italics* may be missing. Action ids:
`open` (the event's own page), `open_run`, `rerun` (post), `open_session`, `resume` (post), `add_secret`.

| kind | source | level | params | actions | resolved by |
|---|---|---|---|---|---|
| `session.done` | sessions | success | `session_id, title, path, provider, turns` (never for a mixed-team worker on its assignment, `team_turn`: its coordinator notifies for the team) | `open_session` | – |
| `session.failed` | sessions | error | `session_id, title, path, provider, error` | `open_session` | the next `session.done` of that session |
| `discussion.paused` | sessions | warning | `session_id, title, path, provider ("discussion"\|"debate"), turns, turn_limit, duration_s, duration_limit_s` (limits: number or null) | `resume` (post), `open_session` | resume, a new message, Stop or deletion of that session |
| `cron.succeeded` | crons | success | `cron_id, name, run_id, duration_s` (folded over all jobs, group `ok`: params of the latest run) | – | – |
| `cron.failed` | crons | error | `cron_id, name, run_id, code, duration_s` (folded per job) | `open_run`, `rerun` (post) | the next successful run of that job |
| `update.available` | system | info | `version, current, topic` | `open` | – |
| `update.attention` | system | warning | – (the body explains: customizations, roll-back) | `open` | – |
| `update.review` | system | info | `version` (automatic update waiting for you) | `open` | – |
| `update.started` | system | info | `version` (automatic update starting) | – | – |
| `update.broken` | system | warning | `version, problems, names` (after an update: what stopped working) | `open` | – |
| `claude.updated` | system | success | `version, previous` | – | – |
| `claude.update_failed` | system | error | `version, error` | `open` | the next `claude.updated` |
| `deps.vulnerable` | system | warning | `count` | `open` | – |
| `deps.update_failed` | system | warning | `count, names` | `open` | – |
| `health.issue` | system | warning\|error | `issue_id, code, text, level ("warn"\|"error")` (code = `/api/system/health` issue code; `cron_failed` and `login_failures` are not repeated here) | `open` | the issue disappearing from the health check |
| `mission.review` | system | warning | `title` (a resident mission paused, failed, reached a limit or has a plan to review; `url` = `/settings/missions?mission=<id>`) | `open` | – |
| `mission.completed` | system | info | `title` | `open` | – |
| `signin.ok` | security | info | `ip, ua, via ("password"\|"telegram"\|"code")` (folded) | – | – |
| `signin.failed` | security | warning | `count, ip, ua` | `open` | – |
| `signin.denied` | security | warning | `ip, ua` (denied in Telegram, password right) | `open` | – |
| `webhook.refused` | security | warning | `hook_id, name, service ("stripe"\|"shopify"\|"github")` | `add_secret` | its signing secret set, or the hook deleted |
| `backup.restore_held` | security | warning | `extensions, hooks, mcp, review, outside` (counts) | `open` | – |
| `infra.down` | infra | error | `resource_id, name, reason` | `open` | `infra.up` of that resource |
| `infra.up` | infra | success | `resource_id, name` | – | – |
| `infra.cert_expiring` | infra | warning | `resource_id, name, days` | `open` | – |
| `infra.domain_expiring` | infra | warning\|error | `resource_id, name, days` | `open` | – |
| `webhook.test` | *hook name* | info | `name` | – | – |
| `stripe.sale` · `stripe.payment` · `stripe.refund` · `stripe.payment_failed` | *hook name* | success · success · warning · error | `amount` (formatted, "49.00 EUR"), *`email`* | – | – |
| `stripe.dispute` · `stripe.subscription_created` · `stripe.subscription_cancelled` · `stripe.event` | *hook name* | error · success · warning · info | `amount` · *`email`* · *`email`* · `type` | – | – |
| `shopify.order_created` · `shopify.order_paid` · `shopify.order_cancelled` | *hook name* | success · success · warning | `order, amount` (cancelled: `order`), *`email`* | – | – |
| `shopify.refund` · `shopify.stock` · `shopify.event` | *hook name* | warning · info\|warning · info | `order_id` · `available, item_id` · `topic, order` | – | – |
| `github.ping` · `github.push` · `github.pull_request` · `github.issue` | *hook name* | success · info · info · info | `repo` · `repo, branch, commits, message` · `repo, action, title, user` · `repo, action, title` | – | – |
| `github.workflow` · `github.release` · `github.star` · `github.event` | *hook name* | success\|error · success · info · info | `repo, workflow, conclusion, branch` · `repo, tag, name` · `repo, action, user` · `repo, event` | – | – |
| `custom` | any | any | whatever the poster gave | links given | – |

Telegram: the bot posts in the thread "Notifications" (`telegram.threads["#feed"]`) with buttons *Ask Claude*
(`callback_data f:<id>` -> new session in the default topic, event quoted as data) and *Open* (https links).

## Web Push
Notifications on the phone / computer while no tab is open, for the events of the feed. The server holds a VAPID key
pair (`<state>/push-vapid.json`, mode 600, made on first use) and the subscriptions (`<state>/push.json`).

```
PushSubscription = {id, endpoint, label, created, last_ok: number|null, last_error: string|null, prefs: PushPrefs}
PushPrefs = {
  levels: Level[],                                  // events not matched below are pushed when their level is here
  sound: bool,                                      // the sound of the events not matched below
  kinds: {<kind>: {enabled: bool, sound: bool}},    // per kind: pushed or not, with or without sound
  sources: {<source>: {enabled: bool, sound: bool}} // per source (a webhook, a script's --source): every event of it
}                                                   // default {levels: ["warning", "error"], sound: true, kinds: {}, sources: {}}
```
An event is pushed to a subscription when `prefs.sources[source]` is set (its `enabled` decides), else when
`prefs.kinds[kind]` is set (same), else when its level is in `prefs.levels`; it rings when the `sound` of that same
entry (else `prefs.sound`) is true - the payload carries `silent: !sound` for `showNotification`. A `quiet` event is
never pushed. In a POST / PATCH, `levels`, `sound`, `kinds` and `sources` left out keep their saved value; `kinds` or
`sources` given replaces that whole map (a bare `true` / `false` for an entry = `enabled` with the default sound; at
most 200 entries per map; source names as in `POST /api/feed`). The web sets `kinds` for the built-in rows of
Settings -> Notifications and `sources` for the webhooks and scripts listed there (columns *Browser* and *Sound*).
Only new rows are pushed (a fold does not push again), whatever process posted them (cron runs and `pilot feed post`
too), within ~3 s; rows already there when the server starts are never pushed. A subscription the push service
answers 404 / 410 is removed. Sounds inside an open tab are the web's business (per device), not the server's.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/push` | – | `{available: bool, public_key: string\|null, subscriptions: PushSubscription[]}` (`public_key` = the `applicationServerKey`, base64url of the uncompressed P-256 point; `available: false` + `public_key: null` when the server cannot encrypt - crypto library missing) |
| POST | `/api/push/subscriptions` | `{endpoint, keys: {p256dh, auth}, label?, prefs?}` (= `PushSubscription.toJSON()` + label / prefs) | `PushSubscription` - created, or updated when that endpoint is already known (keys, label, prefs given) · `400 bad_subscription` (endpoint not `https://`, keys not base64url of a P-256 point / 16 bytes), `400 bad_prefs`, `503 unavailable` |
| PATCH | `/api/push/subscriptions/{id}` | `{label?, prefs?}` | `PushSubscription` · `404 not_found`, `400 bad_prefs` |
| DELETE | `/api/push/subscriptions/{id}` | – | `{ok}` |
| POST | `/api/push/subscriptions/{id}/test` | – | `{ok: true, status}` - a test notification (kind `push.test`) · `404 not_found`, `502 push_failed {status}` (`status` 404 / 410: the subscription was removed) |

Payload (JSON, encrypted `aes128gcm`, at most ~3 kB; the service worker shows it):
`{id, at, kind, params, level, category, source, title, body, url, count, actions, tag, silent}` - `body` cut at 500
characters, `tag` = `feed-<id>` (`push-test` for a test), `silent` = the subscription's preference for that kind (pass
it to `showNotification`; the test notification uses `prefs.sound`). The service worker shows `title` / `body`
(English fallback) or its own translation of `kind` + `params`, and opens `url` (or `/feed`) on click.
`Urgency: high` for errors, `normal` otherwise; `TTL` 24 h.

## Packs (starter projects)
`Pack = {id, project, emoji, icon, title, description, topics[], crons[] (names), installed, partial, project_exists, basics}` (title and
description in the configured language). Sources in `templates/packs/<id>/` (`pack.json` + `project/`). The first
pack is `basics` (`basics: true`, topics as `project/topic`): the default workspace from `templates/workspace/projects`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/packs` | - | `{packs: Pack[]}` |
| POST | `/api/packs/{id}/install` | - | `{ok, pack, project, created_files, jobs[]}` - adds the pack as a new project (`<project>`, or `<project>-2`, `-3`... when taken; its title lines renamed), sets the emoji, creates the pack's jobs disabled (`"<job> (<project>)"` for a copy). `basics`: copies the missing files of the default projects, `project` = `""`; `404 unknown_pack` |

## Search

One SQLite FTS5 index (`<state>/search.db`, `maxxing/search.py`) over session messages, workspace text
files (`memory.md`/`CLAUDE.md` = kind `memory`; up to 256 KB each; vendored/build folders and data files -
.json, .csv, .tsv, .xml, .svg - skipped) and tasks. Every memory file of the root, the projects and the topics is
indexed (outside any cap); the other files get a fair budget per topic / project / root (`MAX_FILES` 20 000 //
buckets, clamped 50-1 000), each walk visits at most 20 000 entries and stops at its cap. Incremental: logs from
the last indexed offset, files on mtime/size change; refreshed every 30 s (sessions, memory files, tasks) with a
full walk of the other files every 10 min, and, for sessions, before each query. `GET /api/search/stats` adds
`files_walked_at` and `files` (last walk: files, buckets, per_bucket, cut, dropped). A refresh (or the hourly `optimize`) that changed rows ends
with `PRAGMA wal_checkpoint(TRUNCATE)` (200 ms busy timeout; retried next pass when a query holds a snapshot) and
`journal_size_limit` is 4 MB, so `search.db-wal` does not keep its high-water mark. After a files walk, at most once
a day, `search.db` is VACUUMed when more than 25 % of its pages are free (and it is at least 4 MB).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/search?q=&kinds=session,file,memory,task&limit=30` | – | `{results:[{kind, id (session id / file path / task id), path, title, snippet, at, score}], took_ms}` — every word required, as a prefix, accent-insensitive, BM25 (title x4), one result per session/file/task; `snippet` marks matches with `\u0002`…`\u0003` |
| GET | `/api/search/stats` | – | `{counts:{session, file, memory, task}, bytes, refreshed_at}` |


## Resident missions

Authenticated owner routes, with mutations under the usual CSRF guard:

| Method/path | Behavior |
| --- | --- |
| GET `/api/missions` | List durable mission states, assignments, session references, counters and limits |
| POST `/api/missions` | Create draft `{title, path, goal, steps?, max_runs?, max_minutes?, max_tokens?, concurrent?, interval_minutes?, max_cycles?}`; no model call |
| GET `/api/missions/{id}` | Mission detail |
| PUT `/api/missions/{id}/plan` | Replace an unexecuted plan with `{steps}` |
| POST `/api/missions/{id}/control` | `{action: "plan" | "start" | "pause" | "stop", fingerprint?: plan_fingerprint}`; plan requests read-only architect work, start requires the current plan fingerprint and explicitly authorizes those assignments and limits. `plan_fingerprint` also covers the instructions and engine (provider id; for an extension engine its resolved command and capabilities) of every role the steps use: editing one of them changes it, and an active mission then pauses with reason `plan_changed` (its running agents are stopped) until it is started again with the new fingerprint |
| POST `/api/missions/{id}/steps/{step}/retry` | Explicit owner retry of an interrupted, failed or rejected step of a paused mission: back to `pending`, a new counted run when resumed (409 `busy` otherwise) |
| POST `/api/missions/{id}/steps/{step}/skip` | Explicit owner skip of an interrupted, failed or rejected step of a paused mission (409 `busy` otherwise: stopped, budget and completed are terminal) |

Each step has `{id, title, role, instruction, after: earlierStepIds[]}`. IDs are unique, roles must already exist, one to eight steps, instructions up to 2000 characters. Goals are at most 2000 characters. Mission state lives under private `<state>/resident-missions/`; edits use per-mission flock and atomic writes. A worker leader processes every two seconds, launching at most two resident sessions installation-wide. `max_minutes` (stored as `max_seconds`) bounds working time: `spent_seconds` plus the current period, `active_since` being set only while a step or the planner is `starting` or `running`; waits between cycles and for a proposal decision do not count. `next_cycle` = epoch seconds when the next cycle may start (null otherwise). Automatic processing can be disabled with `MAXXING_MISSIONS_WORKER=0` for isolated tests.

Phases: draft, planning, plan_review, active, paused, completed, stopped, budget. Step states include pending, starting, running, review, complete, failed, rejected, interrupted and explicitly skipped. Planning is a counted companion launch. A mission whose `origin_state` is not the current state directory (restored or moved state) is paused with reason `restored` only when it was `active` or `planning`; other phases keep theirs. Run keys persist before process creation and reconcile tagged sessions after interruption. A reservation that never reached a model (stopped by the guard before the first message, or with no session carrying its key after 180 seconds) is released: `launches[].aborted = true` (not counted against `max_runs`), the step goes back to `pending` and a released planner is requested again. `start` resets `interrupted` steps without a session to `pending` and refuses with 409 `unresolved` while a step is `failed`, `rejected` or `interrupted`; `plan` is also accepted from `paused` when no step has a session. `companions.run` accepts internal purpose, launch key, timeout and guarded message launch; normal manual runs retain their behavior.

Plans from agents are parsed from their full bounded assistant text, never the 200-character list preview. No automatic role adoption, PR publication or code application occurs. Reports, not patches, pass between dependent steps. New-source checks prevent repeated approved patches across cycles. Feed kinds `mission.review` and `mission.completed` use normal notification preferences. The user guide documents soft token limits, deadline latency, trusted-process boundaries and current limits.

## Agent provider catalog

`GET /api/agent-providers` (authenticated) returns `{id, name, builtin, capabilities, protocol?}[]`.
`POST /api/sessions` accepts an installed `plugin:<extension-id>` provider as well as the native
providers. Session responses retain `provider_name` for external engines. Read-only `plan` and
attachment capabilities are checked at creation. Profile `POST/PUT /api/companions` accepts an
optional `provider`; omitting it preserves the previous choice, defaulting to Codex for new roles.
A coding companion needs `source-edit`. See [AGENT-PROVIDERS.md](AGENT-PROVIDERS.md) for the external
executable protocol and trust model. Provider token totals use dynamic keys in `Stats.providers`.

## Complete instance backup

Authenticated endpoints under `/api/backup/instance` are independent of selective GitHub backups.
All writes require the usual `X-Maxxing: 1` CSRF header. No passphrase is persisted.

| Method/path | Request | Result |
| --- | --- | --- |
| GET base | — | Data roots, size limit, `restore_hold`, `integrations_paused`, export availability |
| POST `/export` | `{passphrase}` (12–1024 characters) | Encrypted archive id, SHA-256 and counts; idle sessions required |
| GET `/exports` | — | Encrypted exports kept on the server, newest first: `[{id, created, archive_bytes, sha256, version, files, bytes}]` |
| DELETE `/exports/{id}` | — | `{ok, id}`: removes the export and its metadata · `404 not_found` for an unknown id, anything but 32 lowercase hex characters, or a symbolic link |
| GET `/download/{id}` | — | Authenticated `.pilotbackup` attachment, `Cache-Control: no-store` |
| POST `/preview` | Multipart `file`, `passphrase` | Verified inventory, staged id and SHA-256, omitted external links |
| POST `/restore` | `{id, sha256}` from preview | Separate destination, state path and quoted launch command; `integrations_paused: true` |
| POST `/activate` | `{}` | Start deferred background services and exit recovered read-only mode |
| POST `/resume-integrations` | `{}` | `{ok, scheduled_jobs, telegram}`: resume Telegram, scheduled jobs and the GitHub memory backup of an activated copy · `409 restore_hold` before activation |

A full snapshot pauses pausable services and rejects concurrent HTTP mutations/WebSocket activity.
Changed sources or active/queued sessions abort export. Restored instances defer service startup,
allow authentication and reads, and reject mutations until explicit activation. A verified preview (decrypted, under the
private state folder) expires after 1 hour (`PREVIEW_TTL`): the module's startup hook purges expired previews
and interrupted export staging at startup and then again as soon as the next preview expires (at least every
10 minutes), and `GET` base and every operation purge them too; `/restore` of an expired preview is `409 changed`. A restored copy's
config also carries `integrations_paused: true`, which survives activation: the Telegram poller does not start
and automatic Telegram notifications are dropped, the managed crontab block stays empty, the local scheduler
and scheduled `pilot cron run` invocations skip, and `POST /api/backup/run` returns `409 paused`, so two live
copies never share one bot, run a job twice or push to the same repository. Manual "Run now", Telegram
sign-in challenges and the explicit Telegram test still work. `/resume-integrations` clears the flag, rewrites
the crontab block and starts the Telegram poller; resident missions keep their own moved-state pause
(`reason: restored`) and are never restarted by it. Preview hashes are
rechecked; traversal, duplicate/conflicting paths and incomplete inventories are rejected. Data format
and recovery limits are documented in [the backup guide](../user/10-backup.md).

`.pilotbackup` file: a 43-byte header, then the AES-256-GCM ciphertext of the ZIP, then the 16-byte GCM tag.
Header (big-endian): magic `PILOTBK\n` (8 bytes), format version `u8` = 2, KDF identifier `u8` (1 = scrypt),
`log2(N)` `u8`, `r` `u16`, `p` `u16`, salt (16 bytes), nonce (12 bytes). The whole header is the GCM associated
data. New archives use scrypt N = 2^15, r = 8, p = 1. Decryption takes the cost from the header and refuses, with
`400 kdf_params` and before any derivation, `log2(N)` outside 14–20, `r` outside 1–16, `p` outside 1–4,
128·N·r above 128 MiB or N·r·p above 2^21. Another magic, version or KDF gives `400 format`. A changed header
field gives `400 decrypt_failed`. The key is derived from the Unicode NFC form of the passphrase, on export and on
import. Development archives written before format version 2 are not readable.

## Pull request integration queue

All routes require owner authentication. Work runs off the event loop.

| Method | Path | Meaning |
| --- | --- | --- |
| GET | `/api/pr-queue` | `{paused, github_cli_available, items}`; local state only |
| POST | `/api/pr-queue` | Add `{url, dependencies?: id[], method?: "merge" or "squash"}`; returns entry, no approval |
| PUT | `/api/pr-queue/pause` | Set `{paused: bool}`; never recalls an already initiated request |
| POST | `/api/pr-queue/refresh` | Read up to three oldest pending entries; never initiates a merge |
| GET | `/api/pr-queue/{id}/preview` | `{item, snapshot, patch, fingerprint, dependencies}` |
| POST | `/api/pr-queue/{id}/approve` | `{fingerprint}`; refetches and verifies the reviewed diff, prerequisite heads and target commit |
| POST | `/api/pr-queue/{id}/cancel` | Remove an entry unless a merge was initiated |
| POST | `/api/pr-queue/{id}/retry` | Explicit retry of a failed approved request; worker rechecks before writing |

The default is paused. Approvals and current queue state live in private `<state>/pr-queue/queue.json`; `queue.lock` serializes edits and `worker.lock` elects a single worker across processes. Up to 100 entries, 20 immutable older prerequisites per entry. Responses from GitHub are capped at 2 MiB and each CLI call times out after 20 seconds. The worker checks at most three due entries per pass, with oldest checks first; normal minimum interval is 30 seconds per entry. `MAXXING_PR_QUEUE_WORKER=0` disables automatic processing for isolated tests. Startup/shutdown hooks cooperate with lifecycle suspension.

A merge request pins the approved head SHA and selected merge method; GitHub repository rules remain authoritative. Approval binds the base commit too, but GitHub's merge endpoint has no atomic base-SHA condition: enforce required checks/reviews remotely. The host does not use force, rebase, admin bypass or branch-update APIs. Large/incomplete checks/reviews block integration. In-flight/uncertain writes are reconciled by reading GitHub, not automatically resent. Feed kinds: `pr_queue.review`, `pr_queue.merged`.
