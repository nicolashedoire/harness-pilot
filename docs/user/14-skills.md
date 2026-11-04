---
section: Extending
---
# Skills

Skills are instructions Claude Code and Codex may load when a task matches their description. On a [Linux server](installation), the installer installs the product skills in Claude's skills directory (`~/.claude/skills`) and in Codex's personal skills directory (`~/.agents/skills`), so a Codex session can use them too. The local startup script installs them in `.harness-pilot-local/.claude/skills` and `.harness-pilot-local/.agents/skills` at every start: Claude Code and Codex read them for the sessions of the local workspace only, and your personal skills (`~/.claude/skills`, `~/.agents/skills`) are never changed. With Claude Code, a personal skill with the same name as a product skill wins; Codex lists both.

## Shipped skills

| Skill | Claude uses it when |
|---|---|
| `memory` | an exchange produced something durable: it records it in the right memory.md |
| `memory-compaction` | memory files grew too long or contradictory (also run daily by a job) |
| `pilot-setup` | you say "set up harness-pilot", or want to finish/verify an installation |
| `pilot-doctor` | something does not work: UI down, sessions failing, jobs not running |
| `pilot-telegram` | you configure or troubleshoot the Telegram bridge |
| `pilot-backup` | you configure, run or restore the backup, or move to a new server |
| `pilot-crons` | you want something to happen on a schedule |
| `pilot-tasks` | you talk about your tasks or the board |
| `pilot-notifications` | you say "notify me when…", or want sales, orders, deployments, e-mails or a script's results reported (webhooks, `pilot feed post`) |
| `pilot-mcp` | you want Claude to use a service through MCP ("connect the Google Ads MCP"), an MCP tool is missing or needs a sign-in |
| `pilot-infra` | you want a site online, a database or an S3 bucket on this server, another server added, or ask "where is X, what runs where, is it up" (sites, databases, buckets, domains, servers; see [Infra](infra)) |
| `pilot-widgets-pages` | you want a dashboard widget (Card, or HTML: a game, a canvas) or a custom page |
| `pilot-blocks` | an answer is clearer as a chart, a table, a form, a terminal output or a file preview ([Conversation blocks](conversation-blocks)), or you want a new kind of block |
| `pilot-customize` | you want to change the product itself, or an update reports that your customizations need adapting |
| `pilot-theme` | you ask for a colour theme or a palette for harness-pilot ("colours like my logo", a light version, more contrast); used by Settings -> Appearance -> Create with harness-pilot (see [Customizing](customizing)) |
| `pilot-rea-investigation` | you want a local application, packaged JavaScript or a binary investigated with an optional external REA installation (not bundled); used by the reverse-engineering companion (see [Settings](settings-and-keys#resident-companions)) |
| `pilot-model-evolution` | you want a local AI model evaluated, adapted or redesigned through bounded experiments with an external adapter, and the candidate submitted for your review (see [Model evolution plugin](model-evolution)) |
| `video-motion-design` | you ask for a video, an animation, a short / reel or a trailer (Remotion, see [Videos, PDFs and images](tools)) |
| `pdf-document` | you ask for a PDF: a quote, an invoice, a report, a guide |
| `image-edit` | you want images resized, converted, compressed or batch-processed |
| `seo-audit` | you ask for an SEO audit or why a site does not rank |
| `web-scraping` | you want data collected from a website (prices, catalogue, listings…) or a page watched for changes |

You can also name a skill explicitly: "use the pilot-doctor skill".

`pilot init` and `pilot update` keep these up to date, for Claude Code and for Codex. They overwrite only the
product skills (names starting with `pilot-`, plus `memory`, `memory-compaction`, `video-motion-design`,
`pdf-document`, `image-edit`, `seo-audit` and `web-scraping`). If a skill with one of
those names already existed, it is moved to `/var/lib/claude-maxxing/trash/skills/` first (the Codex copy as
`<name>-codex-<time>`). `pilot doctor` reports a missing or outdated copy, marked `Codex:` when it is Codex's.

### Renamed skills

The product skills used to start with `maxxing-`. They now start with `pilot-`, and some have a clearer name:

| Old name | New name |
|---|---|
| `maxxing-setup` | `pilot-setup` |
| `maxxing-doctor` | `pilot-doctor` |
| `maxxing-telegram` | `pilot-telegram` |
| `maxxing-backup` | `pilot-backup` |
| `maxxing-cron` | `pilot-crons` |
| `maxxing-tasks` | `pilot-tasks` |
| `maxxing-feed` | `pilot-notifications` |
| `maxxing-mcp` | `pilot-mcp` |
| `maxxing-extension` | `pilot-widgets-pages` |
| `maxxing-customize` | `pilot-customize` |
| `maxxing-infra` | `pilot-infra` |

The update installs the new names and removes the old copies by itself (an old copy it did not install is
moved to the trash). It also replaces the old names in the lines of your workspace `CLAUDE.md` files that are
still the text the product wrote, and in the prompts of the default jobs you never edited. Text you wrote
yourself - your own notes, jobs or skills that name an old skill - is left as it is: after the update,
Claude looks for the old names in it and offers each change (nothing changes without your yes). You can also
ask it any time to "replace the old skill names in my notes and jobs".

## Adding your own skills

Create a folder with a `SKILL.md`:

```
~/.claude/skills/blog-article/SKILL.md            user level: available in every session
/root/maxxing/.claude/skills/blog-article/SKILL.md  workspace level: included in the memory backup
```

```markdown
---
name: blog-article
description: Write and publish a blog article for the Acme blog. Use when asked for a new article, a draft, or the next subject of the editorial plan.
---

# Blog article

1. Pick the next subject in projects/acme/topics/blog/plan.md ...
2. ...
```

Tips:
- The **description** decides when Claude uses the skill: say *what* it does and *when* to use it.
- Keep the body a precise procedure: steps, paths, commands, checks, what never to do.
- Every skill's name and description is sent with **every** prompt of every session. Past Claude Code's budget
  (about 8,000 characters), the descriptions of the least used skills are dropped and Claude picks them less
  reliably - `pilot doctor` shows the total. Keep a skill that only one project uses in that project
  (`projects/<p>/.claude/skills/`: loaded only in its topics), or add `disable-model-invocation: true` to its
  frontmatter so only you can call it (`/name`).
- Put helper scripts next to `SKILL.md` and reference them by path.
- Ask Claude to write the skill for you after you have done a task together once: "turn what we
  just did into a skill".
- Custom skills are never overwritten by updates. Skills under `<workspace>/.claude/skills/` are
  included in the backup; user-level skills in `~/.claude/skills/` are not.
- Codex sessions use your workspace skills too: harness-pilot copies each folder of `<workspace>/.claude/skills/`
  into Codex's skills folder (next to the product skills) at start and every few minutes, and removes the copy when
  you delete the skill. A Codex skill of the same name that you wrote yourself there is left alone. Skills of one
  project (`projects/<p>/.claude/skills/`) are not copied: Codex would load them in every session.
- The Atelier lists your workspace skills with the agents that see them.
- Check how your Claude Code version discovers project-level skills (`claude --help`, Claude Code
  docs) if a workspace skill is not picked up in a topic session; the user level always works.
