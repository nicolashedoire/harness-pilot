# Extension isolation (design note, not built yet)

Extensions now declare what they use (manifest `"permissions"`, API.md#dashboard--extensions). Keys and the network
of HTML widget frames are enforced; everything else is shown, not enforced. This note plans the two stages that would
turn the declaration into a boundary: running `page.js` in a sandboxed frame, and running `api.py` outside the
server process as an unprivileged user. It gives the effort, the risks and a migration that never silently breaks an
extension that works today.

## What each part can reach today

| Part | Runs | Can reach | Limited by the permissions |
|---|---|---|---|
| HTML widget (`widget.html`) | sandboxed frame, opaque origin, no cookie | its own `handle()` through the bridge, its own files (frame token), the sites the user allowed | yes: frame policy (`api/extensions.widget_csp`) |
| Block plugin (`block.html`) | sandboxed frame | the hosts the user allowed | yes: `blocks.frame_csp` |
| Page (`page.js`) | **the app's own origin**, imported as a module (`pages/ext`) | the DOM of the app, its storage, and **every `/api` route with the user's session**: `fetch('/api/crons', {method: 'POST', headers: {'X-Maxxing': '1'}, credentials: 'same-origin'})` works, so a page can create a job that runs a shell command | no: the app's policy only limits where scripts come from (`script-src 'self'`); no `connect-src` |
| `api.py` (`card()`, `handle()`) | **inside the server process** (root on a Linux server), on the 4 extension threads | everything the server can: `import maxxing.vault`, `secrets.json`, any file, any host, `subprocess` | keys only, and only through `ctx["secret"]`: a careful guard against mistakes, not a wall |

The two "no" rows are the targets. A page is the bigger risk: it runs as the signed-in user in the browser. Stage A is
also the smaller job.

## Stage A - `page.js` in a sandboxed frame

**Shape.** `/x/<id>` hosts an `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups
allow-downloads">` (no `allow-same-origin`) on `/ext/<id>/page-frame`. That document is built like the widget frame:
- a bridge, then the UI kit, then `<script type="module">` importing `./page.js` through the frame token;
- `<base href="/ext/<id>/f/<token>/">` so relative imports, CSS and JSON keep working;
- the frame policy of `widget_csp` with the page's declared and allowed hosts.

The page keeps its contract (`export function mount(el, ctx)`). `el` becomes the frame's `<body>` container, and `ctx`
is rebuilt inside the frame on top of `postMessage`:

| `ctx` | In the frame |
|---|---|
| `api(path, opts)` | message to the host, which calls `/api/ext/<id>/<path>` only (the `extPath` rule of `HtmlWidget.tsx`) and replies; an error keeps `status` and `mxExt` for the runtime error report |
| `navigate(route)` | message; the host accepts an app route only (`/` + not `//`, no scheme), then `navigate()`; the `/sessions?...&prompt=` route still only fills the composer |
| `theme`, `lang` | in the URL fragment at load, then `theme` messages (as for widgets) |
| `t(key)` | synchronous: the host sends the core dictionary of the current language at load (one message of a few tens of kB); unknown key -> the key |
| `icon(name)` | synchronous: the bridge loads the app's icon set once (`/ext/_kit/icons.json`, the `ICONS` of `components/ui/icon.tsx`: name -> SVG paths, public, cached) and builds the `<svg>` |
| (new) `resize` / height | the frame fills the page area and scrolls inside; no resize needed |
| (new) `location` | `ctx.route` (the part after `/x/<id>`) and `ctx.setRoute(sub)`, mirrored in the app URL, for pages with their own views |

**What would break** in a page written for the app's origin. `pilot ext check` can flag most of it statically, and
does so before anything moves:
- `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`: the opaque origin has none, so they throw. Save
  through `api.py` instead, or a later `ctx.storage` brokered to `state_dir`.
- `fetch('/api/...')` or `fetch('/ext/...')` called directly: no cookie, so 401. Use `ctx.api`. This is the point of
  the change.
- `document.querySelector` outside `el`, `window.parent`, app globals, the app's CSS classes other than the UI kit.
- `history` and `location` used for routing: replaced by `ctx.route` / `ctx.setRoute`.
- `navigator.clipboard`: needs `allow="clipboard-write"` on the frame.
- `a[download]` with a blob URL: needs `allow-downloads`.
- `window.open`: needs `allow-popups`.
- `alert` / `confirm`: need `allow-modals`.
- App keyboard shortcuts do not fire while the focus is in the frame; the page's own ones keep working.

**Effort:** about 5 days.

| Work | Days |
|---|---|
| Server: `page-frame` route reusing the widget frame code, icons JSON, extcheck patterns | 1 |
| Bridge (`ctx` above, errors to exterrors, focus) | 2 |
| Web host (`pages/ext`: frame, route mirroring, the trusted switch below) | 1 |
| Skill, docs, mock, tests, a check in Chrome and Safari | 1 |

**Risks:**
- Pages that rely on the app's DOM or storage. Mitigated by the migration below and the static check.
- Safari's handling of `'self'` in a sandboxed document (checked only in Chrome so far, for widgets).
- Focus and accessibility across the frame boundary.
- A heavy page loses nothing measurable: one frame, same modules.

**Interim step A0 (optional, about 1 day):** before frames, the app page's own policy can learn which sites pages
reach. A `Content-Security-Policy-Report-Only: connect-src 'self'` with a `report-uri`, the same mechanism as
grandfathered widgets, records them. Later, `connect-src 'self' <recorded and declared hosts>` limits exfiltration
from a page. It does not remove the session access, so it is no substitute for stage A.

## Stage B - `api.py` out of process, as an unprivileged user

**Shape.** One long-lived host process per enabled extension that has Python code, started by the server on first use
and stopped after `idle` minutes. It runs a stdlib-only runner (like `sessions/runner.py`) that imports `api.py` and
answers JSON-lines requests on its stdin/stdout:
- `{id, op: "card"|"handle", args}` -> `{id, ok, value}`, or `{id, ok: false, error: {type, message, frames}}`. The
  frames are the ones inside the folder (exterrors already wants those).

`ctx` becomes a proxy:
- Plain fields (`id`, `workspace`, `state_dir`, `config`) are sent with each call.
- `ctx["secret"](name)` is a request from the host back to the server. The server answers through
  `permissions.check_secret`, so the server holds the decision and the host never sees `secrets.json`.
- `ValueError` / `LookupError` / `PermissionDenied` keep their HTTP meaning: the type travels with the error.

**Confinement on a Linux server:**
- A system user `maxxing-ext`. The host runs in a transient unit (`systemd-run --uid`, the pattern of the turn units
  in `sessions/spawn.py`) with:
  - `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`;
  - `BindPaths=<state>/extensions/<id>` (writable, owned by `maxxing-ext`);
  - `BindReadOnlyPaths=` for the extension folder and each declared `read` path, so `read` becomes enforced;
  - `MemoryMax`, `TasksMax`.
- Network: `IPAddressDeny=any` plus `IPAddressAllow=` for the loopback port of a small HTTP(S) CONNECT proxy run by
  the server. The proxy lets through only the extension's declared and allowed hosts, which enforces `network` for
  `api.py`. `urllib` honours `HTTPS_PROXY`; code that opens raw sockets fails closed.
- On a local Mac install there is no second user without root. There the host is a plain child process: crash and
  hang isolation, the server-side `ctx.secret`, and the proxy as a convention, but no file or network boundary. The
  docs must say so.

**Performance:**

| Cost | Measure |
|---|---|
| Starting a host | about 50-150 ms (Python start-up plus the extension's imports), paid once while it stays warm |
| One call | under 1 ms of JSON on a pipe (a Card is a few kB) |
| Memory | about 15-25 MB RSS per host: 10 extensions with Python code use about 200 MB while warm |

The dashboard computes widgets in parallel, so separate processes help rather than hurt. Mitigations:
- Start lazily.
- Stop idle hosts.
- Warm the dashboard's visible widgets at server start.

A stuck `card()` can finally be killed (today it holds one of the 4 extension threads until it returns).

**State access:**
- `state_dir` is chowned to `maxxing-ext` once.
- Module-level state (caches, a session object) lives as long as the host, as it lives as long as the server today.

What stops working:
- `import maxxing` (server internals);
- writes outside `state_dir`: a page that saves into `projects/...` today; a later `write` permission could bind such
  paths writable;
- files read without a `read` declaration;
- threads expected to outlive a call after an idle stop.

**Effort:** about 2-3 weeks.

| Work | Days |
|---|---|
| Runner, protocol, lifecycle, timeouts and kill, error frames | 4 |
| systemd unit, user, `state_dir` migration, hardening probe | 3 |
| Egress proxy with the host allowlist | 3 |
| Mac fallback | 1 |
| extcheck (both modes, differences), Atelier and Settings states, docs, tests | 4 |

**Risks:**
- Memory on small servers.
- First-load latency.
- Libraries that ignore the proxy.
- Extensions that write in the workspace or import `maxxing`.
- Debugging across processes. The error frames already travel, and `pilot ext check` runs the same host.
- A shared host for all extensions would save memory but lose isolation between them: keep one host per extension.

## Migration (both stages)

The rule of the permissions work holds: an extension that works today keeps working, and the user sees which ones
are not isolated.

1. **Opt-in.** The manifest gets `"runtime": {"page": "frame", "api": "process"}`. The skill writes it for new
   extensions, the Atelier shows it, and `pilot ext check` runs both modes and reports any difference. The extension
   API version goes up (`EXT_API` 2, `EXT_API_MIN` stays 1).
2. **Default for new extensions.** A new extension with declared permissions runs isolated unless its manifest asks
   otherwise. An extension that existed before stays in its current mode, shown as "runs with your session" (page)
   or "runs inside the server" (`api.py`) in Settings and the Atelier. The static check lists what would break if it
   moved. The Atelier offers **Try isolated**: a preview in the isolated mode, then approve.
3. **Explicit trust.** After a few releases, the in-app or in-process mode requires a per-extension **Trusted: runs
   with your session / inside the server** switch, set by the user in the Atelier (never by an agent). The update
   preflight lists the extensions still trusted, the same way it lists extensions built for an older API.
4. **Removal.** Only when no bundled example or template needs it, and announced in the upgrade notes:
   `EXT_API_MIN` 2.

Order: A0 (optional), then A, then B. A and B are independent and can ship separately. Each step is one mini PR with
its contract change first (API.md, INTERNALS.md), as for the permissions.
