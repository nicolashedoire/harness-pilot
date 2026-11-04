# harness-pilot

![harness-pilot — Your AI agent crew, illustrated by a troupe of colorful AI companions](docs/assets/project-cover.png)

**A self-hosted control room for Claude Code and OpenAI Codex.**

Organize work by project, collaborate with either agent, and follow their automatic discussions as they happen. The project is under active development; some advanced features currently work only with Claude Code.

## What you can do

- Organize persistent conversations by project and topic.
- Select Claude Code, Codex, or both for an automatic collaborative discussion or debate.
- Request a Claude Code subagent team and inspect the agents actually launched in an agent map.
- Pause after the current answer, resume, intervene during a turn, stop the conversation, or set an optional response or time limit.
- Work with files, tasks, schedules, and project memory from the web interface.
- Optionally configure Telegram, voice features, and GitHub backups.

Each agent uses its own CLI and account. Automatic discussions pass the other agent's latest reply to the next agent; every turn uses the corresponding account. Some features, including parts of the Claude-specific settings, are not yet available for Codex.

## Run locally on macOS

Requirements: macOS, Git, Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), and Claude Code and/or Codex installed and signed in. An agent's account and CLI are required to use that agent.

Clone the repository and start the local server:

```sh
git clone https://github.com/nicolashedoire/harness-pilot.git
cd harness-pilot
bash scripts/dev-local.sh
```

If you already cloned the repository, start from its root and run the last command. On the first run, leave that terminal open, open a second terminal in the same repository, and run:

```sh
bash scripts/dev-local.sh link
```

Open the configuration link and choose a password in your browser. Then use `http://127.0.0.1:8787`. The local instance binds to your computer only and stores its workspace and state in `.harness-pilot-local/`, which Git ignores. Stop the server with `Ctrl+C` in its terminal.

The local script uses an isolated workspace and does not change your system crontab. A local scheduler runs jobs while the application is running; it does not replay jobs missed during sleep or shutdown, and does not support `@reboot`. Scheduled prompts currently use Claude Code. A new local configuration starts in Claude's default permission mode. The application's legacy installation counter, registration and license communication with the upstream service are disabled. Agent CLIs and optional integrations have their own network and privacy settings. The legacy installer and upgrade paths have not yet been validated for this repository; use the local script above.

## Start an automatic conversation

In **Sessions**, create a session and select **Claude Code + Codex**. Choose a collaborative discussion or a debate, optionally set a maximum number of replies or a time limit, and send your topic. You can pause after the current reply, resume, send an intervention immediately, or stop the exchange. Resuming after a limit starts a new period. Each response may use the allowance associated with the relevant agent's account.

You can assign roles to each agent, save reusable role configurations, and choose a Claude model and a separate Codex model identifier. Model availability depends on the corresponding account; leaving a field empty uses that agent's default.

For a task that benefits from parallel work, select **Claude Code — agent team**, request two to six subagents, and open **Agent map** in the session to inspect detected assignments, statuses, and results. Claude decides whether and how to delegate; the requested count is not a hard limit. This mode currently uses Claude's native subagents, not a mixed Claude–Codex team. All work uses the session's permissions and Claude account allowance.

The session menu can generate a reviewable summary, decisions, and suggested actions using Codex. Select the proposed actions you want before adding them to the task board. You can also review and edit the summary before explicitly saving it to the topic's shared `memory.md`. Codex reads this memory on its next turn; Claude normally loads it when starting a new thread. Summary requests use the connected Codex account and are not yet included in the turn statistics.

Telegram is optional and configured separately under **Settings → Telegram**. The inherited Claude integration is documented in the [Telegram guide](docs/user/09-telegram.md); mirroring and control of Codex and two-agent discussions have not yet been validated.

## Documentation and contributions

Start with the [welcome guide](docs/user/01-welcome.md), [local installation](docs/user/02-installation.md), [sessions](docs/user/04-sessions.md), or [backup guide](docs/user/10-backup.md). Some legacy pages are still being updated; the [current audit](docs/AUDIT.md) tracks known limitations. See [CONTRIBUTING.md](CONTRIBUTING.md) for development instructions. Never share private session data, credentials, or API keys in an issue.

You can support development through [PayPal](https://paypal.me/nicolashedoire). The link opens PayPal directly; the application does not handle payments or store payment credentials.

## License

This repository is distributed under the [MIT License](LICENSE), with the original rights holders' permission. Copyright and historical license notices are preserved in [LICENSE.original](LICENSE.original). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Resident companion experiments

In **Settings → Companions**, choose a built-in observer, security or architect role (or define your own) and launch a Codex companion to inspect a copy of the platform's committed source. Follow or stop its session while you work. An internal source-import map helps companions navigate the platform. When it finishes, the existing notification feed links to the proposed diff; notification sounds follow your settings. You can approve or reject a reviewed proposal. Approval records your decision only: it does not apply, publish, or merge changes. Runs are started manually and currently require a Git checkout and Codex CLI. The source copy and workspace sandbox are intended for reviewable experiments, not as a security boundary for untrusted code.
