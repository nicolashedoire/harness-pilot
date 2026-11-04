---
section: Getting started
---
# Onboarding

The first visit happens through a **one-time setup link**. For the local installation, obtain it by running `bash scripts/dev-local.sh link` from the repository root. Whoever has the link can claim the instance, so keep it private.

The setup link first asks for the UI password (12 characters minimum, stored hashed with scrypt).
Then the wizard has eight steps. You can leave and come back: it resumes where you stopped, and
every step also exists in Settings.

1. **Language & time zone** – English or French, and the time zone used by scheduled jobs.
2. **About you** (optional) – choose a local nickname for your profile. No license key is required. See [License](license).
3. **Claude connection** – the wizard detects whether Claude Code is signed in. Otherwise:
   - run `claude setup-token` on any machine with a browser and paste the long-lived token, or
   - paste an Anthropic API key (pay-as-you-go).
   A real one-line test call confirms it works.
   Claude can be skipped if you want to use Codex alone. Install and sign in to the Codex CLI separately; check its status in **Settings → Codex**.
4. **Import** (optional) – coming from another agent (Hermes, Claude Code, OpenClaw…)? Copy the
   prompt into it, drop the zip it makes: your projects, topics, memory and skills arrive, and
   Claude finishes the job (tasks, scheduled jobs, keys to add). See [Import](import).
5. **First project & topic** – a starter project `general` with a topic `inbox` already exists;
   create your own (for example `acme` / `blog`).
6. **Telegram** (optional) – connect a bot to talk to your sessions from the phone. See
   [Telegram](telegram).
7. **Memory backup** (optional, recommended) – configure a private GitHub repository for your memory. Local scheduled backups run only while the application is running. Verify the backup yourself after configuring it; see [Backup](backup).
8. **Ready** – a short tour of the interface.

## After the wizard: the tutorial

The workspace comes with the topic `system/tutorial`: four lessons of about 5 minutes (sessions and files,
memory, tasks and scheduled jobs, Telegram and voice) in one topic. Start a session there and say "hi": Claude
guides you one exercise at a time, checks your result and remembers where you stopped. When you are done, it
offers to delete the topic (it goes to the Trash); updates never re-create it. Servers installed before 2.0.0a33
have the former `tutorial` project, one topic per lesson.

The onboarding step **Your projects** also offers the [starter projects](starter-projects) (install all, choose,
or none).

For questions later, use the topic `system/help` (see [The system project](system-project)).

## Local setup

Use the commands in [Local installation](installation) to start the application and obtain its setup link. The inherited Linux server setup has not yet been validated for this repository.
