---
section: Getting started
---
# Installation

harness-pilot runs locally on macOS or as a service on a Linux server (Debian 12, Ubuntu 24.04).

## Local (macOS)

The local setup runs on your Mac. You need Git, Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), and Claude Code and/or Codex installed and signed in to their respective accounts. The CLI and account for an agent are required when you use that agent.

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

### Keep it running in the background

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

## Linux server (Debian 12, Ubuntu 24.04)

You need a server with Debian 12 or Ubuntu 24.04 and systemd, x86_64 or arm64, root access (`sudo`) and about 5 GB
of free disk. Local voice transcription needs about 3 GB of memory; under 4 GB without swap, a fresh server gets a
2 GB swap file. Download the installer, read it if you
wish, then run it as root:

```sh
curl --proto '=https' --tlsv1.2 -fsSLo install.sh https://raw.githubusercontent.com/nicolashedoire/harness-pilot/main/install.sh
sudo bash install.sh
```

`sudo bash install.sh --check` first looks at the server and says what the installation would do, without
changing anything. The installer asks how you will reach the web interface:

- **local** (the default without a terminal): the server listens on `127.0.0.1:8787` only. Open an SSH tunnel
  from your computer; the installer prints the exact command (`ssh -N -L 8787:127.0.0.1:8787 user@server`).
- **tailscale**: the server listens on its Tailscale address, for your Tailscale devices only.
- **domain**: HTTPS on your own domain with Caddy and an automatic certificate. This choice has not yet been
  verified with a real domain.

It then installs, without further questions: the system packages; the code of this repository (`main` branch) in
`/opt/claude-maxxing`; uv and Claude Code at pinned versions, their checksums verified; the Python environment;
the workspace (`/root/maxxing`), the state (`/var/lib/claude-maxxing`) and the product's skills; automatic
security updates, fail2ban for SSH and, on a server where nothing else runs, a firewall; the `claude-maxxing`
service. The service runs as root, with a sandboxing configuration, and never listens on a public interface. The
tools for videos, PDFs and web pages (see [Videos, PDFs and images](tools)) and the voice model are installed in
the background afterwards; `pilot deps list` shows them. Unattended installs take their answers from variables,
for example `ACCESS=local ASSUME_YES=1 bash install.sh` as root; `bash install.sh --help` lists them.

At the end, the installer prints a one-time setup link, valid for one hour: open it (through the tunnel for
local access) and choose a password. Whoever opens it first owns the server; `sudo pilot setup-link` prints a
new one. Then connect Claude in **Settings → Claude**. `sudo pilot doctor` checks the installation.

- Update: `sudo pilot update` (it follows the `main` branch of this repository).
- Uninstall: `sudo bash /opt/claude-maxxing/install.sh --uninstall` removes the service, its scheduled jobs, the
  commands and the skills and keeps your data; `--purge` also removes the code and the state, `--purge-workspace`
  also the workspace.

Verified: Debian 12 and Ubuntu 24.04 on arm64, in systemd containers (installation, service, first sign-in,
`pilot doctor`, `pilot update`, uninstallation). Not yet verified: x86_64, a real server (firewall, SSH
settings, swap), a domain with HTTPS, Tailscale and restoring a memory backup during the installation. See the
[installer status](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/dev/INSTALLER.md) for details
and the [audit](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/AUDIT.md) for other known
limitations.
