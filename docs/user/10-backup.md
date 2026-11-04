---
section: Connectivity
---
# Backup and restore

Settings → Backup offers two independent workflows: a **complete encrypted instance archive**
for recovery, and a **selected-file GitHub memory backup** for versioned memory.

## Complete instance archive

The archive includes the configured application state and workspace directories, and the Files page
folder when it is a dedicated one:
settings and credentials, conversations and logs, attachments, projects, ordinary files,
and valid personal/agent/shared labels. Expand **Included data directories** to check the scope.
It does not contain the application itself or provider binaries. Temporary runtime files,
derived search indexes, state-managed tool binaries and targets of external symbolic links
are excluded. Those links are listed before restoration; reinstall their dependencies separately.

1. Finish or stop active and queued sessions and wait for scheduled tasks to finish.
2. Enter a separate backup passphrase of at least 12 characters and create the archive.
   Application mutations and background services pause briefly while the snapshot is built.
   If source files change during the snapshot, export fails without publishing an incomplete backup.
3. Download the `.pilotbackup` file and keep the passphrase separately. The application does not
   save it. This workflow does not upload the archive to GitHub. Credentials are included inside
   the encrypted archive, so store it as a private recovery copy.
4. To recover, install a compatible version of the application, open Settings → Backup,
   select the archive, enter its passphrase and choose **Inspect before restoring**.
5. Review the verified inventory and external dependencies, then choose **Create the restored instance**.
   A new `pilot-restored-…` directory is created next to the current state directory. The current
   installation is never overwritten. Copy the displayed launch command into a terminal;
   choose another available port if 8790 is already used. The command gives the copy its own
   crontab file inside the new directory, so it never changes the system crontab or the current
   instance's scheduled jobs.
6. Sign in to the recovered copy with the backed-up **application password**. Review conversations,
   files and settings. The copy starts on loopback in read-only review mode with background services
   paused. **Enable this instance’s services** in Settings → Backup when ready. Reconnect external
   agent tools and review integrations/schedules before enabling them.
7. Telegram, scheduled tasks and the GitHub memory backup stay **paused** after you enable the services.
   The copy does not poll the Telegram bot or send it notifications, runs no scheduled task (**Run now**
   still works) and refuses to push the memory backup. While the original instance still runs, two live
   copies would otherwise answer the same bot, run every task twice and push to the same repository.
   Stop the original instance first, then choose **Resume integrations** in Settings → Backup.
   If two-step sign-in is on, type the code Telegram shows: its Allow button only answers once Telegram
   is resumed on this copy. Resident missions that were running are paused as well (reason: restored);
   resuming integrations does not restart them, start each one again after reviewing it.

Restoration retargets stored application data paths and preserves historical attachment links.
It resets active runtime process handles and native agent thread handles; conversation history
is retained, while the next agent turn starts a fresh provider conversation. Arbitrary shell
commands and prose are not rewritten: update absolute paths in custom commands if needed.
The restore report is stored in the new directory.

Archives use scrypt-derived keys and AES-256-GCM authenticated encryption. Each archive starts with a
versioned header that records its key-derivation settings, salt and nonce. That header is authenticated
with the data, and an archive asking for unreasonable settings is refused before any work. The passphrase
is compared in a normalised Unicode form: an accented letter gives the same key whether your keyboard or
system typed it as one character or as a letter plus an accent. The entire encrypted
stream must authenticate before its ZIP inventory is examined; file hashes and paths are checked
again before extraction. The default uncompressed data limit is 2048 MiB (`instance_backup_max_mb`);
`upload_max_mb` and available-disk reserves also apply. Large archives are streamed rather than
loaded into browser memory. The application data folder and the workspace must be dedicated folders: when either is the filesystem
root, your home folder or a folder containing it, export is refused with a message naming it. The Files
page folder is your home folder on a default installation: it is then **not included** (nothing outside
the application's own folders is read), which the folder list and a note show before you export. A
dedicated Files page folder is included. Restoring an archive without it gives the copy its restored
workspace as Files page folder; paths into the original home folder are kept as they were.

Verified previews temporarily contain decrypted data in the private state directory (mode 0700).
They expire after one hour. The server removes an expired preview as soon as its hour is up, when it
starts (if it was stopped meanwhile), when Settings → Backup is opened and before any backup operation, so
inspect an archive only when you are ready to restore it. Successful restores delete that staged plaintext
immediately, and the unencrypted staging of an interrupted export is removed the same way. Encrypted exports remain in `instance-backups/exports` until
you delete them: **Archives kept on this server** lists them, with a download button and a delete
button (after a confirmation; copies you already downloaded are not affected). Keep a downloaded recovery copy outside the machine you are backing up.
This is a file-based application snapshot, not an operating-system snapshot of unrelated services
or a guarantee against external writers deliberately bypassing filesystem modification metadata.

### Scheduled archives

Under **Scheduled archives**, choose **Every day** or **Every week**, an hour (in the time zone of Settings →
General) and how many scheduled archives to keep (1 to 30). Enter the backup passphrase twice and agree to the
stored key, then choose **Schedule archives**.

- **The passphrase is not stored.** To run without you, the server derives the archive key from it once, exactly as
  a manual export does, and keeps that key in its protected secrets file (readable only by the application, never
  given to agents, never sent to GitHub). Anyone able to read that file can open the scheduled archives, but they
  could already read the data on this server. Keep the passphrase elsewhere: it opens scheduled archives with the
  usual **Inspect before restoring**, on any installation. To change it, type a new one; archives already made keep
  the old one.
- A scheduled archive runs like a manual one: it waits until no session or scheduled task is running (it tries
  again every 30 minutes) and pauses changes while the snapshot is built. Another failure waits for the next day.
  The first one runs at the chosen hour after you enable the schedule; a run missed while the server was stopped
  runs when it starts again.
- After each scheduled archive, the scheduled archives beyond the number kept are deleted. Archives you create
  yourself are never deleted automatically. **Archives kept on this server** marks scheduled ones.
- A failure shows here and as a notification (once per series of failures; an archive blocked by activity only
  after 6 hours). The next scheduled archive resolves it.
- A restored copy does not run the schedule until you **Resume integrations**.
- **Turn off** deletes the stored key; archives already made stay.

Scheduled archives stay on this server: download one regularly, or set a copy folder (below).

### Copy to a folder

Under **Copy to a folder**, enter the full path of an existing folder: an external drive, or a folder that
iCloud Drive, Dropbox or another sync client uploads (no cloud service is built in; the client does the upload).
After every archive, manual or scheduled, the encrypted file is copied there as
`pilot-<date>-<time>-<id>.pilotbackup`, once services are running again.

- The copy is written under a temporary name, read back and compared with the archive (size and SHA-256) before it
  gets its final name. **Archives kept on this server** marks each archive **Copied** or **Copy failed**, with a
  button to copy it again (after reconnecting a drive, for example).
- The folder is never created: when a drive is unplugged, the copy fails and you are notified, instead of writing
  to the internal disk where the drive is usually mounted. A failure also shows under **Copy to a folder**; the next
  successful copy resolves the notification.
- The folder must be outside the application's data (otherwise the next archive would contain the previous ones).
- Copies are never deleted from that folder, even when older scheduled archives are deleted from this server: clean
  it up yourself. The passphrase is never copied; the archives stay encrypted.

## GitHub memory backup

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
