# harness-pilot PC agent

This agent is not yet distributed by this repository. The source compiles and its automated tests pass on macOS arm64; pairing and browser control have not yet been verified end to end for this version. The server's inherited release manifest contains no downloadable binaries.

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
