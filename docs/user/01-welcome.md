---
section: Getting started
---
# Welcome to harness-pilot

harness-pilot is a self-hosted workspace for **Claude Code and OpenAI Codex**. Organize work into projects and topics, start persistent sessions with either agent, or let them exchange ideas while you follow the conversation.

The project is under active development. The [local macOS setup](installation) is the currently verified way to run it. Some inherited features and deployment paths still need verification; the repository's [audit](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/AUDIT.md) tracks their status.

## How the workspace is organized

| Concept | What it means |
|---|---|
| **Workspace** | The folder containing your projects, tasks and other working files. The local setup stores it under `.harness-pilot-local/`. |
| **Project** | A folder for a product, client or other area of work. |
| **Topic** | A stream of work within a project. Sessions run in a topic. |
| **Session** | A persistent conversation with Claude Code, Codex, or both. A topic can have multiple sessions. |
| **Memory** | Markdown instructions and notes that agents can use as context. See [Memory](memory) for each agent's behavior. |
| **Scheduled job** | A prompt or command that runs on a schedule. In local mode, jobs run only while the app is open. |

## Start working

1. Follow [Local installation](installation), open the setup link and choose a password.
2. Sign in to the Claude Code and/or Codex CLI on your computer. Check the connection under **Settings → Claude** or **Settings → Codex**.
3. Create or select a project and topic, then open **Sessions** and start a conversation.
4. Choose **Claude Code**, **Codex**, or **Claude Code + Codex**. With both agents, select a discussion or debate and optionally set limits before sending a topic.

See [Sessions](sessions) for models, roles, pause and stop controls, summaries and Claude's native agent team. Provider accounts and their usage limits apply to their respective turns.

In a terminal, the `pilot` command looks after the installation: `pilot doctor` checks it and `pilot status` sums it up (in the local setup, run `bash scripts/dev-local.sh cli doctor` from the repository root, so that the command uses the settings of your local app; `maxxing`, its earlier name, is the same command). See the [command reference](cli-reference). harness-pilot also ships skills for Claude Code, named `pilot-...` (`pilot-crons`, `pilot-notifications`, `pilot-theme`...), that Claude uses when a request matches; see [Skills](skills).

## Optional integrations and privacy

- **Telegram:** configure a bot under **Settings → Telegram** to talk to your sessions from your phone, and start Claude Code sessions, Codex sessions (`/codex`) or Claude Code + Codex discussions (`/discuss`) there; see [Telegram](telegram). The Codex and discussion paths have only been checked with a simulated Telegram so far.
- **Backup:** selected workspace files and settings can be backed up to a private GitHub repository. Conversations, attachments and files outside the configured patterns are not included. See [Backup](backup) before relying on it for recovery.
- **Notifications and voice:** configure the available options in Settings. Browser permissions and external services may be needed.

Prompts and relevant context are sent to the selected agent provider. Optional integrations communicate with their own services. The application's legacy installation counter and upstream registration are disabled by default; agent CLIs and integrations have their own network and privacy settings.

## Learn more

- [Installation](installation) and [Onboarding](onboarding)
- [Sessions](sessions), [Memory](memory) and [Tasks](tasks)
- [Backup](backup), [Security](security) and [Troubleshooting](troubleshooting)
