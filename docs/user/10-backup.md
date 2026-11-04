---
section: Connectivity
---
# Memory backup

Your CLAUDE.md and memory.md files are the most valuable part of the installation: months of
decisions, preferences and context. The backup pushes them every day to a **private GitHub
repository**, with full history.

## What is saved

Only a **whitelist**, relative to the workspace:

- always: every `CLAUDE.md` and `memory.md`, plus `CUSTOMIZATIONS.md` and `customizations/*.patch`
  (your changes to the product code, see [Customizing](customizing));
- by default also: `**/NOTES.md`, `tasks.json`, `projects/*/topics/*/accounts.md` (the subscriptions inventory, kept in `general/inbox`), `extensions/**`, `.claude/skills/**`
  (editable in Settings -> Backup);
- plus non-secret settings (time zone, language, default model, dashboard layout...) and your
  scheduled jobs, in a `_maxxing/` folder.

Never saved, even if a pattern matches: `secrets.json`, keys, `.env` files, private keys,
credentials, logs, `attachments/`, `.git`, `node_modules` and virtual environments. Session conversations are stored outside the workspace and are not included. Other project files are included only when a configured pattern matches them. This is a selected-file memory backup, not a complete project archive.

If a selected file is larger than 5 MB or cannot be read, the backup fails rather than silently publishing an incomplete snapshot. The previous successful backup remains available. Symlinks and special files are not followed.

## Safety checks

- **Secret scanner**: before every commit, each file is scanned for real secret *formats*
  (Anthropic and OpenAI-style keys, GitHub tokens, Slack tokens, AWS keys, Telegram bot tokens,
  Shopify tokens, Stripe keys and webhook secrets, Google API keys, npm, Hugging Face and SendGrid tokens, JSON web
  tokens, private keys (PGP too), a password in an address (`postgres://user:Pa55word@host`) and a password
  written next to its label such as `password: Hunter2xyz9` or `"password": "…"` - useful in `accounts.md`; UTF-16
  files are read too). If one is found the backup **stops before pushing** and tells you
  which file and which kind of secret (never the value). Remove it from the file – keep only the
  key name, store the value in Settings -> Keys – and run again.
- The scanner detects known formats; it cannot guarantee detection of every secret. Review what you include before sending it to GitHub.
- **Private only**: the repository must be private; this is checked when you configure it and
  again before every push. If it becomes public, backups stop.
- The GitHub token is stored in `secrets.json` (mode 600) and never written in a git config file.

## Setup (Settings -> Backup)

1. On GitHub, create a **fine-grained personal access token**:
   - Repository access: only the backup repository (or all repositories if you want Claude
     the application to create it);
   - Permissions: **Contents: read and write**, **Metadata: read**; add **Administration: read and
     write** only if the repository must be created for you.
2. In Settings -> Backup enter `owner/name` and the token; tick "create the repository" if it does
   not exist yet.
3. Click **Back up now** and check the commit on GitHub.

A daily job **Memory backup** is created (default 04:40). Change the schedule and the whitelist in
Settings -> Backup.

In local mode, scheduled backups run only while the app is running; missed runs are not replayed. Check the backup history and the private repository after setup. The backup flow has automated tests with a simulated GitHub service, but has not yet been verified against a real GitHub account in this version.

## Restore

- **Settings -> Backup -> Preview and restore latest** previews the latest revision, even when the local history is empty. The restore button next to a history entry previews that revision. The preview shows counts and example paths for files to create, replace, hold aside or skip. It pins the reviewed commit; local files can still change between preview and restore. The CLI `pilot backup restore` restores the latest revision (or `--ref` selects one). Files that would be overwritten are first moved to a uniquely named folder under the application's state `trash/` directory.
- After a restore, review the result for skipped files, settings that could not be restored, and items held aside. A successful response does not mean every item was restored. The original files are in the indicated trash folder when replacements occurred.
- On a **new server** (no session started yet: the installer's restore, a move to another server) everything comes
  back as it was, jobs and extensions on. On a server **already in use**, code that runs on the server comes back
  **turned off**: scheduled jobs (shell or Claude) this server does not
  already have exactly the same, and extensions any of whose code files the restore writes (turned off before their
  files are written: their code never runs, even for a moment); Claude Code `hooks` and the other settings that run
  a command or redirect Claude (`statusLine`, `apiKeyHelper`, `env`, project MCP servers...) are
  removed from restored `.claude/settings.json` files (kept in `hooks-held.json` in the restore's trash folder); files
  the backup list of this server does not cover (a `.mcp.json`, a script...) are not written but kept aside in the
  `outside` folder of the restore's trash; local MCP servers (a command Claude Code starts at every turn) are
  not added back - they are saved in `mcp-held.json` in the restore's trash folder, add the ones you trust again in
  **Settings → MCP** (remote servers, an URL, are restored). Restored skills and customizations are listed to review
  before use. A notification lists all of it; check them, then turn them on in Crons and Extensions. Anyone able to push to the backup repository could otherwise
  get their code run here. The memory backup job itself stays on.
- One old version of one file: browse its history on GitHub and copy it back.

## Moving to a new server

The inherited new-server restore procedure has not yet been validated for this version. Do not pass your backup token to an upstream installer. Keep your existing backup and see [Installation](installation) for the currently verified local setup.

## Command line

```bash
pilot backup status [--json]
pilot backup run
pilot backup restore [--ref <commit>]
pilot backup restore --from owner/name      # token from $MAXXING_GITHUB_TOKEN or prompted
```
