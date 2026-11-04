# harness-pilot

![Two luminous companions representing the agents](docs/assets/project-cover.png)

**A self-hosted workspace for working with Claude Code and OpenAI Codex.**

Create project sessions, work with either agent, or let both exchange ideas automatically while you follow along. The project is under active development; some advanced features currently work only with Claude Code.

## What you can do

- Organize persistent conversations by project and topic.
- Select Claude Code, Codex, or both for an automatic collaborative discussion or debate.
- Request a Claude Code subagent team and inspect the agents actually launched in an agent map.
- Pause after the current answer, resume, intervene during a turn, stop the conversation, or set an optional response or time limit.
- Work with files, tasks, schedules, and project memory from the web interface.
- Optionally configure Telegram, voice features, and GitHub backups.

Each agent uses its own CLI and account. Automatic discussions pass the other agent's latest reply to the next agent; every turn uses the corresponding account. Some features, including parts of the Claude-specific settings, are not yet available for Codex.

## Run locally on macOS

Requirements: Python, [uv](https://docs.astral.sh/uv/), and a signed-in installation of Claude Code and/or Codex. From the repository root:

```sh
bash scripts/dev-local.sh
```

Open `http://127.0.0.1:8787`. On the first run, open another terminal and run:

```sh
bash scripts/dev-local.sh link
```

Open the configuration link and choose a password in your browser. The local instance binds to your computer only and stores its workspace and state in `.harness-pilot-local/`, which Git ignores. Stop the server with `Ctrl+C` in its terminal.

The local script uses an isolated workspace and does not change your system crontab. A local scheduler runs jobs while the application is running; it does not replay jobs missed during sleep or shutdown, and does not support `@reboot`. Scheduled prompts currently use Claude Code. A new local configuration starts in Claude's default permission mode. The application's legacy installation counter, registration and license communication with the upstream service are disabled. Agent CLIs and optional integrations have their own network and privacy settings. The legacy installer and upgrade paths have not yet been validated for this repository; use the local script above.

## Start an automatic conversation

In **Sessions**, create a session and select **Claude Code + Codex**. Choose a collaborative discussion or a debate, optionally set a maximum number of replies or a time limit, and send your topic. You can pause after the current reply, resume, send an intervention immediately, or stop the exchange. Resuming after a limit starts a new period. Each response may use the allowance associated with the relevant agent's account.

You can assign roles to each agent, save reusable role configurations, and choose a Claude model and a separate Codex model identifier. Model availability depends on the corresponding account; leaving a field empty uses that agent's default.

For a task that benefits from parallel work, select **Claude Code — agent team**, request two to six subagents, and open **Agent map** in the session to inspect detected assignments, statuses, and results. Claude decides whether and how to delegate; the requested count is not a hard limit. This mode currently uses Claude's native subagents, not a mixed Claude–Codex team. All work uses the session's permissions and Claude account allowance.

The session menu can generate a reviewable summary, decisions, and suggested actions using Codex. Select the proposed actions you want before adding them to the task board. You can also review and edit the summary before explicitly saving it to the topic's shared `memory.md`. Codex reads this memory on its next turn; Claude normally loads it when starting a new thread. Summary requests use the connected Codex account and are not yet included in the turn statistics.

To follow discussions in Telegram, configure a bot in **Settings → Telegram** and enable mirroring. Telegram setup is separate from connecting the agents.

## Documentation and contributions

The guides in `docs/user/` describe the existing application; some legacy pages are still being updated for this version. See [the current audit](docs/AUDIT.md) for known inconsistencies and [CONTRIBUTING.md](CONTRIBUTING.md) for development instructions. Never share private session data, credentials, or API keys in an issue.

You can support development through [PayPal](https://paypal.me/nicolashedoire). The link opens PayPal directly; the application does not handle payments or store payment credentials.

## License

This repository is distributed under the [MIT License](LICENSE), with the original rights holders' permission. Copyright and historical license notices are preserved in [LICENSE.original](LICENSE.original). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
