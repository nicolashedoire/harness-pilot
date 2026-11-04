# Workspace

Shared context for every session. Each project and topic below has its own CLAUDE.md and memory.md.

@memory.md

## How this workspace is organised

```
<workspace>/
  CLAUDE.md, memory.md          global level (loaded in every session)
  projects/<project>/
    CLAUDE.md, memory.md        project level
    topics/<topic>/
      CLAUDE.md, memory.md      topic level - a session's working directory
      attachments/YYYY-MM/      files sent from the web UI or Telegram
  tasks.json                    the task board (Tasks page)
  extensions/<id>/              dashboard widgets and pages (see extensions/README.md)
```

Every session runs inside a topic folder. Claude Code loads every CLAUDE.md from the working
directory up to the root, and each CLAUDE.md imports its memory.md (`@memory.md`), so a session
in `projects/acme/topics/blog/` automatically knows: global + project `acme` + topic `blog`.
A session at the workspace root only gets the global level.

## Default projects

| Project | Topics | Purpose |
|---|---|---|
| `general` | `inbox` | starter project: quick questions, one-off tasks, the task board, the subscriptions inventory (on demand); default topic of Telegram messages |
| `system` | `tutorial`, `help`, `harness` | harness-pilot itself: interactive 5-minute lessons (delete the topic when done, never re-created), answers from the installed docs + server administration, updates + workspace upgrade notes + extensions + starter packs |

Starter packs (`ecommerce`, `affiliate`, `creator`, `apps`, `second-brain`, `freelance`) can be added
any time from Settings -> Starter pack or by asking in `system/harness`.

When the user asks how to do something in harness-pilot, the answer is in the product docs
(`{{CODE_DIR}}/docs/user/`); the topic `system/help` is dedicated to that.

## Memory rules

At the end of an exchange that produced something durable, update the memory.md of the right level
(skill `memory`):
- **topic** memory.md (most common): state of the work, decisions, conventions, useful paths/URLs
  for this topic;
- **project** memory.md: what is true for every topic of the project;
- **global** memory.md (rare): preferences and rules valid everywhere.

Write short dated bullets, replace facts that became wrong instead of piling up versions, and never
write secrets (tokens and keys go to Settings -> Keys). Do not log chit-chat or one-off questions.
A daily job (skill `memory-compaction`) keeps the files short and consistent.

CLAUDE.md files hold stable instructions (what the project/topic is, how to work on it); memory.md
holds what was learned. The first paragraph under the heading of a CLAUDE.md is the description shown
in the UI.

## Answers shown in the UI

- **Local files**: cite every file, image, video or document you made or used by its absolute path
  (`/root/maxxing/projects/acme/topics/blog/attachments/2026-10/cover.png`), never by its bare name: in the UI
  a path inside the files root (`files_root`, `/root` by default) becomes a link to the file viewer, and images
  and videos get a thumbnail. Paths outside it (`/tmp`...) open nothing: save what you want to show under the
  files root (the topic folder or a work folder), not in `/tmp`.
- **Diagrams**: to explain how something works, a short ` ```mermaid ` block (flowchart, sequence, states,
  timeline) is drawn as a diagram in the UI (Telegram shows its code). Keep it light: about 15 boxes at most,
  short labels in the user's language.
- **Git**: when you talk about a repository (branches, commits, what is not pushed, a merge), add a ` ```git `
  block: `repo: /absolute/path/of/the/clone` (or `repo: github:owner/name`), optional `branches: main, feat-x`,
  `limit: 20`, `highlight: <short shas>` (the commits you mention). The UI draws the live graph of that repository
  (Telegram shows its code). Never draw a git history by hand in mermaid.
- **Infra**: when you talk about sites, databases, buckets, domains or servers, add a ` ```infra ` block, one line
  per resource (`site: shop.example.com`, `database: shop`, `domain: example.com`, `server: <name>`...) or a filter
  (`project: acme`): the UI shows them live with their status (Infra page on). Create them only with `pilot infra`
  (skill `pilot-infra`).

## Saving tokens

Everything a tool prints stays in the conversation and is re-sent on every following call, so keep outputs short:
- long command output: pipe it through `head` / `tail` / `grep`; `git diff --stat` first, then only the files needed;
- logs and Claude transcripts (`~/.claude/projects/*.jsonl`): `grep` / `tail` them, never read them whole; read a
  big file in parts (offset / limit) when only a section matters;
- images and screenshots: shrink them before reading (`magick in.png -resize 1280x out.png`), never read the same
  image twice.

## harness-pilot

This workspace is driven by harness-pilot, a web control room for Claude Code (URL: see
`pilot status`). Sessions, files, tasks, scheduled jobs, Telegram and backups are managed from the
UI; the server CLI is `pilot` (`maxxing`, its earlier name, still works):

| Command | Purpose |
|---|---|
| `pilot status` | version, URL, service, Claude auth, Telegram, backup |
| `pilot doctor [--json]` | full health check with fix hints |
| `pilot update [--check\|--resume\|--rollback]` | check for / install a new version, carrying customizations over (or ask in the topic `system/harness`) |
| `pilot custom [status\|save\|drop\|restore]` | customizations of the product code (see below) |
| `pilot cron list\|sync\|run <id>` | scheduled jobs |
| `pilot backup run\|status\|restore` | memory backup to a private GitHub repo |
| `pilot telegram status\|test` | Telegram bridge |
| `pilot import ZIP [--dry-run]` / `--prompt AGENT` | import another agent's memory (Settings -> Import does the same) |
| `pilot keys list\|get\|set\|delete` | the Keys vault from a script: `printf %s "$V" \| pilot keys set NAME` (value on stdin); scripts read keys as env vars (`$NAME`) |
| `pilot packs list\|add <id>` | starter packs: ready-made projects (only missing files are added) |
| `pilot infra status\|list\|site\|db\|bucket\|server` | where every site / database / bucket / domain / server is; create them on this server the standard way |
| `pilot mcp list\|add\|remove` | MCP servers of Claude Code (every session or one topic), as in Settings -> MCP |
| `pilot video new DIR` / `video status` | Remotion video project linked to the shared install / tools check |
| `pilot pdf IN.html OUT.pdf` | print an HTML page (or URL) to PDF |
| `pilot setup-link` / `pilot password` | first sign-in link / change the UI password |

Never restart the `claude-maxxing` service in the middle of a task without saying so: the UI is
served by it (running turns survive, they live in their own units).

## Customizing harness-pilot

The user may change anything, including the product. Never say "ask the authors" or "an update
would erase it". In this order:
1. **Extension** (`{{WORKSPACE}}/extensions/`, skill `pilot-widgets-pages`): widgets - Card or free
   HTML (games, canvas) -, pages, their API. Untouched by updates.
2. **Workspace instead of code**: a topic's `CLAUDE.md`, a cron, a skill in `.claude/skills/`.
3. **Customization of the product code** (skill `pilot-customize`): edit `{{CODE_DIR}}`, then
   always `pilot custom save "title" --why "reason"`. Recorded in `CUSTOMIZATIONS.md` (workspace),
   replayed by every update; on a conflict the update changes nothing and Claude adapts it in
   `system/harness`. Never under `web/` (pre-built UI: use an extension).

## Skills shipped with the product

| Skill | Use it when |
|---|---|
| `memory` | end of a significant exchange: record durable facts in the right memory.md |
| `memory-compaction` | memory files are long, redundant or contradictory (also run daily) |
| `pilot-setup` | "set up harness-pilot": finish or check an installation |
| `pilot-doctor` | something does not work (UI down, sessions failing, crons not running...) |
| `pilot-telegram` | configure or troubleshoot the Telegram bridge |
| `pilot-backup` | configure, run or restore the memory backup, move to a new server |
| `pilot-crons` | create or change a scheduled job |
| `pilot-tasks` | read or edit the task board (tasks.json) |
| `pilot-widgets-pages` | build a dashboard widget (Card or HTML/game) or a page extension |
| `pilot-infra` | put a site online, create a database or a bucket on this server, add another server, "where is X / is it up" |
| `pilot-mcp` | add, connect or remove an MCP server (a service's tools for Claude), for every session or one topic |
| `pilot-customize` | change the product itself and keep it through updates; adapt customizations when an update conflicts |
| `video-motion-design` | a video, an animation, a short / reel, a trailer (Remotion: `pilot video new DIR`) |
| `pdf-document` | a PDF: quote, invoice, report, guide (HTML -> `pilot pdf IN.html OUT.pdf`) |
| `image-edit` | resize, convert, compress, batch-process images (ImageMagick, ffmpeg) |
| `seo-audit` | an SEO audit of a website, with a prioritized report |
| `web-scraping` | collect data from websites (Scrapling: `scrapling extract …`, `scrapling-python script.py`), watch a page |

## Tasks

`tasks.json` = `{"version": 1, "projects": [TaskProject], "tasks": [Task]}`. Edit it with the
`pilot-tasks` skill (atomic write, keep unknown fields); the Tasks page refreshes by itself.
