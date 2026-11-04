---
section: Using harness-pilot
---
# Scheduled jobs (Crons)

The **Crons** page runs things on a schedule: a **shell command** or a **Claude Code prompt** in a
topic. Each run is recorded (status, duration, output) and can be reported on Telegram.

In the local macOS installation, a small scheduler runs while the application is running. It checks the current minute in the configured time zone without changing your system crontab. Jobs missed while the computer sleeps or the app is stopped are not replayed; a job set to `@reboot` (**At startup** in the schedule list) runs each time the application starts. Scheduled prompts currently use Claude Code.

## Creating a job

Click **New job** and fill in:

| Field | Meaning |
|---|---|
| Name | short label |
| Schedule | cron expression; the editor shows it in words and lists the next runs |
| Type | **Shell** (a command run with bash) or **Claude** (a prompt sent to a session in a topic) |
| Command | shell: e.g. `projects/acme/scripts/report.sh`, relative to the workspace |
| Topic, prompt, model | Claude: where the session runs, what to do, which model |
| Reuse session | Claude: keep one session across runs (it accumulates context) instead of a new session each time |
| Notify | Telegram report: never, on failure (default), always |
| Timeout | maximum duration (default 1 hour) |

**Run now** starts a job immediately. The history shows the last runs with their output tail; for
Claude jobs, a link opens the session.

## Schedule syntax

Five fields: `minute hour day-of-month month day-of-week`.

| Expression | Runs |
|---|---|
| `0 7 * * *` | every day at 07:00 |
| `*/15 * * * *` | every 15 minutes |
| `30 8 * * 1-5` | weekdays at 08:30 |
| `0 9 1 * *` | the 1st of each month at 09:00 |
| `0 */6 * * *` | every 6 hours |
| `@daily`, `@hourly`, `@weekly`, `@monthly` | shortcuts |
| `@reboot` | **At startup**: each time the application starts (local mode), or when the server boots (legacy server) |

An `@reboot` job has no next run: the list shows *At the next start*. Disable it to keep it from running at the
next start; **Run now** still starts it by hand.

### Time zone

In local mode, the scheduler checks jobs in the time zone configured in Settings, without changing the system clock. The page shows schedules, next runs and history in that zone, in your language and its time format (*Every day at 4:40 AM* in English, *Tous les jours à 04:40* in French). On the night clocks go back, a job set in the repeated hour runs in both passes. The remainder of this section describes the inherited Linux server setup, which is not validated for this repository.

On the legacy server, the cron daemon fires jobs in the **server's system time zone**, while the UI (schedule preview,
next runs, history) uses the time zone of Settings -> General. Both must be the same, otherwise a
job shown "at 07:00" runs at another hour. On a fresh server, the zone you pick in the onboarding
(or Settings -> General) also becomes the system zone; `pilot doctor` warns if they differ.

On a server already in use (other scheduled jobs, other services), the installer **keeps the server
clock** (`system_clock = keep` in the configuration): harness-pilot then writes each job's crontab
line to fire every hour at its minutes, and `maxxing cron run <id> --if-due` (`maxxing` = `pilot`) checks the schedule in
your zone before running - so jobs still run at the times you see, daylight saving included, and
the other programs keep their clock. Switch with `pilot init --system-clock keep|follow`.

To change the system zone by hand (mode `follow`):

```bash
timedatectl set-timezone Europe/Paris && systemctl restart cron
pilot init --timezone Europe/Paris && systemctl restart claude-maxxing
```

## Built-in jobs

- **Memory compaction** – daily 05:00, Claude job using the `memory-compaction` skill (created at
  installation, turned on when you finish the onboarding with Claude signed in - so it never fails before
  Claude is connected; if you skipped that step, enable it on the Crons page; you can edit, disable or delete it).
- **Memory backup** – created when you configure the [Backup](backup) (default 04:40).
- **Check for updates** – Mondays 09:00, shell job `pilot update --check --notify`: when a new
  version exists, a Telegram message tells you to open the topic `system/harness` (`system/update` on servers installed before 2.0.0a33) and say "update".
  It never updates by itself. On a server with neither a git remote nor a license (a local copy) it is created
  disabled (nothing to check); `pilot update --check` then says "updates unavailable (no git remote)".
- **Morning tasks** (disabled) – daily 08:00, Claude job in `general/inbox` (`system/tasks` before 2.0.0a33):
  overdue and today's tasks, sent on Telegram. Enable it on the Crons page.
- **Renewal reminder** – created when you ask for subscription reminders (Mondays 09:30, in the topic that keeps
  `accounts.md`); servers installed before 2.0.0a33 have it disabled in `system/accounts`.
- [Starter projects](starter-projects) add their own jobs, created disabled.

Built-in jobs are created once, at installation (or by the update that introduced them); a job
you delete is never re-created. With notify "always", the report includes the job's output (the
answer of a Claude job), so a reminder arrives as a readable message.

## How it works

In local mode, an in-process scheduler starts jobs while the app is open; it does not modify the system crontab. The following description applies to the inherited Linux server implementation.

Each enabled job becomes one line in root's crontab, inside a block that harness-pilot manages:

```
# >>> claude-maxxing (managed) >>>
0 5 * * * MAXXING_CRON_DETACH=1 /usr/local/bin/maxxing cron run c_3fa91c >/dev/null 2>&1
# <<< claude-maxxing <<<
```

Lines outside the block are yours and never touched; they are listed read-only as "external" jobs. If the
closing line of the block gets deleted by hand, only the `maxxing cron run` lines (`maxxing` = the earlier name of
`pilot`, the same command: these lines never change) are treated as managed: your own lines after it are kept.
From a terminal: `pilot cron list`, `pilot cron run <id>` (runs it in your terminal and waits),
`pilot cron sync` (rewrites the block), `pilot cron deleted` (the removed jobs kept) and
`pilot cron restore <id>` (puts one back). Two runs of the same job never overlap.

### Memory and time limits

A scheduled run starts exactly like **Run now**: in its own systemd unit (`maxxing-cron-<id>`, see
`journalctl -u maxxing-cron-<id>`), so a greedy job cannot take the whole server down at night:

- each job may use at most `unit_memory_max` of the RAM (default 75 %, the same cap as a session);
- all the jobs running at the same time share one budget, `jobs_memory_max` (default 75 % of the RAM, the
  `maxxing-jobs.slice` unit). To change it, set `jobs_memory_max` in `/var/lib/claude-maxxing/config.json`
  (`"3G"`, `"50%"`, or `""` for none), then run `pilot init`;
- past its timeout, a shell job gets a stop signal, then 5 seconds later everything it started is killed, even a
  program that ignores the stop signal.

When the job ends, the programs it left running in the background end with it. To start a program that must
keep running (a server, a bot), make it a systemd service instead of a cron job (ask Claude). Installations made
before 2.0.0-alpha.70 keep the old behavior: their scheduled jobs run in the cron process as before, so the programs
they leave in the background keep running, without the memory caps above (`"cron_keep_background": true` in
`config.json`; set it to `false` to get the job units). Same for the protections of sessions and jobs
(`"unit_hardening": false` there; `true` turns them on).

On a server without systemd (some containers), the job runs inside the cron process: the timeout still applies,
the memory limits do not.

Secrets flagged "expose" in Settings -> Keys are available as environment variables to shell jobs
and Claude sessions.

A shell job runs with the same Claude setup as your sessions (harness-pilot' Claude Code folder and the Claude
account connected in harness-pilot), so a script can call `claude -p "..."` itself - for example a script that
prepares data, asks Claude for a text, then publishes it.

## Tips for Claude jobs

Write the prompt as a complete instruction: what to produce, where to write it, which skill to use.
The job has no previous conversation unless "Reuse session" is on.
