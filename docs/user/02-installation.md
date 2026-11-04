---
section: Getting started
---
# Local installation

The currently verified setup runs locally on macOS. You need Git, Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), and Claude Code and/or Codex installed and signed in to their respective accounts. The CLI and account for an agent are required when you use that agent.

Clone the repository and start the local server:

```sh
git clone https://github.com/nicolashedoire/harness-pilot.git
cd harness-pilot
bash scripts/dev-local.sh
```

If you already cloned it, run the last command from the repository root. On first setup, keep the server running and obtain a setup link in a second terminal, also in the repository root:

```sh
bash scripts/dev-local.sh link
```

Open that link and choose a password, then visit `http://127.0.0.1:8787`. The server listens only on the local computer. Its workspace, application state, local scheduler data and the product's Claude Code skills (see [Skills](skills)) are stored under `.harness-pilot-local/`, which is ignored by Git. Stop the server with `Ctrl+C` in its terminal.

To use an agent, sign in to its CLI on the computer and check its connection in **Settings → Claude** or **Settings → Codex**. A CLI or provider may have its own account, network and privacy settings.

The local setup disables upstream registration and license communication and starts with restrictive agent permissions. The telemetry counter is off by default. Telegram, voice and backup connections are optional and require separate configuration.

The legacy Linux installer, server deployment and automatic update paths have not yet been validated for this repository. The inherited `install.sh` refuses normal execution until it is adapted; it must not install the upstream project by mistake. Do not use upstream install commands to install this version. See the [audit](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/AUDIT.md) for current work and known limitations, and the [installer status](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/dev/INSTALLER.md) for the plan to bring the Linux installer back.
