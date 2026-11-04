---
section: Reference
---
# Troubleshooting


## The dot at the bottom of the sidebar

It turns orange or red when something needs you (disk, memory, a failed scheduled job, a stopped service, Claude
not connected, an old backup). Click it for the list. **Seen** on an issue stops it from counting in the dot (it
stays in the list, greyed): it comes back by itself when it changes - another job failing, for example - or after
24 hours if it is still there. The arrow next to a seen issue counts it again. Seen marks are kept on the server,
so they hold on every device.

## Local setup on macOS

The local setup (`bash scripts/dev-local.sh`, see [Local installation](installation)) has no systemd or
`journalctl`: it runs in your terminal, or as an optional launchd background service. The rest of this page, from
**Start with the doctor** on, describes a Linux server installation. On a Mac, use the commands below instead.

**Check it.** From the repository root, `bash scripts/dev-local.sh cli doctor` runs the doctor with the settings
of your local app (a plain `uv run pilot doctor` looks at the folders of a server installation instead).
On macOS, the doctor recognizes Claude's Keychain sign-in and reads listening addresses with `lsof`. A failed
port inspection is a warning, not proof that nothing is listening. It describes the launchd configuration
without claiming that an agent is stopped simply because the command runs in another terminal; use the printed
`service status` command to inspect it. Linux firewall and service checks are marked as inapplicable.
Local tool paths may belong to your account or root, but foreign ownership or writable code paths still fail
verification. Linux package versions and package contents are not verified for these user-managed tools.

Add `--live` for a small real Claude request, using the same isolated test as **Settings → Claude → Test**.
A timeout, context or quota error is reported as a failed request, not an expired sign-in. Real authentication
errors still fail. Missing optional tools and a publicly exposed listener remain diagnostic issues.

**Where the logs are.**

| What | Where |
|---|---|
| The server | the terminal that runs `bash scripts/dev-local.sh` (nothing is written to a file; to keep a copy: `bash scripts/dev-local.sh 2>&1 \| tee -a .harness-pilot-local/server.log`) |
| Agent turns (their processes' own errors) | `.harness-pilot-local/state/logs/runner.log` |
| One conversation | `.harness-pilot-local/state/sessions/<id>.log`; the session page shows the same events |
| Scheduled jobs | **Crons** (last result and output) or `bash scripts/dev-local.sh cli cron list` |
| The background service ([`service install`](installation)) | `.harness-pilot-local/logs/server.log` and `server.err.log`; `bash scripts/dev-local.sh service status` prints their full paths |

**Restart it.** Press `Ctrl+C` in its terminal, then run `bash scripts/dev-local.sh` again from the repository
root. After a `git pull`, restart the same way: the script installs the new dependencies before it starts.
`pilot update` and the Update button do not work in the local setup. When it runs as the background service:
`bash scripts/dev-local.sh service restart`.

**When the terminal is closed, the server stops,** and scheduled jobs, backups, resident missions and Telegram stop
with it. While the Mac sleeps, it is paused. A job whose minute passed while the server was stopped or paused does
not run late: the local scheduler only looks at the current minute. To keep it running without a terminal, install
the [background service](installation).

**"Address already in use" at start.** The local app listens on `127.0.0.1:8787`, and something else already
holds that port, usually the app running in another terminal or as the background service (`bash
scripts/dev-local.sh service status`). The start says which process holds it, and so does
`lsof -nP -iTCP:8787 -sTCP:LISTEN`. Stop it with `Ctrl+C` in its terminal, with `service uninstall`, or with
`kill <PID>`; `HARNESS_PILOT_PORT=8790` picks another port. The address is only reachable from this computer.

**"Operation not permitted" on a folder.** macOS asks before a program reads Desktop, Documents, Downloads,
iCloud Drive or an external disk. The server and the agents run with the permissions of your terminal app
(Terminal, iTerm...). Allow it in **System Settings → Privacy & Security → Files and Folders** (or **Full Disk
Access**), then restart the local app. `.harness-pilot-local/` holds your state and secrets: keep it private
(`chmod 700`). The microphone (voice messages) and notifications are allowed in your browser, and for
notifications also in **System Settings → Notifications** for that browser.

**Thumbnails, previews or PDF pages do not show.** Files, conversations and the file viewer make images and video
thumbnails with `ffmpeg` and PDF thumbnails with `pdftoppm`, and the local setup does not install them:

| Tool | Used for | Install |
|---|---|---|
| `ffmpeg` with WebP | thumbnails and previews of images and videos, lighter copies of videos, voice messages | `brew install ffmpeg-full` |
| `pdftoppm` | the first page of a PDF as its thumbnail | `brew install poppler` |

Homebrew's plain `ffmpeg` has no WebP encoder, so thumbnails still fail with it. `ffmpeg-full` has one, and
Homebrew does not put it on the PATH, but `scripts/dev-local.sh` uses it first as soon as it is installed: restart
the local app after `brew install ffmpeg-full`. While a tool is missing, Settings → System shows a **Thumbnails and
previews** card with the command to run, `bash scripts/dev-local.sh cli doctor` warns (`media_tools`), and the
server says so in its terminal at start. Nothing is installed for you. To check a `ffmpeg` by hand:
`ffmpeg -hide_banner -encoders | grep libwebp` must print a line.

**What Settings → System shows locally.** The version card shows the version and commit of your clone, and
**Check** compares the clone with its git remote. **What's new** is available too. A note says that service
controls and automatic updates are unavailable, and there is no Update button: update with `git pull`. The health
card shows the memory, disk and CPU gauges (on macOS the CPU gauge says it is unavailable) and the same problems
as the dot at the bottom of the sidebar, along with the Claude connection, the last backup, failed sign-ins and
the load. The **Services** and **Logs** cards of a server do not appear, because they read systemd and its
journal.

## Start with the doctor

```bash
pilot doctor            # human readable, exit code 1 if something fails
pilot doctor --json     # for scripts and Claude
pilot doctor --live     # also makes a real one-line Claude call
```

Or open a session and say "something is wrong, use the pilot-doctor skill": Claude reads the
checks and the logs, explains, and fixes what is safe to fix.

| Check | Meaning |
|---|---|
| python, uv | runtime and toolchain |
| cli | the `pilot` your terminal and the sessions run is this product. Some systems ship another program called `pilot`: the doctor then names it, and `maxxing` (the same command under its earlier name) works instead, for example `maxxing doctor` |
| claude_cli, claude_auth | Claude Code installed and signed in |
| claude_version | Claude Code behind its latest release (info; releases carry security fixes). With Settings -> Claude -> Update Claude Code automatically (off by default) the server installs the stable release by itself when nothing has run for 10 min; the hint says why it did not - fix: `claude update` |
| skill_listing | how many skills Claude sees in every prompt and their size; past Claude Code's budget the least used ones lose their description (info) - see [Skills](skills) |
| deps | with `--deps`: installed packages (server, web, video tools) with a known vulnerability, from osv.dev |
| setup | first sign-in done |
| service, http | `claude-maxxing` running and answering |
| security | firewall (ufw), fail2ban and automatic security updates active - warning only; fix: `bash /opt/claude-maxxing/install.sh --secure` |
| state_files | a damaged `config.json` / `secrets.json` was found and replaced; its copy (`*.damaged-<date>`) is kept next to it - compare, restore what is missing (keys: Settings -> Keys), delete the copy |
| tools | Node.js, Remotion, Scrapling and the shared Chromium ready (videos, PDFs, scraping) - warning only; fix: `pilot deps update` |
| media_tools | `ffmpeg` with its WebP encoder and `pdftoppm` found: thumbnails and previews of images, videos and PDFs - warning only; the fix names the install command (`brew install ffmpeg-full`, `brew install poppler` on a Mac) |
| deps_files | external components (`pilot deps list`): ✘ when a binary changed since it was installed or a file is not owned by root (another user could replace it), ! when one is missing or not at the version of this release; fix: `pilot deps update` |
| bind | not listening on a public address |
| public_url, caddy | your URL reachable, Caddy config valid |
| caddy_site | the Caddy site written by an older installer: `X-Frame-Options DENY` (PDF previews in Files stay blank) or a body limit below the 2 GB uploads - the fix command edits `/etc/caddy/claude-maxxing.caddy` and reloads Caddy |
| crontab | every enabled job present in the crontab |
| timezone | configured time zone = system time zone (cron uses the system one), or server clock kept (`system_clock = keep`) |
| telegram, backup | configured, linked, recent backup |
| disk, workspace | free space, workspace writable |
| memory | RAM and swap; a server under 4 GB without swap gets a warning (each running Claude turn uses 200-300 MB, local voice, browsers and renders more) and the commands to add a 2 GB swap file |
| skills, web | product skills and the web UI build present |
| git | local changes, updates available |

## Logs

```bash
journalctl -u claude-maxxing -n 100 --no-pager     # server
journalctl -u caddy -n 50 --no-pager               # HTTPS proxy
systemctl list-units 'maxxing-*'                   # running Claude turns
journalctl -u maxxing-<id8> --no-pager             # one turn
pilot cron list                                  # jobs and their last result
```
Logs are also visible in Settings -> System.

## Common problems

**A command was "Killed" (exit code 137), or a heavy render stopped.**
It ran out of memory. Each session and scheduled job may use at most 75 % of the server's RAM: past it the
kernel stops the biggest process of that session only, and Claude tells you and continues. The UI and the
other sessions normally keep working (the cap is per session: several heavy sessions at once can still fill the
RAM). Ask Claude for a lighter way (a lower resolution, a render in parts, fewer
inputs at once). To change the cap, set `unit_memory_max` in `/var/lib/claude-maxxing/config.json`
(`"4G"`, `"90%"`, or `""` for none): it applies to the next turns and jobs. All the scheduled jobs running at once
also share `jobs_memory_max` (default 75 %, applied by `pilot init`). `journalctl -k | grep -i oom`
shows what was killed. If the whole turn stopped, the session says "The turn was stopped: the server ran out
of memory".

**Something you started on the server (a dev site, an API on port 3000…) is not reachable.**
The firewall only lets SSH, 80/443 and Tailscale in. Open the port on purpose (`ufw allow 3000/tcp`),
or better, serve it behind Caddy on your domain.

**Installation and updates.** See [Installation](installation) for the local setup and for a Linux server (Debian 12, Ubuntu 24.04); on a server, `pilot update` follows the `main` branch of this repository. No enterprise license key is required.

**The page does not load.**
`systemctl status claude-maxxing`. If it is failing, read the journal. After a manual `git pull`,
run `pilot update` instead (it syncs the dependencies). `systemctl restart claude-maxxing` is safe:
running Claude turns continue in their own units.

**Certificate error / domain unreachable.**
The domain's DNS record must point to the server (`getent ahosts ui.example.com`), and ports 80 and
443 must be open (`ufw status`, plus your hosting provider's firewall). Caddy obtains the
certificate on the first request: `journalctl -u caddy` shows why it failed. Validate the config:
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.

**Lost password.** On the server: `pilot password`. Or start over with a new setup link:
`pilot setup-link --reset`.

**"Too many attempts".** Wait 15 minutes, or restart the service.

**Lost setup link.** `pilot setup-link`.

**Every session fails at once.** Claude is not signed in or the token expired: Settings -> Claude ->
Test, or `pilot doctor --live`. Renew with `claude setup-token`.

**A session stays "running".** Press Stop. If it persists: `systemctl list-units 'maxxing-*'` and
read that unit's journal.

**A note says the conversation could not be resumed.** The Claude transcript was missing; a fresh
context was started automatically. The history stays visible.

**A job did not run.** `pilot cron list` (enabled? last result?), `crontab -l` (is its line in the
managed block?), `pilot cron sync`, `systemctl status cron`. Run it by hand: `pilot cron run <id>`.

**A job runs at the wrong hour.** The cron daemon uses the system time zone, the UI uses the one
from Settings -> General. `pilot doctor` shows both. On a shared server, keep the server clock
and let jobs follow your zone: `pilot init --system-clock keep`. Otherwise align them:
`timedatectl set-timezone <Zone> && systemctl restart cron`, and
`pilot init --timezone <Zone> && systemctl restart claude-maxxing`.

**Telegram is silent.** `pilot telegram status` shows the last error; `pilot telegram test`.
See [Telegram](telegram).

**Backup failed.** `pilot backup status`. Expired token, repository made public, or a secret found
in a file (the message names the file). See [Backup](backup).

**Disk full.** Check `~/.claude/projects` (transcripts), attachments in topics, and the journal
(`journalctl --vacuum-size=200M`). Delete with care: transcripts are needed to resume sessions.

**The UI looks outdated after an update.** An open page loads the new version by itself once the
server is back (if you are typing, as soon as you leave the field). Otherwise reload the page; the
app's HTML is never cached, a reload is enough.

**Tailscale URL stops working after a reboot.** If the Tailscale IP changed, re-run the installer
with `ACCESS=tailscale` (or `pilot init --bind <ip> --public-url http://<ip>:8787` and restart).

## Still stuck?

Collect `pilot doctor --json` and the last 200 lines of `journalctl -u claude-maxxing` (check that
they contain no secrets) and contact support.
