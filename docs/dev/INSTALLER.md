# Linux server installer: state and plan

`install.sh` is the Linux server installer inherited from the original project. This page records what it does,
what was verified for harness-pilot, what pointed to the original project, and the steps that turned it back on.
Update it with each step.

## State (2026-11-04)

- **Enabled (step 3)** for Debian 12 and Ubuntu 24.04. The gate is gone; the script refuses only a shell that is not
  bash 4 or newer. `MAXXING_INSTALL_LIB=1` still loads the functions without running anything (tests). HTTPS with a
  domain (needed by mobile push, webhooks and Team): see step 4 below.
- **Before step 3**, the script exited at its first lines unless `MAXXING_INSTALL_LIB=1`; the runs below up to step
  2 bypassed that gate through library mode.
- **Tests.** `server/tests/test_install_reliability.py` and `test_install_security.py` (37 tests, 91 cases with their
  parameters) source the script in library mode. They need bash 4 or newer (associative arrays): they fail on the bash
  3.2 of macOS and pass on Linux (91 passed in `debian:12`, bash 5.2.15, arm64).
- **End-to-end run.** In a Debian 12 container booted with systemd (arm64, Docker Desktop, `--privileged
  --cgroupns=host`), the gate was bypassed (`MAXXING_INSTALL_LIB=1; source install.sh; MAXXING_INSTALL_LIB=0; main`)
  with `SOURCE_DIR` set to a copy of this repository, `ACCESS=local TOOLS=0 VOICE=off ASSUME_YES=1`:
  - the 9 steps finished in 44 s (packages, code copied from the local tree, uv and Claude Code downloaded with their
    sha256 checked, Python environment, `pilot init`, service, security);
  - the `claude-maxxing` unit was active with its sandboxing drop-in, listening on `127.0.0.1:8787` only;
    `GET /api/auth/state` answered `setup_required: true`; the banner printed a one-time setup link;
  - the 22 product skills (`pilot-*` and the shared ones) were installed, `pilot` and `maxxing` linked in
    `/usr/local/bin`, 2 managed crontab lines written;
  - `pilot doctor`: 1 problem (Claude not signed in, expected) and 3 warnings (first sign-in not done, tools not
    installed because of `TOOLS=0`, components missing for the same reason);
  - `pilot uninstall --yes --purge` removed the service, the crontab block, the skills, the commands, the fail2ban
    jail, the downloaded tools, the code and the state directory, and kept the workspace.
- **Git path (step 2).** The installer alone (`/root/install.sh`, no source tree beside it), same gate bypass and
  options, in a fresh Debian 12 systemd container: it cloned `nicolashedoire/harness-pilot` (`main`, partial clone,
  `origin` set) and finished the 9 steps in 1 min 06 s. `pilot update --check` saw the newer commits of `main`;
  `pilot update` moved the code, synced the dependencies, refreshed the skills and restarted the service (it answered
  again); `pilot uninstall --yes --purge` was clean.
- **Step 3, no bypass**, `bash /root/install.sh` run directly in fresh arm64 systemd containers:
  - `sh install.sh` is refused with a message; `--check` reported a fresh server and changed nothing.
  - Debian 12, defaults (`ASSUME_YES=1` only: local access, local voice, `TOOLS=background`): 9 steps in 52 s, then
    the background unit `maxxing-deps-install` installed Node.js, Scrapling, Remotion and the Whisper `small` model.
    The first sign-in worked (`POST /api/auth/setup` with the token of `pilot setup-link`, then `authenticated:
    true`). `install.sh --update` updated and restarted the service; `install.sh --uninstall --purge` left no unit,
    crontab line, command, code or state behind (workspace kept).
  - Ubuntu 24.04 (`VOICE=off TOOLS=foreground`): 10 steps in 1 min 43 s, then `pilot doctor` and the same uninstall.
  - Chromium on arm64 is reported as failed because Playwright's arm64 folder (`chrome-linux-arm64`) was not looked
    at; fixed separately in `deps.CHROMIUM_DIRS`.
  - A minimal image without tzdata gave `UTC` then `Etc/UTC` (doctor warning): the installer now reads the system zone
    after installing tzdata.
- **Step 4, HTTPS with a domain** (`ACCESS=domain`), Debian 12 and Ubuntu 24.04 containers started with
  `--add-host ui.example.com:127.0.0.1`:
  - the installer installed Caddy 2.11.8 from its apt repository (signing key fingerprint checked), wrote
    `/etc/caddy/claude-maxxing.caddy` and a Caddyfile with the admin API on a socket; `caddy validate` passed, Caddy
    listened on 80/443, the server stayed on `127.0.0.1:8787`, the setup link started with `https://ui.example.com`;
  - Let's Encrypt cannot issue for a test domain, so `tls internal` was added by hand to the site (test only, Caddy's
    local CA trusted with `--cacert`): HTTP answered 308 to HTTPS; HTTPS/2 200 with HSTS, nosniff, `SAMEORIGIN`,
    `same-origin`; `POST /api/auth/setup` set an `HttpOnly; SameSite=strict; Secure` cookie; `GET /api/push` said
    `available: true`; a generic webhook's URL was `https://ui.example.com/api/hooks/<token>` and a POST to it
    created a feed event; `/api/stream` streamed through Caddy; `pilot doctor` showed the public URL reachable with
    the test CA in `SSL_CERT_FILE`;
  - a local installation re-run with `ACCESS=domain DOMAIN=ui.example.com` switched to the domain (public URL, Caddy
    installed, everything else kept); the generated site was byte-identical before and after `caddy_site_text`;
  - `pilot uninstall --yes --purge` removed the site and Caddy (installed by the installer).
  - Not verifiable here: a real Let's Encrypt certificate (needs a real domain with DNS and ports 80/443 open),
    Team readiness (the test domain resolves to a loopback address, which `teampeer.readiness` rightly refuses).
- **Not verified yet:** x86_64 (no amd64 emulation here), a real server (firewall and SSH hardening are left to the
  host in a container, swap is skipped there), a Let's Encrypt certificate for a real domain, `ACCESS=tailscale`,
  `RESTORE_FROM`.

## What pointed to the original project

In `install.sh` (all changed in step 2):

| Item | Before | Now |
|---|---|---|
| `REPO` default | the original project's GitHub repository | `nicolashedoire/harness-pilot` |
| `BRANCH` default | `stable` | `main`: this repository has no `stable` branch, no tag and no release |
| One-line install in the header and `--help` | a `get.` domain of the original project | download the raw `install.sh` of this repository, then `bash install.sh` (no pipe into a shell) |
| `LICENSE` / `LICENSE_API` | records an Enterprise key with the original project's license server | removed: harness-pilot has no license key (a `LICENSE` given anyway gets a warning) |
| Product name in the logo, prompts, banner and generated comments | "Harness Maxxing" | "harness-pilot", `pilot <command>` hints, a PILOT logo |
| `CACHE_DIR` default | `/var/cache/harness-maxxing` | `/var/cache/harness-pilot` (emptied after each successful install, nothing to migrate) |

Outside the installer, now pointing to this repository: the `pilot update` hint for a clone without `origin`
(`cmd_core.check_update`), `pilot license status` (no Enterprise link), the "Move to a new server" step of the
`pilot-backup` skill (this repository's `install.sh`, no pipe into a shell), `SECURITY.md`, `CODE_OF_CONDUCT.md` and
`.github/` (this repository's private vulnerability reporting; the funding, Enterprise and X links are gone). Two
unused interface texts that named the original project's API were removed.

What still names the original project (none of it is contacted by default):

- `server/maxxing/pc_agent.json`: the computer agent's release URL points to the original project's releases. Its
  `files` list is empty, so nothing is downloaded and the PC page says no agent is available (see `docs/AUDIT.md`).
- `server/maxxing/license.py`: `API` (`https://api.harness-maxxing.com`, also used by `register.py` for the
  anonymous counter and by `feedback.py`) and `GIT_URL` / `GIT_BRANCH` (`stable`, used only to move an install from
  before 2.0.0a87 off signed archives). Every call is refused unless `MAXXING_LICENSE_PING=1`
  (`register._offline`), and the register, feedback and license routes answer 404 (`api/settings._legacy_cloud`).
- The docstrings of `feedback.py`, `register.py` and `api/settings.post_feedback`, which name that service.
- Internal names with no network effect: the PC agent's Go module `harnessmaxxing/pcagent` and its launchd label
  `com.harnessmaxxing.pc` (renaming the label needs a migration of the paired computers).
- Kept on purpose: `LICENSE.original` (the previous notices), the inherited entries of `CHANGELOG.md` and
  `docs/dev/CHANGES.md`, the `MAXXING_LICENSE_API` row of `docs/dev/INTERNALS.md`, and `docs/upgrade/2.0.0a85.md`
  (marked as inherited).

## Third-party sources (kept)

Pinned in `server/maxxing/deps.toml` and downloaded through `fetch_verified` (HTTPS, sha256 checked before use): uv
(GitHub releases of astral-sh), Claude Code (`downloads.claude.ai`), Node.js (`nodejs.org`), Caddy's apt repository
(`dl.cloudsmith.io`, signing key fingerprint checked), plus the Debian or Ubuntu archives. The DNS check of
`ACCESS=domain` asks `api.ipify.org` for the public address (warning only).

## Internal names (kept)

`/opt/claude-maxxing`, `/var/lib/claude-maxxing`, the `claude-maxxing` unit, `/etc/caddy/claude-maxxing.caddy`, the
fail2ban jail `harness-maxxing.local`, the SSH drop-in `01-harness-maxxing.conf` and Caddy's
`harness-maxxing-admin.conf` drop-in are also used by the server
(`config.py`, `cmd_core.py`, `health.py`, `crons.py`) for `pilot doctor`, `pilot update` and `pilot uninstall`.
Renaming them needs a migration of existing installs; it is not part of this plan.

## Design facts to keep in mind

- The installer and the service run as **root** (`User=root`): sessions and jobs are systemd units started by the
  server, jobs live in root's crontab, Claude Code's folder is root's. There is no dedicated user. The service gets a
  sandboxing drop-in (`10-hardening.conf`, same text as `cmd_core.HARDENING`) and a memory cap. Running as a dedicated
  user would need server changes and is not part of this plan.
- The server never listens on a public interface: `127.0.0.1` (SSH tunnel), the Tailscale address, or `127.0.0.1`
  behind Caddy for a domain. With a domain, Caddy gets the certificate by itself (ACME) and the installer writes
  `/etc/caddy/claude-maxxing.caddy`; another web server on 80/443 gets a block to paste instead.
- Security step on a fresh server: unattended security updates, fail2ban for SSH, ufw (SSH, plus 80/443 for a
  domain), SSH password logins off only when this session is proven to use a key.

## Plan

1. This audit (no behaviour change). Done.
2. Sources: default `REPO` and `BRANCH` of this repository, product name, no license server; still disabled. Done.
3. Re-enable for Debian 12 and Ubuntu 24.04: remove the gate, run install, `pilot doctor` and uninstall end to end in
   systemd containers of both, the installer tests green on Linux. Done.
4. HTTPS with a domain (`ACCESS=domain`, Caddy): verified as far as possible without a real domain (configuration
   generated and validated by Caddy), documented as the condition for mobile push, webhooks and Team. Done.
5. User docs (`docs/user/02-installation.md`, `README.md`, `docs/user/22-tools.md`) aligned with what was verified.

## Reproduce

```sh
# a Debian 12 image with systemd as PID 1 (Dockerfile):
#   FROM debian:12
#   RUN apt-get update && apt-get install -y systemd systemd-sysv dbus ca-certificates iproute2 procps
#   CMD ["/sbin/init"]
docker build -t pilot-systemd:debian12 .
docker run -d --name pilot-test --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock pilot-systemd:debian12
git ls-files -z -co --exclude-standard | tar --null -cf - -T - | docker exec -i pilot-test sh -c 'mkdir /src && tar -xf - -C /src'
docker exec -e ASSUME_YES=1 -e ACCESS=local -e TOOLS=0 -e VOICE=off -e SOURCE_DIR=/src pilot-test bash /src/install.sh
docker exec pilot-test pilot doctor
docker exec pilot-test pilot uninstall --yes --purge
docker rm -f pilot-test
```

Tests on Linux: `cd server && MAXXING_STATE=$(mktemp -d) uv run pytest tests/test_install_reliability.py
tests/test_install_security.py`.

## Public install and tools (step 5)

From the public path, in a fresh Ubuntu 24.04 arm64 systemd container: `curl -fsSLo install.sh` of the raw `main`
file, then `ASSUME_YES=1 bash install.sh` with every other default (local access, local voice, background tools).
9 steps in 48 s; the background unit installed Node.js 22.23.3, Scrapling 0.4.15, Chromium 1248 (found in
`chrome-linux-arm64/`), Remotion 4.0.534 and the Whisper `small` model; `pilot video status` was all ready. Then, for
real: `pilot pdf page.html page.pdf` (text read back with `pdftotext`), `scrapling extract get` and `scrapling extract
fetch` (browser) on example.com, `pilot video new` then `npm run render` (h264, 1920x1080, 5 s, rendered in 22 s).
A manual `pilot deps update` during the background one broke both before the deps lock (Node.js and Remotion
missing); with the lock (`deps.exclusive`), the second one waits. User docs: `README.md` (Run on a Linux server), `docs/user/02-installation.md`,
`docs/user/22-tools.md`.
