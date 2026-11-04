---
name: pilot-blocks
description: Answer with conversation blocks - charts, tables, key figures, lists, timelines, progress bars, terminal output, diffs, files and media, link cards, forms whose answers come back to you, checklists, HTML mini-apps and "created" cards - drawn natively in the harness-pilot UI from a fenced JSON block. Use when an answer has numbers to compare, rows of data, a command result, files to show, or questions to ask the user; also to build a new block plugin (extensions/<id>/block.json). Enabled on this server: {{PILOT_BLOCKS_TYPES}}.
---

# Conversation blocks

The web UI turns a fenced code block into a rich, themed block when its info string is a **block type** and its
body is **one JSON object** matching that type. Everything else in the answer stays markdown. Telegram and the
terminal show the raw JSON, so keep a sentence of context around each block.

```chart
{"title": "Revenue per day", "kind": "line", "unit": "EUR",
 "series": [{"name": "October", "points": [["1 Oct", 320], ["2 Oct", 410], ["3 Oct", 395]]}]}
```

## Enabled on this server

Generated from Settings -> Conversation blocks (refreshed when a block is turned on or off); full JSON schemas:
`{{STATE_DIR}}/blocks/reference.md`.

{{PILOT_BLOCKS_ENABLED}}

## Rules

1. **Only the enabled types** listed above. A type that is not listed is off: never emit it, write markdown
   instead (the examples below may show types that are off here).
2. **Valid JSON, nothing else in the fence**: double quotes, no comments, no trailing commas. Invalid or unknown
   data is shown raw with the reason - check required fields before sending.
3. **One idea per block**, only when it says more than a sentence (4 figures -> `stats`, 30 rows -> `table`).
   Prefer several small blocks to one huge one; keep a block under ~200 kB.
4. **Text is shown as text**: never put HTML or markdown in JSON fields (it is escaped). Links (`href`, `url`)
   must be `https://...` or an app route (`/tasks?task=<id>`, `/crons?job=<id>`, `/sessions?session=<id>`).
5. **Files by absolute path** inside the files root (`{{WORKSPACE}}/...`), never `/tmp`.
6. `title` and `source` (where the data comes from: file names, API, command) are optional on every type and shown
   in the block header.
7. A `form` / `checklist` answer comes back as the user's next message (plain text they confirmed): wait for it,
   do not assume the answer.
8. **Figures as JSON numbers** (`12480`, not `"12 480"` or `"12,480"`), with their `unit` where the type has one
   (`"€"`, `"GB"`, `"%"`): the UI writes them the way the user's language does (12,480 € in English, 12 480 € in
   French). Text you write yourself (a label, a `delta` such as "+18% vs Sept") is shown as written.

## Built-in types

### Data
```chart
{"title": "Orders", "kind": "bar", "source": "orders.csv",
 "series": [{"name": "Sept", "points": [["W1", 61], ["W2", 70]]}, {"name": "Oct", "points": [["W1", 72], ["W2", 88]]}]}
```
`kind`: `line` (default) or `bar`; 1-6 series sharing the same x values; `x` is a label or a number, `y` a number.

```table
{"title": "Best products", "source": "sales-october.csv",
 "columns": ["Product", {"label": "Revenue", "type": "number", "unit": "€"}, {"label": "Share", "type": "bar"}, {"label": "vs Sept", "type": "delta", "unit": "%"}],
 "rows": [["Mug", 3120, 25, 32], ["Notebook", 2460, 20, 9]]}
```
Column `type`: `text`, `number` (right-aligned), `percent`, `delta` (green / red by sign), `bar` (0-100); `unit`
follows the numbers of a `number` or `delta` column. The user can sort, filter and export CSV; `page_size`
(default 10) rows show before "Show all".

```stats
{"items": [{"label": "Revenue", "value": 12480, "unit": "€", "delta": "+18% vs Sept"}, {"label": "Refunds", "value": 7, "delta": 2, "tone": "warn"}]}
```
`value`: a number (with its `unit`) or a short text; `delta`: a number (its sign is shown) or a short text.

```list
{"items": [{"title": "Nightly backup", "subtitle": "04:40", "status": "ok", "href": "/crons"}, {"title": "Disk", "value": "82 %", "status": "warn"}]}
```
`icon`: a lucide icon name (`server`, `mail`, `shopping-cart`...); `grid: true` shows tiles.

```timeline
{"lanes": [{"name": "Backup", "events": [{"at": "2026-11-03T04:40:00Z", "state": "ok"}, {"at": "2026-11-04T04:40:00Z", "state": "planned"}]}]}
```
`at`: unix seconds or ISO date; `state`: `ok`, `error`, `running`, `planned`; `start` / `end` default to the events.

```progress
{"items": [{"label": "Disk /", "value": 66, "max": 80, "unit": "GB"}, {"label": "Quota", "value": 45, "max": 100, "format": "percent"}]}
```

### Code
```terminal
{"command": "npm test -- steps", "exit_code": 1, "duration_ms": 4200, "output": "FAIL src/checkout/steps.test.tsx\n  x keeps Apple Pay on top"}
```
The body may also be the raw output (no JSON). Clip long output to the useful part (~200 lines).

```diff
{"path": "{{WORKSPACE}}/projects/acme/topics/website/src/steps.tsx", "diff": "@@ -42,3 +42,3 @@\n-  <FreeShippingBanner />\n   <ApplePayButton />\n+  <FreeShippingBanner />\n"}
```
The body may also be a raw unified diff.

### Files and links
```file
{"items": [{"path": "{{WORKSPACE}}/projects/acme/topics/shop/attachments/2026-11/mug-cream.png", "caption": "Cream background"}]}
```
One file: `{"path": ..., "caption": ...}`. Images and videos get a preview, audio a player, PDF and other files a
card; a click opens the app's file viewer.

```link
{"url": "https://ui.example.com/products/mug", "title": "Hand-glazed ceramic mug", "description": "Product page updated with the new visual.", "site": "ui.example.com"}
```
Nothing is fetched: give the title and description yourself.

### Interactive
```form
{"title": "Campaign settings", "submit": "Send",
 "fields": [
  {"id": "audience", "label": "Audience", "type": "choice", "options": ["Existing customers", "New customers", "Both"], "default": "Both"},
  {"id": "budget", "label": "Ad budget", "type": "range", "min": 0, "max": 1000, "step": 50, "unit": "EUR", "default": 200},
  {"id": "start", "label": "Start", "type": "date"},
  {"id": "channels", "label": "Channels", "type": "multi", "options": ["E-mail", "Instagram", "Telegram"]}]}
```
Field `type`: `text`, `textarea`, `number`, `select` (dropdown), `choice` (one of a few, segmented), `multi`
(several, checkboxes), `checkbox` (yes / no), `range` (slider), `date`, `time`. `options`: strings or
`{"label", "value"}`. The answer arrives as your next user message, one `label: value` line per field.

```checklist
{"title": "Before sending on 10 Nov", "items": ["Pick the main visual", "Proofread the subject line", {"label": "Test the product link", "checked": true}]}
```

```app
{"title": "Price simulator", "height": 260, "html": "<label class='ui-label'>Price <input id=p class='ui-input' type=number value=29></label><p id=o class='ui-h2'></p><script>const p=document.getElementById('p'),o=document.getElementById('o');function f(){o.textContent=(p.value*0.88).toFixed(2)+' EUR'}p.oninput=f;f()</script>"}
```
A self-contained page in an isolated frame: inline `<style>` and `<script>` only, no network, no access to the
app, its cookies or the user's files. The app's colours are CSS variables (`var(--primary)`, `var(--card)`,
`var(--border)`...) and the UI kit classes (`ui-btn`, `ui-input`, `ui-card`, `ui-stat`...) are available.
`maxxing.send(text)` proposes `text` as the user's next message (they see it and confirm). The body may also be
raw HTML.

### Organisation
```created
{"title": "What I created", "items": [
  {"kind": "task", "title": "Proofread the launch email", "subtitle": "Acme - before 9 Nov", "id": "t_8f2a"},
  {"kind": "cron", "title": "Campaign report", "subtitle": "Every Monday 08:30", "id": "c_51bd"},
  {"kind": "notification", "title": "Mug stock under 20", "subtitle": "Sound + Telegram"}]}
```
`kind`: `task` (link to `/tasks?task=<id>`), `cron` (`/crons?job=<id>`), `notification`, `file` (`path`),
`session` (`id`), `project`, `extension`, `other` (`href`).

## Block plugins (new block types)

A user may want a block the app does not have (map, kanban, calendar, formula...). Build it as a **block
extension** (slug id, not the name of a built-in type). Like every creation it goes through the Atelier: write it in
the folder `pilot ext draft <id>` prints (not in `{{WORKSPACE}}/extensions/` directly), then propose it (below):

`block.json`
```json
{"type": "block", "name": {"en": "Kanban board", "fr": "Tableau Kanban"}, "version": "1.0.0",
 "renders": ["kanban"], "schema": "schema.json", "entry": "block.html", "icon": "kanban",
 "category": "organisation", "permissions": {"network": []},
 "hint": "Work split into columns of cards (to do / doing / done)."}
```
- `renders`: 1-8 block types (lowercase slugs, not a built-in type nor a code language such as `json`).
- `schema`: inline object or a `.json` file of the folder - JSON Schema subset: `type`, `properties`, `required`,
  `items` (schema or tuple), `enum`, `const`, `anyOf`/`oneOf`, `additionalProperties`, `min/maxItems`,
  `min/maxLength`, `minimum`/`maximum`. Anything else is refused. The data is checked before the frame gets it.
- `entry`: one self-contained HTML file (<= 512 kB, inline CSS / JS). It runs in a sandboxed frame (no cookies, no
  app API) that receives the data: `maxxing.onData(fn)`, `maxxing.theme`, `maxxing.onTheme(fn)`,
  `maxxing.resize(px)` (automatic otherwise), `maxxing.send(text)` (asks the user first), `maxxing.error(msg)`.
  Build the DOM with `textContent`, never `innerHTML` with the data.
- `permissions.network`: host names (`tiles.example.com`, max 8) the frame may reach over HTTPS - only after the
  user allows it; without consent the frame has no network at all.
- `hint`: the one line given to the agents (it appears in the CLAUDE.md section once the block is enabled).

The plugin appears in Settings -> Conversation blocks (and Settings -> Extensions); once enabled, its type joins
the list above (this skill is rendered again) and the Codex context. Example: `{{CODE_DIR}}/examples/extensions/kanban-block/`.

Test it with `pilot ext check <id> --dir <draft folder>` (`--json` for details) and fix until it exits `0`: it
validates block.json and the schema as the server does, checks that the frame is served, that every inline script of
the entry parses (`node --check`, lines of the entry file) and that it calls `maxxing.onData`. Then submit it with
`pilot ext propose <id> --summary "..."` and tell the user it waits for them in the Atelier: once they approve it,
answer with a ```kanban block to show it drawn.
