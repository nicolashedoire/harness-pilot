# harness-pilot PC agent

This agent is not distributed yet. No release of it is published, so the server's manifest
(`server/maxxing/pc_agent.json`) lists no file and harness-pilot offers no download. It builds for the six targets, and
pairing and browser control were verified end to end on macOS and Linux against an isolated test server: see
[Verified](#verified-2026-11-04).

harness-pilot PC (`HarnessPC.exe` on Windows, `harness-pc` on macOS / Linux) lets Claude sessions on a harness-pilot
server drive a Chromium-based browser (Brave, Chrome, Edge, Vivaldi, Opera, Chromium) on the user's computer, in a
**separate profile**. It only starts / closes that browser and relays its DevTools websocket (bound to 127.0.0.1) to
the server over one outbound TLS websocket. Nothing listens on the network and nothing else is ever executed.
The wire contract is [PROTOCOL.md](PROTOCOL.md).

The server appends a pairing trailer to the generic binary, so a downloaded copy pairs by itself on first run, then
keeps a token in its config file and reconnects forever (backoff 1 s to 60 s). The token being revoked (401/403) or an
`unpair` from the server removes the pairing and stops the agent.

## Build

```sh
VERSION=0.1.0 ./build.sh  # go vet (macOS, Linux, Windows) and go test first; SKIP_CHECKS=1 skips them
```

Needs Go 1.21 or later: the build switches to exactly the `toolchain` of `go.mod` (downloaded and checked by `go`
when missing) and fetches `go-winres` v0.3.3 for the Windows icon and version information. Output in `dist/`
(gitignored), one agent per download target of the server (`pcbridge.TARGETS`):

| File | Content |
|---|---|
| `HarnessPC-windows-{amd64,arm64}.exe`, `harness-pc-{darwin,linux}-{amd64,arm64}` | the agents |
| `SHA256SUMS` | their SHA-256 (`sha256sum -c SHA256SUMS`) |
| `files.json` | version, release tag, Go toolchain, and per file: name, target, os, arch, size, sha256 |
| `pc_agent.json` | the server manifest for this version: `version`, the download `url` template of `server/maxxing/pc_agent.json`, `files` (name -> sha256) |

Reproducible: pinned Go, CGO off, `-trimpath`, no VCS stamp, empty build id. The same commit and `VERSION` give the
same SHA-256 in another folder or on another machine. Windows binaries are GUI apps (`-H windowsgui`): no console
window; messages are shown in message boxes. macOS binaries carry only the Go linker's ad-hoc signature (no
Developer ID, not notarized).

## Tests

```sh
go test ./...                                                     # unit + integration (fake server, fake browser)
HARNESS_PC_SMOKE_BROWSER=/path/to/chrome go test -tags smoke -run Smoke -v   # real browser (manual)
./build.sh && go test -tags idle -run Idle -v                     # idle CPU / RSS of the Linux binary (60 s)
```

## Files

| What | Windows | macOS | Linux |
|---|---|---|---|
| config dir | `%APPDATA%\HarnessPC` | `~/Library/Application Support/HarnessPC` | `$XDG_CONFIG_HOME/harness-pc` (`~/.config/harness-pc`) |
| autostart | HKCU `...\CurrentVersion\Run` value `HarnessPC` | `~/Library/LaunchAgents/com.harnessmaxxing.pc.plist` | `~/.config/autostart/harness-pc.desktop` |

The config dir holds `config.json` (0600, contains the token), `profile-<browser>/`, `harness-pc.log` (1 MB, one
rotation), the single-instance lock and, with autostart, the installed copy of the agent.

Flags: `--status` (configuration without the token), `--version`, `--uninstall`. Environment (tests):
`HARNESS_PC_BROWSER_PATH` (browser executable), `HARNESS_PC_HEADLESS=1`, `HARNESS_PC_CONFIG_DIR`.

## Uninstall

Quit harness-pilot PC (or remove the computer in harness-pilot, which stops it), then run `HarnessPC.exe --uninstall` /
`harness-pc --uninstall`: it removes the autostart entry, the configuration, the browser profiles and the installed
copy. Then delete the downloaded file.

## Verified (2026-11-04)

Version 0.1.0 was built with `./build.sh` (go1.26.10) and run against a harness-pilot server of this repository. That
server had its own port, state, `HOME`, crontab and LaunchAgents folder, and the tests' fake `claude`. The release path
was simulated with a local web server holding `dist/` under `pc-agent-v0.1.0/` and a temporary manifest pointing to it.
Every agent ran with its own `HOME` and `HARNESS_PC_CONFIG_DIR`, a headless test browser and Start with the computer
off:

- macOS: Playwright's `chrome-headless-shell` 156;
- Linux: Debian 12's `chromium` 156, as a non-root user in a container.

No real browser profile was used and no autostart entry was written.

| Check | macOS arm64 | macOS amd64 (Rosetta) | Linux arm64 |
|---|---|---|---|
| Download fetched from the release, checksum checked, cached, trailer added | yes | yes | yes |
| Pairing from the trailer, the computer waits, then is confirmed | yes | yes | yes |
| Nothing relayed before the confirmation (Test says offline) | yes | | |
| Claude's tools through `POST /api/pc/mcp`: `list_pages`, `navigate_page`, `evaluate_script`, `take_snapshot`, `take_screenshot`, `new_page`, `fill`, `click` | yes | `list_pages` (Test) | yes |
| Server refusals: `file:`, `127.0.0.1`, `192.168.1.1`, `upload_file` | yes | | `file:` |
| The agent's own filter, raw DevTools through `/api/pc/cdp`: `file:`, `chrome:`, `view-source:`, download folder, permissions refused; `https:` allowed | yes | | yes |
| Stop now, Erase the profile, idle stop (5 min) | yes | | |
| Agent restart (saved token, no new pairing); server restart (backoff 2 s, 4.5 s, 8.7 s, then connected) | yes | | |
| Refuse a second computer: it removes its pairing and exits, the paired one stays | yes | | |
| Disconnect while online: browser closed, pairing removed, exit | | yes | yes |
| Disconnect while offline: at its next start the token is refused, pairing removed, exit code 3 with a message | yes | | |
| Browser found by the agent without `HARNESS_PC_BROWSER_PATH` | | | yes (`chromium`) |

Found along the way:

- A release file missing from the release, or a wrong release URL, made the download answer an internal error (500).
  It now answers `502 download_failed`. A tampered file is refused with `502 checksum`.
- The copy sent by the server fails `codesign --verify --strict` on macOS, because the pairing trailer comes after the
  linker's ad-hoc signature. It still runs when started from a terminal.

Not verified yet:

- Windows (amd64, arm64) and Linux amd64.
- A visible window of an installed Chrome, Brave or Edge.
- Start with the computer: the LaunchAgents plist, the Run key and the `.desktop` file.
- A download through a web browser. On macOS it is quarantined and the binary is not notarized, so Gatekeeper is
  expected to block it. On macOS and Linux a browser-downloaded file is also not executable; the terminal command
  shown by harness-pilot sets the permission and removes the quarantine.
- A server reached over HTTPS (domain or Tailscale): the test used `http://127.0.0.1`, which the agent accepts for
  tests only.
- Sleep and wake.
