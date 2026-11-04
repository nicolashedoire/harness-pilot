---
name: pilot-mcp
description: Add, connect, check or remove an MCP server for Claude Code and Codex sessions in harness-pilot (Settings -> MCP). Use when the user wants Claude or Codex to use a service through MCP ("connect the Google Ads MCP", "add the Notion MCP", "install this MCP server", a URL ending in /mcp or /sse, an `npx …-mcp` command), when an MCP tool is missing or "needs authentication", or asks which MCP servers exist.
---

# MCP servers

harness-pilot lists every MCP server of Claude Code in **Settings -> MCP**: where it applies (every session, or one
topic), its state (Connected / To connect / Error / To approve) and the buttons Connect and Remove.
Docs: `docs/user/28-mcp.md` (Settings -> Docs -> MCP servers).

Codex sessions (and Codex's turns in a discussion) get the same servers for their topic, passed at each turn
(`~/.codex/config.toml` is not changed). Outside **Full access** Codex may only call the tools a server marks
read-only. It does not get the **Connect** sign-ins, the claude.ai connectors nor the Browser of my PC, and some
servers are skipped (a key in the URL or in the program's arguments, SSE / WebSocket): the conversation says
which and why. Prefer `--header` and `--env` for keys. Details: `docs/user/28-mcp.md`, section Codex.

## Where to add it
- Only the topic that needs it (most cases: an ads account for the `ads` topic): `--where projects/<p>/topics/<t>`.
- Every session: no `--where` (a tool used everywhere, e.g. a search engine).
Ask when it is not obvious. A server in a topic is invisible to the other topics.

## Add
Server command: `pilot` (`maxxing`, its earlier name, still works).
```bash
pilot mcp add google-ads https://mcp.example.com/mcp --where projects/acme/topics/ads
pilot mcp add notion https://mcp.example.com/mcp --header 'Authorization: Bearer ${NOTION_TOKEN}'
pilot mcp add files --command 'npx -y @acme/files-mcp' --env 'API_KEY=${ACME_KEY}' --where projects/acme/topics/blog
pilot mcp list            # checks the states (takes a few seconds)
pilot mcp remove notion [--where …]
```
- **Never write a token in clear** in the config: put it in the vault (`printf %s "$V" | pilot keys set NAME`,
  or ask the user to add it in Settings -> Keys) and reference it as `${NAME}`. `pilot mcp add` makes the
  referenced keys available to sessions (vault flag `expose`).
- Do not edit `.claude.json` by hand, and do not use `claude mcp add` directly: `pilot mcp` writes in the
  Claude Code folder harness-pilot uses (it can differ from `~/.claude`).
- The new server is loaded by the **next** turn: say so ("it will be available from your next message").

## Connect (OAuth)
State "To connect" (needs authentication) = the service uses a sign-in, no key needed. It cannot be done from a
turn (it needs the user's browser): tell the user to open **Settings -> MCP -> Connect**, open the sign-in page,
accept, then paste the address of the page they land on (an error page on `localhost` is expected; its address
contains `code=`). The connection is kept for every session.

## Troubleshoot
- `Error`: hover the state for Claude Code's message; for an URL, check it with `curl -sI`; for a command, run it
  once by hand in the topic folder.
- `To approve`: a `.mcp.json` file in a project folder that Claude Code was never told to trust; remove it from
  Settings -> MCP or add the server with `pilot mcp add` instead.
- After a topic is renamed, its servers follow it; a deleted topic leaves its servers in `Error` (remove them).
- The memory backup keeps the list of servers (secrets blanked) and a restore adds them back; OAuth connections
  must be done again on a new server.
