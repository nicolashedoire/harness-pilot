---
section: Reference
---
# Command line reference

This reference describes the server commands. On a Linux server installed with `install.sh` (see [Installation](installation)), `pilot` is in `/usr/local/bin` and is run as root (`sudo pilot doctor`). In the local setup, use the repository's `scripts/dev-local.sh`; the command is run from the project's Python environment rather than assumed to exist in `/usr/local/bin`. See [Local installation](installation).

The command is `pilot`. `maxxing` is the same command under its earlier name and keeps working everywhere (scripts, scheduled jobs, habits): both names run the same program with the same settings. In the local setup, run it from the repository root as `bash scripts/dev-local.sh cli ...`, for example `bash scripts/dev-local.sh cli doctor`: the command then uses the settings of your local app (its state, workspace and scheduled jobs under `.harness-pilot-local/`). A plain `uv run pilot ...` does not: it reads the folder of a server installation (`/var/lib/claude-maxxing`) instead. On a server installation, the installer and every `pilot init` link `/usr/local/bin/pilot` to `/usr/local/bin/maxxing` (an existing `pilot` command of another program is never replaced: use `maxxing` there). `pilot doctor` warns when another program called `pilot` comes first on the PATH.

## Server and setup

| Command | Purpose |
|---|---|
| `pilot serve [--host IP] [--port N]` | run the web server (used by the `claude-maxxing` service) |
| `pilot setup-link [--reset]` | print the one-time setup link; `--reset` forgets the password and starts the setup again |
| `pilot password` | set a new UI password (interactive) |
| `pilot 2fa status\|off\|forget-browsers` | two-step sign-in (Telegram and authenticator app): state, turn both off (the way back in when Telegram does not answer or the phone is lost), make every browser ask again |
| `pilot status [--json]` | version, URL, service, Claude auth, Telegram, backup, paths |
| `pilot doctor [--json] [--live] [--offline] [--deps]` | check the installation; `--live` makes a real Claude call, `--offline` skips the update checks (GitHub, Claude Code release), `--deps` also looks up known vulnerabilities of the installed packages (osv.dev) |
| `pilot harden [--undo] [--no-restart]` | apply (or remove) the systemd sandbox of the service, then restart it; restores the previous settings if the service does not come back (see [Security](security)) |

`doctor --live` uses the same small, tool-free request as **Settings → Claude → Test**, without loading project
instructions, skills, hooks or MCP servers or saving a conversation. An ordinary request failure does not mark
the sign-in as expired. For macOS listener, launchd and local tool checks, see [Troubleshooting](troubleshooting#local-setup-on-macos).

## pilot init

Creates or refreshes the configuration, workspace, skills and default jobs. Safe to run again:
existing values and files are kept unless you pass a flag.
Workspace templates (default projects `general`, `system`, `tutorial`) are copied only when
missing, and a default project or topic you deleted is never re-created. Default jobs are created
once each (Memory compaction, Check for updates, Morning tasks and Renewal reminder disabled).
Skills renamed by a version (the product skills were called `maxxing-…` before `pilot-…`) are installed under their new name and the old copies removed; the old names are also replaced in the lines of your workspace files that are still the product's own text and in the prompts of default jobs you never edited - text you wrote is never changed (see [Skills](skills)).

The product's own instructions kept from earlier versions (the lines of the workspace `CLAUDE.md` files that are still
the product's text) get the `pilot` command once: at the first init (so update) or start of the local app where
`pilot` is harness-pilot. Where another program is called `pilot`, they keep `maxxing`, the same command. Lines you
wrote or edit, also later, and existing conversation history are kept. The `maxxing` alias still works for existing
scripts.

| Option | Effect |
|---|---|
| `--workspace PATH` | workspace folder (default `/root/maxxing`) |
| `--files-root PATH` | root of the Files page (default: home folder) |
| `--port N` | HTTP port (default 8787) |
| `--bind IP` | `127.0.0.1` or the Tailscale IP; public addresses are refused |
| `--public-url URL` | e.g. `https://ui.example.com`; `""` clears it |
| `--timezone TZ` | IANA name (default: the system zone). Keep it equal to the system zone (`timedatectl`), which cron uses - unless the server clock is kept |
| `--system-clock follow\|keep` | `follow`: changing the time zone in the UI also switches the system zone; `keep`: never touch it (shared server), jobs check their schedule in your zone |
| `--claude-dir PATH` | Claude Code folder for harness-pilot (default `~/.claude`; `""` = back to it). Another folder keeps it apart from a Claude Code already used on the server (passed to sessions as `CLAUDE_CONFIG_DIR`) |
| `--language en\|fr` | interface language |
| `--secret-from-stdin NAME` | store a secret read from stdin: `claude_oauth_token`, `anthropic_api_key`, `github_update_token` |
| `--no-crons` | do not create the default jobs |
| `--quiet`, `--json` | output control |

Example: `printf %s "$TOKEN" | pilot init --quiet --secret-from-stdin claude_oauth_token`.

Restart the service after changing the port, bind address or public URL:
`systemctl restart claude-maxxing`.

## pilot update

| Option | Effect |
|---|---|
| (none) | fetch the new version, replay your customizations on top, sync dependencies, refresh skills/templates, restart, check the service answers (else roll back), print the changelog. Exit codes: `0` done, `3` customizations conflict (nothing changed - adapt them, then `--resume`), `4` rolled back, `1` other error |
| `--resume` | finish an update after the customizations were adapted by hand (rebase completed) |
| `--rollback` | go back to the code that ran before the last update (refuses, changing nothing, while the code directory has unsaved changes) |
| `--branch B` | switch to and follow branch `B` |
| `--check` | only check: installed vs latest version and the changelog lines in between. Changes nothing; exit code 0 whether or not an update exists, 1 only when the check fails |
| `--check --notify` | also send a Telegram message (Crons thread) when an update is available; nothing happens when Telegram is not configured. Used by the weekly job "Check for updates" |
| `--check --json` | machine-readable result `{ok, current, latest, behind, available, changelog, ...}` |
| `--no-restart` | do not restart the service |
| `--preflight` | simulate the update on a throw-away copy: per customization *carries over* / *on code that changed* / *now included* / *conflicts*, plus unsaved edits, web UI edits, extensions the new version does not support, upgrade notes to apply, and a verdict (`simple` or `adapt`). Changes nothing; `--json` for machine-readable |
| `--verify` | check that every extension loads and every widget answers (a widget whose `card()` fails, or returns an `error`, is reported), and run each customization's check. Exit `0` everything works, `1` something to fix |
| `--smart` | used by the Update button: after the restart the server opens a `system/harness` session that applies the upgrade notes |

In the local setup (`scripts/dev-local.sh`), `pilot update` refuses to run (exit code `1`), as the Update button does: it would update and restart a server installation. Update your clone with git instead (`git pull` in the repository), then start `bash scripts/dev-local.sh` again. `--check`, `--preflight` and `--verify` still work, since they change nothing.

Every install fetches the new version from its git remote (a private fork or mirror: with the read token stored as
`github_update_token`). A server installed with a key before 2.0.0a87 first moves to the public git repository by
itself (see [License](license)). After an update, the command
lists the **workspace upgrade notes** of the versions installed (`<code>/docs/upgrade/<version>.md`):
instructions for Claude to adapt your workspace. The easiest path is the topic `system/harness` (`system/update` on older servers):
say "update" and Claude checks, explains, updates after your yes, then applies these notes.

**Signed updates only (optional).** Set `"update_verify_signature": true` in
`/var/lib/claude-maxxing/config.json` and `pilot update` installs a new version only if its commit, or a tag
pointing at it, carries a valid signature from a key git trusts on this server (`git verify-commit` /
`git verify-tag`: import the maintainer's GPG key with `gpg --import`, or point `gpg.ssh.allowedSignersFile` at
their SSH key). Otherwise the update stops before changing anything (exit code `1`, a warning in the
notifications feed and on Telegram) and the current version keeps running. `pilot doctor` tells whether the
latest fetched version passes the check. Off by default.

## License

This version uses the MIT license and does not require an enterprise key. Legacy license commands are inherited and are not needed: `pilot license activate` and `pilot license release` refuse without contacting anything, `pilot license remove` only forgets a stored key on this computer. See [License](license).

## pilot video, pilot pdf

| Command | Effect |
|---|---|
| `pilot video new DIR` | create a Remotion project in DIR (node_modules linked to the shared install) |
| `pilot video status` | Node.js, Remotion and the headless browser on this server (exit 1 if not ready) |
| `pilot pdf IN.html OUT.pdf` | print an HTML file or an `https://` URL to PDF (A4, backgrounds) |
| `scrapling extract get\|fetch\|stealthy-fetch URL OUT.md` | fetch a page (HTTP / browser / stealthy browser) to Markdown, text or HTML |
| `scrapling-python SCRIPT.py` | run a scraping script with Scrapling and its browser |
| `bash /opt/claude-maxxing/install.sh --tools` | (re)install Node.js, Chromium, Remotion and Scrapling (= `pilot deps update`) |

## pilot import

| Command | Effect |
|---|---|
| `pilot import --prompt [hermes\|claude-code\|openclaw\|other]` | print the prompt to give your old agent |
| `pilot import ZIP --dry-run [--json]` | show what would be imported |
| `pilot import ZIP [--json]` | import it (nothing overwritten; see [Import](import)) |

## pilot custom

Changes made to the product code, recorded so updates carry them over (see [Customizing](customizing)).

| Command | Effect |
|---|---|
| `pilot custom` / `status [--json]` | customizations, unsaved changes in the code directory, pending update |
| `pilot custom save "TITLE" --why "REASON" [--files F…] [--check "CMD"]` | commit the uncommitted changes as one customization (refused under `web/`); `--check` = a command that succeeds while it works, run after every update |
| `pilot custom check ID "CMD"` | set (or clear with `""`) the check of a customization |
| `pilot custom drop ID` | remove one customization |
| `pilot custom export` | rewrite `<workspace>/CUSTOMIZATIONS.md` and `customizations/*.patch` |
| `pilot custom restore [--from DIR]` | re-apply the saved patches (new server) |

## pilot ext check

Runs your extensions (dashboard widgets, pages, conversation block plugins: see [Dashboard widgets](dashboard-widgets),
[Page extensions](page-extensions)) the way the server runs them, and says what is broken before you open the app.
harness-pilot runs it after writing or fixing an extension.

| Command | Effect |
|---|---|
| `pilot ext check ID` | check the extension in `<workspace>/extensions/ID/` |
| `pilot ext check` | check every extension |
| `--json` | machine-readable result (below) |

What is checked:

- every extension: `manifest.json` (or `block.json`) and `api.py` are loaded as the server loads them, with the same
  10-second limit for `api.py`; the error is the one shown in Settings -> Extensions;
- a card widget: `card(ctx)` runs with the dashboard's 20-second limit and its result goes through the same cleaning
  as on the dashboard. A card that keeps no block, blocks of an unknown type (dropped) and a card whose status is
  `"error"` are warnings; an exception shows the lines of your `api.py` it went through;
- an HTML widget: the frame is served, `widget.html` is a document with content, every `<script>` is closed and
  parses (`node --check`, with the line numbers of `widget.html`), it loads no other file of the folder (only
  `widget.html` is served), `maxxing.api()` has a `handle()` in `api.py` to answer it; `localStorage` and cookies,
  which the sandboxed frame does not have, are warnings;
- a page: `page.js` is served and parses as a module (`node --check`), exports `mount`, and every module it imports
  is a file of the folder that the server serves (`.js`, `.mjs`, `.css`, `.json`, see
  [Page extensions](page-extensions)) and that parses in turn; a bare name (`lodash`) or
  another site's address is refused by the app; `eval` / `new Function` are warnings; `ctx.api()` needs `handle()`;
- a block plugin: `block.json`, its schema and its frame are served, its HTML is checked like a widget's, and a
  plugin that never calls `maxxing.onData` is a warning.

Nothing is sent over the network and nothing changes in the running server. Without Node.js the JavaScript syntax is
not checked (a warning says so). An extension that is turned off is skipped: none of its code runs.

Exit codes: `0` every extension checked works (warnings allowed), `1` at least one is broken, `2` no extension has
that id, `3` that extension is turned off (nothing was run).

`--json` prints:

```json
{"ok": false, "problems": 1, "extensions": [
  {"id": "disk-usage", "name": "Disk usage", "type": "widget", "kind": "card",
   "dir": "/root/maxxing/extensions/disk-usage", "status": "error",
   "error": "KeyError: 'total' (api.py:6 in card)",
   "steps": [{"step": "load", "status": "ok", "detail": "manifest.json is valid, api.py loads"},
             {"step": "card", "status": "error", "detail": "KeyError: 'total' (api.py:6 in card)"}],
   "trace": ["api.py:6 in card: pct = du['total']"],
   "files": ["manifest.json", "api.py"]}]}
```

`kind` is `card`, `html` (HTML widget), `page`, `block` or `agent`; `status` is `ok`, `warn`, `error` or `skipped`;
`error` is the first error (null when there is none); `files` lists the files of the folder involved. A card widget
that works also returns the `card` the dashboard would draw. `runtime_errors` lists what broke while the extension
ran since its files last changed (`[{where, message, stack, at, count}]`, newest first, the same as Settings ->
Extensions: `where` is `widget`, `page`, `card` or `api`); they do not change `status` or the exit code. Without
`--json`, the latest three are printed after the steps.

## pilot deps

The external components (`server/maxxing/deps.toml`: uv, Python, Node.js, Claude Code, Caddy, Scrapling, Chromium,
Remotion, the Whisper models, Garage). As root.

| Command | Effect |
|---|---|
| `pilot deps list [--json]` | installed and expected version of each one (exit 1 when one is missing or outdated) |
| `pilot deps verify [NAME...]` | checksums of the installed binaries, files not owned by root or writable by others |
| `pilot deps update [NAME...] [--notify]` | install the pinned versions next to the old ones, switch once they work (every `pilot update` does it) |
| `pilot deps remove NAME [--force]` | delete what the manifest lists for it (`--force` for uv, Python, Claude Code) |
| `pilot deps clean [--dry-run] [--caches]` | old versions, unused browsers, leftovers, oversized logs (weekly job); `--caches` also empties root's uv / npm / pip / npx caches, shared with the other tools of the server |
| `pilot deps check [--notify]` | known vulnerabilities (osv.dev) in the lockfiles and components (weekly job, notification) |

## pilot uninstall

| Option | Effect |
|---|---|
| (none) | remove the service, Caddy site, managed crontab block, product skills and the `/usr/local/bin/pilot` and `/usr/local/bin/maxxing` commands; keep code, state and workspace |
| `--purge` | also delete the code (`/opt/claude-maxxing`), the state (`/var/lib/claude-maxxing`) and the external components of `deps.toml` (uv, Node.js, the tools; Claude Code and Caddy when the installer installed them; its swap file); a code or state directory that is a link is kept |
| `--purge-workspace` | also delete the workspace (irreversible; kept if it is a link, a system directory or has no `CLAUDE.md` nor `projects/`) |
| `--yes` | do not ask for confirmation |

## Scheduled jobs

| Command | Purpose |
|---|---|
| `pilot cron list` | jobs, schedules, last results |
| `pilot cron run <id>` | run a job now in your terminal and wait for it; `--detach` starts it in its own systemd unit with the memory limits and returns (what the crontab calls); `--if-due` runs it only if its schedule matches now in your zone (server clock kept) |
| `pilot cron sync` | rewrite the managed crontab block from the job list |

## Notifications feed

| Command | Purpose |
|---|---|
| `pilot feed post "Title" [--body] [--level info\|success\|warning\|error] [--source NAME] [--url] [--dedupe KEY] [--group KEY] [--quiet] [--json]` | add an event (notifications, and push / Telegram per your settings); `--dedupe` ignores a repeat, `--group` folds repeats, `--quiet` keeps it in the notifications only (no push, no Telegram) |
| `pilot feed list [--unread] [--source] [--limit] [--json]` | latest events |
| `pilot feed read-all` | mark everything read |
| `pilot packs list [--json]` | starter projects and whether they are installed |
| `pilot packs add ID [ID...] [--json]` | add starter projects (never overwrites: only missing files are added; jobs created disabled) |

## Keys

| Command | Purpose |
|---|---|
| `pilot keys list [--json]` | names, notes and whether each key is exposed (never the values) |
| `pilot keys get NAME` | print a value (exit code 1 when missing) |
| `printf %s "$VALUE" \| pilot keys set NAME [--note TEXT] [--no-expose]` | create or update a key; the value comes from stdin, never from the command line. A new key is exposed (environment variable of every session and shell job) unless `--no-expose`; an update keeps its note and exposure |
| `pilot keys delete NAME` | remove a key |
| `pilot infra status` / `infra list [--kind K] [--json]` | the Infra inventory: sources, problems, every site / database / bucket / domain / server (last snapshot) |
| `pilot infra refresh` | read everything now (this server, other servers over SSH, Cloudflare, Hostinger, URL checks) |
| `pilot infra site add NAME (--dir D \| --port N) [--host H] [--dns] [--project P]` | put a site online: `https://<harness-pilot address>/<NAME>/` (sandboxed) or its own host; `site remove`, `site list`, `reserved` |
| `pilot infra db install` / `db create NAME` / `db sqlite PATH` / `db backup` | PostgreSQL on localhost, one database + user per app (URL in the vault as `DB_<NAME>_URL`), nightly backups |
| `pilot infra bucket install` / `bucket create NAME [--public]` | S3 buckets on this server (Garage), keys in the vault as `S3_<NAME>_*` |
| `pilot infra server add NAME HOST [--user U] [--key K]` | read another server over SSH (`server remove`, `server list`) |
| `pilot infra annotate ID [--project P] [--note T] [--hide\|--show]` | attach a resource to a project, note it, hide it |

Scripts read keys from the environment (`os.environ["NAME"]`, `$NAME`); a script that renews a token
(a 24-hour shop token, a webhook secret it just created) writes it back with `pilot keys set`.

## MCP servers

| Command | Purpose |
|---|---|
| `pilot mcp list [--json] [--no-check]` | every MCP server of Claude Code, where it applies and its state (asks Claude Code first, a few seconds) |
| `pilot mcp add NAME URL [--where projects/P/topics/T] [--header 'Name: value'] [--sse]` | add a server by address, for every session or one topic; secrets as `${KEY}` from the vault |
| `pilot mcp add NAME --command 'npx -y pkg' [--env KEY=VALUE] [--where …]` | add a local program |
| `pilot mcp remove NAME [--where …]` | remove it |
| `pilot mcp load NAME [--session ID]` | in a session (setting *Load MCP servers only when a session needs them*): load that server from the next turn on; harness-pilot continues the turn by itself |

OAuth sign-ins (state "To connect") are done in Settings -> MCP -> **Connect**. See [MCP servers](28-mcp.md).

## Memory and sessions

| Command | Purpose |
|---|---|
| `pilot memory [--json]` | every memory.md with its line count and the line limit (Settings -> Memory) |
| `pilot sessions compact-logs [--dry-run]` | clip the tool outputs of existing session logs and drop the bulky Claude start-up lists and progress lines (frees disk space; `--dry-run` only reports what would be saved) |
| `pilot sessions token-report [--days N] [--json]` | where the tokens of your sessions go, read from Claude Code's transcripts: context size per call, cache rewritten after an idle hour or a model switch, the tools whose outputs fill the context, and what automatic compaction at 400k / 300k / 250k / 200k would have saved on the same calls |

## Backup

| Command | Purpose |
|---|---|
| `pilot backup status [--json]` | configuration and last run |
| `pilot backup run` | back up now (exit code 2 if a secret was found) |
| `pilot backup restore [--ref COMMIT]` | restore the whitelisted files |
| `pilot backup restore --from OWNER/NAME [--token T]` | new server: configure an existing backup repository, then restore (token also from `$MAXXING_GITHUB_TOKEN`) |

## Telegram

| Command | Purpose |
|---|---|
| `pilot telegram status [--json]` | bot, chat, threads, settings, last error |
| `pilot telegram test` | send a test message |
| `pilot voice status [--json]` | voice messages: engine, model, readiness |
| `pilot voice set [--engine] [--model] [--language]` | change the voice settings |
| `pilot voice download [model]` | download a local speech model |
| `pilot voice transcribe <file>` | transcribe an audio file with the configured engine |

## Installer

`install.sh` installs, updates and removes a Linux server installation (Debian 12, Ubuntu 24.04; see [Installation](installation)). Run it as root:

| Command | Purpose |
|---|---|
| `bash install.sh` | install, or repair an existing installation (every step keeps what is already done) |
| `bash install.sh --check` | look at the server and say what the installation would do, changing nothing |
| `bash install.sh --help` | the options and the variables for an unattended install |
| `bash /opt/claude-maxxing/install.sh --update` | update (= `pilot update`) |
| `bash /opt/claude-maxxing/install.sh --uninstall [--purge] [--purge-workspace]` | remove the service and integrations; `--purge` also the code and the state, `--purge-workspace` also the workspace |
| `bash /opt/claude-maxxing/install.sh --secure` | security updates, fail2ban, firewall and SSH settings again |

The other commands above describe inherited CLI features; not all of them have been verified on a server.

## Environment variables

| Variable | Use |
|---|---|
| `MAXXING_STATE` | state directory (default `/var/lib/claude-maxxing`); set by the service and the CLI wrapper |
| `MAXXING_GITHUB_TOKEN` | token for `pilot backup restore --from` |
| `NO_COLOR` | plain output |
