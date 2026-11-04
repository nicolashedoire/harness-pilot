# Linux server installer: state and plan

`install.sh` is the Linux server installer inherited from the original project. This page records what it does,
what was verified for harness-pilot, what still points to the original project, and the steps to turn it back on.
Update it with each step.

## State (2026-11-04)

- **Disabled.** `install.sh` exits at its first lines unless `MAXXING_INSTALL_LIB=1` (library mode: functions only,
  used by the tests). No Linux server install is offered, so there is no HTTPS domain either: mobile push, webhooks
  (Stripe, Shopify, GitHub) and Team, which need a public HTTPS address, cannot be used on a server yet.
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
- **Not verified yet:** the git clone path (its default source is the original project), Ubuntu 24.04, x86_64,
  `ACCESS=domain` (Caddy and its certificate), `ACCESS=tailscale`, the firewall and SSH hardening (a container leaves
  them to its host), swap, `TOOLS` (Node.js, Chromium, Remotion, Scrapling), local voice, `RESTORE_FROM`, `--update`.

## What still points to the original project

In `install.sh`:

| Item | Current value | Plan |
|---|---|---|
| `REPO` default | the original project's GitHub repository | `nicolashedoire/harness-pilot` |
| `BRANCH` default | `stable` | `main`: this repository has no `stable` branch, no tag and no release |
| One-line install in the header and `--help` | a `get.` domain of the original project | the raw `install.sh` of this repository, or a clone then `bash install.sh` |
| `LICENSE` / `LICENSE_API` | records an Enterprise key with the original project's license server | removed from the installer: harness-pilot has no license key |
| Product name in the logo, prompts, banner and generated comments | "Harness Maxxing" | "harness-pilot" |
| `CACHE_DIR` default | `/var/cache/harness-maxxing` | `/var/cache/harness-pilot` (emptied after each successful install, nothing to migrate) |

In the server, reachable from a server install but outside the installer:

- `license.py` (`GIT_URL`, used only to move an install from before 2.0.0a87 off signed archives), the hint of
  `cmd_core.check_update` when the clone has no `origin`, and the Enterprise text of `cmd_license.py` name the
  original project.
- `pc_agent.json` downloads the computer agent from the original project's releases (see `docs/AUDIT.md`).
- `register.py` (anonymous counter, off by default) and the license ping (`MAXXING_LICENSE_PING=1` only) contact the
  original project's API only when turned on.

These are left to their own changes.

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

1. This audit (no behaviour change).
2. Sources: default `REPO` and `BRANCH` of this repository, product name, no license server; still disabled.
3. Re-enable for Debian 12 and Ubuntu 24.04: remove the gate, run install, `pilot doctor` and uninstall end to end in
   systemd containers of both, the installer tests green on Linux.
4. HTTPS with a domain (`ACCESS=domain`, Caddy): verified as far as possible without a real domain (configuration
   generated and validated by Caddy), documented as the condition for mobile push, webhooks and Team.
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
docker exec -e ASSUME_YES=1 -e ACCESS=local -e TOOLS=0 -e VOICE=off -e SOURCE_DIR=/src pilot-test \
  bash -c 'MAXXING_INSTALL_LIB=1; source /src/install.sh; MAXXING_INSTALL_LIB=0; main'
docker exec pilot-test pilot doctor
docker exec pilot-test pilot uninstall --yes --purge
docker rm -f pilot-test
```

Tests on Linux: `cd server && MAXXING_STATE=$(mktemp -d) uv run pytest tests/test_install_reliability.py
tests/test_install_security.py`.
