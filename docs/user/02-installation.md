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

The legacy Linux installer, server deployment and automatic update paths have not yet been validated for this repository. The inherited `install.sh` now installs from this repository, but it still refuses normal execution until it is validated on Debian and Ubuntu. Do not use upstream install commands to install this version. See the [audit](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/AUDIT.md) for current work and known limitations, and the [installer status](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/dev/INSTALLER.md) for the plan to bring the Linux installer back.

## Keep it running in the background (macOS)

In a terminal, the app stops when the terminal is closed, and scheduled jobs, backups, resident missions and Telegram stop with it. To keep it running, make it a background service of your user account (a launchd agent). Nothing is installed until you run, from the repository root:

```sh
bash scripts/dev-local.sh service install
```

Run it from a terminal where `uv`, `claude` and `codex` work: the service keeps that terminal's PATH. It runs the same `bash scripts/dev-local.sh`, with the same settings, right away and at every login, and starts it again if it crashes. Stop the app first if it runs in a terminal: the install is refused while its port is in use.

| Command | Effect |
|---|---|
| `bash scripts/dev-local.sh service status` | running or not, its process, the address, the service file, the log files and the PATH it uses |
| `bash scripts/dev-local.sh service restart` | restart it, for example after a `git pull` |
| `bash scripts/dev-local.sh service uninstall` | stop it and remove the service; your state, workspace and logs stay |

Its output goes to `.harness-pilot-local/logs/server.log` and `.harness-pilot-local/logs/server.err.log`. `service status` prints their full paths, which Console.app can open.

**Where the clone lives matters.** macOS keeps background services out of Desktop, Documents, Downloads, iCloud Drive and external disks. A clone in one of those folders cannot run as a service: `install` notices it, removes the service again and says so. To use the service, clone the repository somewhere else, for example `~/harness-pilot`. The same protection applies to the folders your agents work in while the app runs as a service.

The app uses port 8787. `HARNESS_PILOT_PORT=8790 bash scripts/dev-local.sh service install` picks another one, and the variable works without the service too. After installing a tool in a new place (a new PATH), run `service uninstall`, then `service install` again.
