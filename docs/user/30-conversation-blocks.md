---
section: Using harness-pilot
---
# Conversation blocks

Answers are not only text. When numbers, rows, a command result, files or questions are easier to read as something
else, Claude Code and Codex answer with a **block**: a chart, a table, key figures, a form, a terminal output, a
preview of your files… drawn by the app in your colours, right in the conversation.

## What you can get

| Block | What it shows | What you can do |
|---|---|---|
| Chart | lines or bars | switch to a table, download PNG or CSV, pin to the dashboard |
| Table | rows of data | sort by a column, filter, export CSV, show every row |
| Key figures | a few numbers and their change | pin to the dashboard |
| List, timeline, progress | items with a status, events over time, bars | pin to the dashboard |
| Terminal | a command, its output and exit code | copy, download |
| Diff | a code change, line by line | open the file, download |
| Files and media | images, PDF, videos, audio from this server | open them in the file viewer |
| Link preview | a page, a repository, a ticket | open it |
| Form | choices, sliders, dates | send your answers to the agent |
| Checklist | steps to tick before an action | tick, send the result |
| Mini-app | a small calculator, simulator or game | use it; its button may propose a message |
| Created items | the task, job or notification the agent made | open it where it lives |

Every block has the same frame: its kind, title and source at the top, its content, and its actions. **Open beside**
shows it larger in a panel on the right of the conversation (on a narrow window or a phone, in a sheet over it);
each block you open beside gets a tab there, and × closes the panel. The **…** menu copies the data, downloads it as
JSON or shows the raw data.

## Answers that come back to the agent

A form, a checklist, a mini-app button or **Ask for a fix** never sends anything by itself: the app first shows you
the exact message and the conversation it goes to, and sends it only when you confirm. It then appears in the
conversation as your next message, like anything you type.

## When a block cannot be shown

The rest of the conversation is never affected. Instead of the block you see why, and its raw data on demand:

- **turned off**: the block type is off in your settings; **Turn on** brings it back;
- **not installed**: no plugin of this server draws that type; **Install** opens the catalogue;
- **could not be displayed**: the data does not fit the block; the reasons are listed and **Ask for a fix** asks the
  agent to send it again.

## Settings -> Conversation blocks

Every block type is a plugin. Turn one off and the agents stop using it (they are told the enabled list at every
turn); its blocks already in your conversations show their raw data. Built-in blocks can be turned off but not
removed. Click a plugin to see what it shows, what it can access and the hint the agents get.

**Catalogue**: ideas of blocks harness-pilot can build for you (calendar, kanban board, map, mind map…). **Create**,
or describe the one you miss: a session starts in `system › harness` where harness-pilot writes the plugin, tries it
and shows it to you.

## Block plugins and safety

A block plugin you add (or harness-pilot builds) is an extension of your workspace (`extensions/<id>/block.json` and
one HTML file). It is drawn in an isolated frame: it cannot read your files, your sessions, your keys or the app, and
it has no network at all - unless its manifest declares the hosts it needs, and you allow them the first time
(**Always allow**, **This time** or **Refuse**; you can ask again from its detail panel). Mini-apps written by an agent
run in the same kind of frame, always without network.

Pinning a block to the dashboard makes a widget extension (`pin-…`) with a copy of the data at that moment; hide or
turn it off like any widget.

For developers: the format agents use and the manifest of a block plugin are described in the skill `pilot-blocks`
and in `docs/dev/API.md` (section Conversation blocks); `examples/extensions/kanban-block/` is a complete plugin.
`pilot ext check <id>` checks a plugin the way the server serves it (see
[Command line reference](cli-reference#pilot-ext-check)).
