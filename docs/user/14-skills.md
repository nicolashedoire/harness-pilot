---
section: Extending
---
# Skills

Skills are instructions Claude Code may load when a task matches their description. The inherited Linux setup installs project skills in Claude's skills directory. The local startup script does not install or overwrite your personal Claude skills; availability depends on your existing Claude configuration and workspace. Codex has its own skills mechanism, and parity with the Claude skills below has not been validated.

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
| `pilot-widgets-pages` | you want a dashboard widget (Card, or HTML: a game, a canvas) or a custom page |
| `pilot-customize` | you want to change the product itself, or an update reports that your customizations need adapting |
| `video-motion-design` | you ask for a video, an animation, a short / reel or a trailer (Remotion, see [Videos, PDFs and images](tools)) |
| `pdf-document` | you ask for a PDF: a quote, an invoice, a report, a guide |
| `image-edit` | you want images resized, converted, compressed or batch-processed |
| `seo-audit` | you ask for an SEO audit or why a site does not rank |
| `web-scraping` | you want data collected from a website (prices, catalogue, listings…) or a page watched for changes |

You can also name a skill explicitly: "use the pilot-doctor skill".

`pilot init` and `pilot update` keep these up to date. They overwrite only the product skills
(names starting with `pilot-`, plus `memory`, `memory-compaction`, `video-motion-design`,
`pdf-document`, `image-edit`, `seo-audit` and `web-scraping`). If a skill with one of
those names already existed, it is moved to `/var/lib/claude-maxxing/trash/skills/` first.

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
yourself - your own notes, jobs or skills that name an old skill - is left as it is: Claude still finds the
skill most of the time, but ask it to "replace the old skill names in my notes and jobs" to tidy up (it shows
you each change first).

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
- Check how your Claude Code version discovers project-level skills (`claude --help`, Claude Code
  docs) if a workspace skill is not picked up in a topic session; the user level always works.
