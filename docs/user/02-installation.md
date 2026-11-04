---
section: Getting started
---
# Local installation

The currently verified setup runs on macOS, on the computer itself. You need Python, [uv](https://docs.astral.sh/uv/), and Claude Code and/or Codex installed and signed in to their respective accounts.

From the repository root, start the local server:

```sh
bash scripts/dev-local.sh
```

Open `http://127.0.0.1:8787`. On first setup, obtain a setup link in a second terminal:

```sh
bash scripts/dev-local.sh link
```

Open that link and choose a password. The server listens only on the local computer. Its workspace, application state and isolated test crontab are stored under `.harness-pilot-local/`, which is ignored by Git. Stop the server with `Ctrl+C` in its terminal.

The local setup disables upstream registration and license communication and starts with restrictive agent permissions. The telemetry counter is off by default. Telegram, voice and backup connections are optional and require separate configuration.

The legacy Linux installer, server deployment and automatic update paths have not yet been validated for this repository. Do not use the upstream install commands to install this version. See the [audit](../AUDIT.md) for current work and known limitations.
