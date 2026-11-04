# Computer agent (harness-pilot PC): manifest and releases

The agent is the Go program in `pc-agent/` (contract: `pc-agent/PROTOCOL.md`, build and files:
`pc-agent/README.md`). A server never builds it. It serves either a local build (`MAXXING_PC_BIN_DIR`, for
development) or the files of a GitHub release of this repository listed in `server/maxxing/pc_agent.json`, checked
against their SHA-256. Before sending a copy, it appends the pairing trailer to it.

## The manifest

```json
{
  "version": "0.1.0",
  "url": "https://github.com/nicolashedoire/harness-pilot/releases/download/pc-agent-v{version}/{name}",
  "files": {"harness-pc-darwin-arm64": "<sha256>", "...": "..."}
}
```

- The `files` keys are the file names of `pcbridge.TARGETS` (Windows amd64/arm64, macOS arm64/amd64, Linux
  amd64/arm64). `pc-agent/build.sh` writes the whole file for a version as `pc-agent/dist/pc_agent.json`.
- **Empty `files`** (the state until a first release): nothing can be downloaded. `GET /api/pc` says
  `available: false`, Settings -> MCP -> Browser of my PC says the agent is not available yet, and
  `POST /api/pc/pairing` answers `409 no_agent`.
- On the first download of a target, the server fetches the release file, checks its SHA-256 and caches it in
  `<state>/pc/bin/<version>-<name>`. Later downloads are served from that cache and checked again.
- Failures are reported, not hidden:
  - a file missing from the release, or a wrong URL or network error: `502 download_failed`;
  - a file that does not match: `502 checksum`;
  - a target not listed in `files`: `404 no_agent`.

  Publish all six targets: the card offers Windows, Mac (both chips) and Linux downloads.
- `tests/test_pc.py::test_shipped_manifest_points_to_this_repository` checks the file's shape and URL.

## Releasing the computer agent

Nothing is published automatically. A maintainer does these steps by hand:

1. **Build** from a clean checkout of the commit to release:
   `cd pc-agent && VERSION=0.1.0 ./build.sh`. It runs `go vet` and `go test`, then writes the six binaries,
   `SHA256SUMS`, `files.json` and `pc_agent.json` to `pc-agent/dist/` (gitignored). Rebuilding the same commit with
   the same `VERSION` gives the same SHA-256.
2. **Test** that build before publishing it ("Testing a build in isolation" below).
3. **Tag and release** that commit, with the files of `dist/` exactly as built:
   ```sh
   git tag pc-agent-v0.1.0 <commit> && git push origin pc-agent-v0.1.0
   gh release create pc-agent-v0.1.0 --repo nicolashedoire/harness-pilot --title "harness-pilot PC 0.1.0" \
     --notes "..." pc-agent/dist/HarnessPC-* pc-agent/dist/harness-pc-* pc-agent/dist/SHA256SUMS pc-agent/dist/files.json
   ```
   The agent's version is independent of the server's version. A new agent version means a new
   `pc-agent-v<version>` tag. Keep old agent releases: servers that still list them download from them.
4. **Check what was uploaded**: `gh release download pc-agent-v0.1.0 --repo nicolashedoire/harness-pilot -D <empty
   dir>`, then `sha256sum -c SHA256SUMS` in that folder.
5. **Fill the manifest**: copy `pc-agent/dist/pc_agent.json` over `server/maxxing/pc_agent.json` (same URL, with
   `version` and `files` filled). Open a pull request with the `CHANGELOG.md` and `docs/dev/CHANGES.md` lines and the
   user docs (`docs/user/28-mcp.md`, `docs/AUDIT.md`), and run `uv run pytest tests/test_pc.py`.
6. **Test from the release**: on a test server running that branch, get a download for each system from Settings ->
   MCP -> Browser of my PC. Each one must be fetched from GitHub and pass its checksum (`<state>/pc/bin/` fills up).
   Then pair one computer and run Test.

## Testing a build in isolation

Never pair a test agent with a server that someone uses, and never let it use your own browser profile. A whole test
fits in temporary folders:

- **Server.** Use its own port, `MAXXING_STATE`, `HOME`, `MAXXING_CRONTAB_FILE` and `MAXXING_LAUNCH_AGENTS_DIR`, the fake
  `claude` of the tests (`MAXXING_CLAUDE_BIN=server/tests/fake_claude.py`, `FAKE_CLAUDE_DIR`), the background
  workers off as in `server/tests/conftest.py`, and `MAXXING_PC_BIN_DIR=pc-agent/dist`. To test the release path
  itself, leave out `MAXXING_PC_BIN_DIR`. Instead, serve `dist/` under `pc-agent-v<version>/` on a local port and point
  the `url` of `pc_agent.json` in that test checkout at it.
- **Agent.** Start a pairing with Start with the computer off, download the agent with `curl`, then run it with its own
  folders and a test browser, for example Playwright's `chrome-headless-shell`:
  `HOME=<tmp>/home HARNESS_PC_CONFIG_DIR=<tmp>/agent HARNESS_PC_HEADLESS=1 HARNESS_PC_BROWSER_PATH=<test browser>
  ./harness-pc`.
  On macOS the separate `HOME` matters: the agent writes `~/Library/LaunchAgents/com.harnessmaxxing.pc.plist`, or
  deletes it when Start with the computer is off, under `$HOME`.
- **Then**:
  - confirm the computer, then run Test;
  - call a few tools through `POST /api/pc/mcp` (loopback, `mcp_secret` of the state);
  - use Stop now, Erase the profile and Disconnect;
  - stop only the processes you started.

## Names kept on purpose

The launchd label `com.harnessmaxxing.pc`, the Windows Run value `HarnessPC`, the config folders `HarnessPC` /
`harness-pc`, the trailer magic `HMPCCFG1` and the Go module `harnessmaxxing/pcagent` keep their inherited names.
Renaming the label, the Run value or the folders needs a migration for computers that are already paired: an agent
under new names would neither find nor remove the old startup entry and configuration. The module name is never seen
outside the build.
