---
name: pilot-widgets-pages
description: Build a harness-pilot extension - a dashboard widget (a Card with stats, lists, charts, or a free-form HTML widget such as a game or canvas) or a full page with its own API - in <workspace>/extensions/<id>/. Use when the user asks for a new widget, a dashboard card, a mini-game, a custom page, an integration shown in the UI, or to fix an existing extension. Always the first choice before touching the product code.
---

# Extensions (widgets & pages)

Extensions live in `<workspace>/extensions/<id>/` (workspace from `pilot status`, here
`{{WORKSPACE}}`). Product updates never touch them and the memory backup includes them.

**Every creation goes through the Atelier**: you write it in a **draft folder** (`pilot ext draft <id>`), test it,
then submit it with `pilot ext propose <id>`. Nothing of it runs or shows on the dashboard until the user approves it
(each approval is a version the user can come back to). Do not write `<workspace>/extensions/<id>/` yourself: Codex
cannot, and a direct change by Claude is flagged "changed outside the Atelier" for the user to review. Steps below.

- **widget**: `manifest.json` + `api.py` with `card(ctx)` returning a **Card** (JSON). The UI draws
  it with the built-in design system - no HTML/CSS to write, consistent look guaranteed.
- **HTML widget**: `manifest.json` (`"type": "widget"`, optional `"height"`) + `widget.html` (one
  self-contained file) + optional `api.py` with `handle(...)`. For games, canvas, custom drawings:
  anything a Card cannot show. Drawn in a sandboxed frame (see below).
- **page**: `manifest.json` + `page.js` (ES module, `mount(el, ctx)`) + optional `api.py` with
  `handle(ctx, method, path, query, body)` served at `/api/ext/<id>/<path>`. Listed under
  "Extensions" in the sidebar; the user can pin it to get its own entry.

## Built-in Shopify widget
"Connect my Shopify store" needs no extension: guide the user to create a custom app in Shopify admin
(Settings → Apps and sales channels → Develop apps → Create an app → Admin API scopes `read_orders`
→ Install → reveal the `shpat_…` token) and to add `SHOPIFY_STORE` (`myshop.myshopify.com`) and
`SHOPIFY_ADMIN_TOKEN` in Settings → Keys. For more shop figures (products, ads, other platforms),
build extra widgets: they sit next to it on the dashboard.

## Which kind? (and never the product code)
| The user wants… | Build |
|---|---|
| numbers, lists, charts, status from some data source | widget with `card(ctx)` |
| a mini-game, a canvas, an interactive or custom-drawn card | HTML widget |
| a whole screen (form, board, editor, report) | page |
| a new kind of block inside answers (a map, a kanban board, a calendar drawn in the conversation) | a **block extension** (`block.json` + `block.html`): skill `pilot-blocks` |
| to change how the product itself behaves (a server rule, a CLI command…) and no extension can do it | a **core customization**: skill `pilot-customize` - never edit the code directory without it |

Extensions survive every update untouched. Say so to the user: they never need to wait for the
authors to add something an extension can do.

## Rules
- `id`: lowercase slug `^[a-z0-9][a-z0-9-]{0,47}$`, same as the folder name. Reserved:
  `activity tasks day crons server backup telegram shopify usage customize`.
- `name`: a string, or `{"en": "...", "fr": "..."}` to follow the UI language.
- `api`: always write `"api": 1` in the manifest (the extension contract version this extension is written
  for; the update preflight uses it to tell the user before a new version stops supporting it).
- `icon`: an icon name of the app's lucide set (`gauge`, `chart-line`, `shopping-cart`, `server`, `rss`, `users`,
  `receipt`, `calendar-days`, `package`, `star`…; the full list is `ICONS` in `<code dir>/web/src/components/ui/icon.tsx`,
  an unknown name shows a puzzle piece).
- **No emoji in the UI** (titles, list items, buttons): use icons - the Card list `icon`, `ctx.icon()` in a page.
- `api.py` runs inside the server process: **stdlib only** (urllib, json, sqlite3…), short timeouts
  (≤ 10 s), no threads left behind, never print secrets. It is called in a worker thread.
- Secrets: the user stores them in Settings -> Keys; read them with `ctx["secret"]("NAME")`
  (returns None when missing -> return a Card saying which key to add). Never hard-code a token.
- Persistent data: `ctx["state_dir"]` (a folder reserved for this extension).
- `ctx` = `{"id", "workspace", "state_dir", "secret": fn(name), "config": {"timezone", "language", "public_url"}}`.
- Widget results are cached `ttl` seconds (manifest, default 300); the card's refresh button forces it.

## Card schema
```
Card  = {title?, status?: "ok"|"warn"|"error", link?: "/route or https://…", blocks: [Block], updated?: unix}
Block = {type:"stat", label, value, hint?, delta?, tone?: "ok"|"warn"|"error"}
      | {type:"stats", items:[stat…]}
      | {type:"list", items:[{title, subtitle?, value?, href?, status?, icon?}], empty?: "text when no items",
         grid?: true}                                       grid = tiles side by side (shortcuts, examples)
                                                            icon = icon name (as the manifest), accent-coloured
      | {type:"chart", kind:"bar"|"line", series:[{name, points:[[x, y], …]}], unit?}
      | {type:"table", columns:[str], rows:[[cell, …]]}
      | {type:"progress", label, value, max, hint?}
      | {type:"markdown", text}
      | {type:"timeline", start, end, now?, lanes:[{name, sub?, color?, href?, dense?,
                         events:[{at, state?: "ok"|"error"|"running"|"planned", label?}]}]}
```
(`timeline`: unix seconds; one row per lane on a start..end axis - bookings, deliveries, shifts, runs.)
Unknown block types are dropped; the card must be JSON-serialisable.

## Minimal widget - `extensions/disk-usage/`
`manifest.json`
```json
{"id": "disk-usage", "name": "Disk usage", "type": "widget", "icon": "hard-drive", "version": "1.0.0", "span": 1, "ttl": 60}
```
`api.py`
```python
import shutil


def card(ctx):
    rows = []
    worst = 0
    for mount in ("/", "/var"):
        du = shutil.disk_usage(mount)
        pct = round(100 * (du.total - du.free) / du.total)
        worst = max(worst, pct)
        rows.append({"type": "progress", "label": mount, "value": pct, "max": 100,
                     "hint": f"{du.free / 1e9:.1f} GB free"})
    return {"title": "Disk usage",
            "status": "error" if worst > 95 else "warn" if worst > 85 else "ok",
            "blocks": [{"type": "stat", "label": "Fullest volume", "value": f"{worst}%"}, *rows]}
```

## Minimal page - `extensions/notes-board/`
`manifest.json`
```json
{"id": "notes-board", "name": "Notes board", "type": "page", "icon": "sticky-note", "version": "1.0.0"}
```
`api.py`
```python
import json
import time
from pathlib import Path


def _file(ctx):
    return Path(ctx["state_dir"]) / "notes.json"


def handle(ctx, method, path, query, body):
    f = _file(ctx)
    notes = json.loads(f.read_text()) if f.exists() else []
    if method == "GET" and path == "notes":
        return {"notes": notes}
    if method == "POST" and path == "notes":
        text = str((body or {}).get("text", "")).strip()[:500]
        if text:
            notes.insert(0, {"text": text, "at": time.time()})
            tmp = f.with_suffix(".tmp")
            tmp.write_text(json.dumps(notes[:200]))
            tmp.replace(f)
        return {"notes": notes}
    return {"error": "not_found", "message": f"{method} {path}"}
```
`page.js`
```js
export function mount(el, ctx) {
  el.innerHTML = `
    <div class="ui-page" style="max-width:640px">
      <h1 class="ui-h1">Notes board</h1>
      <form class="ui-row">
        <input class="ui-input" name="text" placeholder="New note" style="flex:1">
        <button class="ui-btn">Add</button>
      </form>
      <ul class="ui-list"></ul>
      <p class="ui-muted" hidden>No note yet: write the first one above.</p>
    </div>`;
  const list = el.querySelector("ul");
  const empty = el.querySelector("p");
  const form = el.querySelector("form");
  form.querySelector("button").prepend(ctx.icon("plus"));
  const render = ({ notes }) => {
    list.hidden = !notes.length;
    empty.hidden = !!notes.length;
    list.replaceChildren(...notes.map((n) => {
      const li = document.createElement("li");
      li.textContent = n.text;            // never inject data with innerHTML
      return li;
    }));
  };
  ctx.api("notes").then(render);
  const onSubmit = async (e) => {
    e.preventDefault();
    const text = form.text.value.trim();
    if (!text) return;
    render(await ctx.api("notes", { method: "POST", body: { text } }));
    form.reset();
  };
  form.addEventListener("submit", onSubmit);
  return () => form.removeEventListener("submit", onSubmit);
}
```
`ctx` in page.js = `{api(path, opts), navigate(route), theme, lang, t, icon(name)}` (`lang` = the UI language, "en"/"fr";
`icon("plus")` = an `<svg>` element of the app's icon set;
`navigate("/sessions?path=<topic path>&new=1&prompt=<text>")` opens a new session with the text typed in): `ctx.api` calls this extension's
own API (`/api/ext/<id>/<path>`) with the session cookie and CSRF header, and returns parsed JSON.
Always build the page with the **UI kit** (next section) so it looks like the rest of the app; use
`textContent`, not `innerHTML`, for any data.
The app only runs scripts from its own server: in page.js, no inline `<script>` added to the page and no `eval` /
`new Function` - import other modules of the folder instead (`import x from './x.js'`). HTML widgets are not
affected (their frame has its own policy).
A long page is split into files of its folder, imported with a **relative** path (`./lib/chart.js`): the app serves
the `.js`, `.mjs`, `.css` and `.json` files of the folder and its subfolders (no hidden file, no `api.py`, no link
out of the folder); CSS: `link.href = new URL("./page.css", import.meta.url)`; JSON: `import d from "./d.json" with
{ type: "json" }`. Editing any of these files gives the page a new version (picked up at the next visit). Keep the
page's data in `api.py` (`ctx["state_dir"]`), never in a `.json` file of the folder.

## UI kit - the app's look for pages and HTML widgets
Page extensions and HTML widgets get the app's design system as CSS classes (loaded for you, they follow the theme,
the accent colour and the density). **Use them instead of writing your own styles**: the result looks like the
app, in dark and light. Add CSS only for the layout specific to the page.
```
layout   ui-page (page column, max 1152 px) · ui-section · ui-grid (responsive cards) · ui-row · ui-stack · ui-spacer
text     ui-h1 (page title) · ui-h2 (section/card title) · ui-h3 · ui-text · ui-muted · ui-small · ui-label · ui-num
card     ui-card · ui-card-header (ui-icon-box + <div><h2 class="ui-h2">…</h2><p class="ui-muted">…</p></div>) · ui-card-footer
tile     <button class="ui-tile"><div class="ui-icon-box">{svg}</div><div><b>Title</b><span>one line</span></div></button>
icon     ui-icon-box (+ ui-lg, ui-neutral) - the icon on a soft square of the accent colour
button   ui-btn (main action) + ui-secondary | ui-outline | ui-ghost | ui-danger, + ui-sm, ui-icon-only
form     <label class="ui-field"><span class="ui-label">Name</span><input class="ui-input"><span class="ui-small">hint</span></label>
         ui-select · ui-textarea · ui-check (checkbox)
status   ui-badge · ui-dot  + ui-success | ui-warning | ui-error | ui-primary | ui-outline
data     ui-list (<ul>, rows) · ui-table (wide: inside a <div class="ui-table-wrap">) · ui-stat > ui-stat-label + ui-stat-value · ui-progress > <span style="width:40%">
other    ui-steps (<ol>, li > ui-step-num + <div>) · ui-callout (+ ui-info|ui-success|ui-warning|ui-error, svg first)
         ui-empty (empty state: ui-icon-box ui-lg ui-neutral, ui-h2, ui-muted, a ui-btn) · ui-skeleton (loading)
         ui-code · ui-kbd · ui-link (button styled as a link) · ui-separator
```
Rules of the app's design to keep: one main `ui-btn` per area (others `ui-outline` / `ui-ghost`), an empty list
shows `ui-empty` with one sentence and an action, data loading shows `ui-skeleton` blocks of the final size, colours
only from the theme variables (`var(--primary)`, `var(--muted-foreground)`, `var(--success)`… never hex), icons not
emoji. Example: `<workspace>/extensions/pages/page.js` (the "Your pages" page) and
`<code dir>/examples/extensions/notes-page/`.

## HTML widget - `extensions/snake-widget/`
Copy `<code dir>/examples/extensions/snake-widget/` (a working game) and adapt it. In widget.html:
- `maxxing.api(path, {method, body, query})` -> Promise of the JSON returned by this extension's
  `handle()`; `maxxing.resize(px)`; `maxxing.theme` + `maxxing.onTheme(fn)`.
- The UI kit above is already in the frame (`ui-card`, `ui-btn`, `ui-stat`…), and the theme variables too:
  `var(--card)`, `--foreground`, `--muted-foreground`, `--border`, `--primary`… (older names `--mx-fg`, `--mx-muted`,
  `--mx-border`, `--mx-accent`, `--mx-card`, `--mx-bg` still work). No icon helper in the frame: inline an `<svg>`.
- The frame is sandboxed (scripts yes, same-origin no): no cookies, no localStorage, no access to
  the app or `/api/...` - persist through `api.py` + `ctx["state_dir"]`. Only `widget.html` is
  served: inline CSS/JS, or load a library from a CDN with an absolute https URL.
- Keyboard games: make the canvas focusable (`tabindex="0"`) and start on click; add touch/swipe
  for phones.

## Steps
1. Ask what to show, where the data comes from, refresh rate, which secrets are needed.
2. Get the draft folder and write the files there; for API calls use `urllib.request` with `timeout=10`:
   ```bash
   pilot ext draft <id>            # prints the folder: <your session folder>/.atelier/<id>/
   ```
   For a change to an existing extension the folder starts as a copy of what runs now; for a new one it is empty.
   It already exists when you come back to it (`--reset` starts again from what runs).
3. Test it the way the server runs it, and fix until it passes:
   ```bash
   pilot ext check <id> --dir <draft folder>   # --json: steps, the first error, the card it computes, the files
   ```
   It loads the manifest and `api.py` (10 s limit), runs `card(ctx)` with the dashboard's 20 s limit through the
   same cleaning (dropped blocks of an unknown type are reported), checks an HTML widget's frame and every inline
   script (`node --check`, lines of widget.html), and a page's `page.js` and the modules it imports (served, parse,
   `mount` exported). Exit `0` = works (warnings allowed), `1` = broken: read `error` / the `trace` lines of your
   `api.py`, fix, run it again. Never propose it while it exits `1`. To try one route of a page's API, call
   `api.handle(ctx, 'GET', 'notes', {}, None)` from `python3 -c` in the draft folder.
4. Submit it to the user:
   ```bash
   pilot ext propose <id> --summary "Shows today's orders and revenue from the Shopify store."
   ```
   The summary is what the user reads first: what it does, in one or two plain sentences (for a change: what
   changed). Exit `1` = its check failed, nothing was submitted. Otherwise tell the user the creation is **waiting
   for them in the Atelier** (they see what it asks for - network hosts, secrets - and the files, then add it to the
   dashboard, ask for a change or refuse it). Do not say it is on the dashboard: it is not until they approve it.
5. A message starting with `[Atelier] The user asked for a change` is the user's review: make the change in the same
   draft folder, check it again and propose again (the new proposal replaces the old one).
6. To fix an existing extension, start with `pilot ext check <id> --json`: `runtime_errors` holds what broke for the
   user since its files last changed. Then `pilot ext draft <id>`, fix, check with `--dir`, propose.
7. Record the extension's purpose and data source in the topic memory (`memory` skill).

Do not test with `curl`: `/api/ext/<id>/...`, `/ext/<id>/...` and the dashboard need the user's signed-in
browser session (401 without it), and never ask for the password or a session cookie. `pilot ext check <id> --dir`
runs the same code as the server, `api.handle(...)` from Python tries one route, and `pilot update --verify` checks
every installed extension at once (with the customizations' checks: run after an update).
