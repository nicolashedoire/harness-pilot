---
section: Getting started
---
# Onboarding

The first visit happens through a **one-time setup link**. For the local installation, obtain it by running `bash scripts/dev-local.sh link` from the repository root. Whoever has the link can claim the instance, so keep it private.

The setup link first asks for the UI password (12 characters minimum, stored hashed with scrypt).
Then the wizard has nine steps. You can leave and come back: it resumes where you stopped, and
every step also exists in Settings.

1. **Language & time zone** – English or French, and the time zone used by scheduled jobs.
2. **About you** (optional) – choose a local nickname for your profile. No license key is required. See [License](license).
3. **Claude connection** – the wizard detects whether Claude Code is signed in. Otherwise:
   - run `claude setup-token` on any machine with a browser and paste the long-lived token, or
   - paste an Anthropic API key (pay-as-you-go).
   A real one-line test call confirms it works.
   Claude can be skipped if you want to use Codex alone.
4. **Codex** (optional) – the wizard detects whether the Codex command is installed where harness-pilot runs and
   signed in. If it is not installed, install it there (for example `npm install -g @openai/codex`), then
   **Check again**. To sign it in, without a terminal:
   - **ChatGPT account**: **Get a sign-in code** shows a page of OpenAI and a one-time code (valid 15 minutes).
     Open the page on any device, sign in to ChatGPT, enter the code: the wizard notices it by itself. Enter the code
     only on that page, and only for a sign-in you started.
   - **API key**: paste an OpenAI API key. It goes straight to Codex, which keeps it in its own folder;
     harness-pilot keeps no copy and never shows it again. Codex checks it on the first message.
   `codex login` in a terminal where harness-pilot runs still works. Or skip the step. The same is in
   **Settings → Codex**.
5. **Import** (optional) – coming from another agent (Hermes, Claude Code, OpenClaw…)? Copy the
   prompt into it, drop the zip it makes: your projects, topics, memory and skills arrive, and
   Claude finishes the job (tasks, scheduled jobs, keys to add). See [Import](import).
6. **First project & topic** – a starter project `general` with a topic `inbox` already exists;
   create your own (for example `acme` / `blog`).
7. **Telegram** (optional) – connect a bot to talk to your sessions from the phone. See
   [Telegram](telegram).
8. **Memory backup** (optional, recommended) – configure a private GitHub repository for your memory. Local scheduled backups run only while the application is running. Verify the backup yourself after configuring it; see [Backup](backup).
9. **Ready** – a short tour of the interface.

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

Use the commands in [Local installation](installation) to start the application and obtain its setup link. On a Linux server, the installer prints the setup link at the end.
