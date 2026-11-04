---
section: Using harness-pilot
---
# Memory

Conversations can share durable context through plain Markdown files in the workspace. Claude Code and Codex use these files differently, as described below.

## Three levels

```
/root/maxxing/
  CLAUDE.md  memory.md                         workspace (global)
  projects/acme/
    CLAUDE.md  memory.md                       project acme
    topics/blog/
      CLAUDE.md  memory.md                     topic acme / blog
```

With the default templates, Claude Code loads `CLAUDE.md` from the workspace, project and topic when starting a thread; each imports its neighboring `memory.md` using `@memory.md`. Codex receives the existing `CLAUDE.md` and `memory.md` files from those levels as context on every turn. Codex reads at most the first 32 KiB of each file. Custom instructions can change what Claude loads.

| File | Contains | Who writes it |
|---|---|---|
| `CLAUDE.md` | stable instructions: what the project/topic is, how to work on it. The first paragraph under the title is the description shown in the UI. | you (or Claude when you ask) |
| `memory.md` | what was learned: decisions, preferences, state of the work, useful paths and URLs | you or an agent you ask; a reviewed session summary can also be appended explicitly |

## What goes where

- **Topic memory** (most common): the state of this work stream, its decisions and conventions.
- **Project memory**: what is true for every topic of the project.
- **Global memory**: your preferences and rules valid everywhere (language, tone, "never push
  without asking"...). Keep it short – it is loaded in every session.

Not in memory: chit-chat, one-off questions, step-by-step logs, and **never secrets** (put them in
Settings -> Keys and mention only the key name).

## The memory skills

- **`memory`** – at the end of a significant exchange Claude records durable facts in the right
  file: short dated bullets, replacing outdated facts instead of piling them up. You can also ask
  explicitly: "remember that ...".
- **`memory-compaction`** – keeps files short and consistent. A scheduled job "Memory compaction"
  runs it every day at 05:00 (see Crons; it starts once the onboarding is finished with Claude signed in). It acts on files longer than the **line limit**
  (Settings -> **Memory**, 200 lines by default) or redundant, contradictory or outdated: it merges
  duplicates, summarizes old history and reorders each file (rules and preferences, current
  state, decisions, references, context). It only edits `memory.md` files. In local mode it runs only while the app is running; missed runs are not replayed.

## Second brain cleaner (Settings -> Memory)

- **Maximum length per file**: the line limit above (or *No limit*).
- **Clean now**: starts the compaction immediately, in a session at the workspace root that you
  can watch.
- The list shows every `memory.md` with its line count; files over the limit are in red.
- From a shell: `pilot memory` prints the same list.

## Editing memory yourself

Memory files are ordinary files: open them in **Files**, edit and save. Codex receives updated content on its next turn. For Claude, start a new thread to ensure it loads the changes. From **Summary and actions** in a session, you can also review and edit the proposed text, then explicitly append it to the topic memory. No summary is saved automatically.

## Backup

Memory is the most valuable thing on the server. Enable the [Backup](backup) to push it to a
private GitHub repository every day, with history.
