# UI design & frontend rules (v2)

How the web app is built and how to add to it without breaking the look or the feel. Read this before writing a
page. Code lives in `web/` (React 19 + TypeScript strict + Vite + Tailwind v4 + Radix + TanStack Query + Zustand).

```
web/
  index.html               theme bootstrap script (no flash): theme, cached palette CSS (`mx-theme`) — mirrors src/stores/ui.ts
  vite.config.ts           dev proxy /api + /ext → MAXXING_API (default http://127.0.0.1:8801)
  mock/server.mjs          zero-dependency mock of the whole API (port 8809, scenarios) — see "Mock"
  src/
    main.tsx  App.tsx      providers (QueryClient, Tooltip, Router, ConfirmHost, Toaster)
    routes.tsx             THE route table (lazy pages)
    pages/Root.tsx         boot gate (setup / login / onboarding redirects)
    pages/<page>/index.tsx one folder per page (default export = page component)
    features/<domain>/     building blocks shared by onboarding and settings (Claude, Telegram, backup…)
    components/ui/         the design system (import from '@/components/ui')
    components/shell/      app shell: Sidebar, TouchNav (touch layout), Page/PageHeader, CommandPalette, Health…
    commands/              palette registry + keyboard shortcuts
    lib/api.ts types.ts    HTTP client + every API.md payload type
    lib/queries/*.ts       React Query hooks per domain, query keys in keys.ts
    lib/sse.ts             useEventSource() + global bus (/api/stream)
    stores/ui.ts           persisted UI prefs (theme, palette, density, fonts, language, sidebar, presentation, tourDone)
    lib/theme/             the theme engine (pure: tokens, bases, accents, derive, validate, css, share) - see §1 "Themes"
    pwa/                   service worker registration, update toast, install prompt / iOS dialog
    tour/                  guided tour (steps.ts = the script, Tour.tsx = overlay + card)
  sw/sw.js                 service worker source (emitted as dist/sw.js by the `maxxing-sw` plugin)
  public/                  manifest.webmanifest, offline.html, icons/ (PNG, from scripts/gen-icons.py)
    i18n/{en,fr}.ts        dictionaries; useT()
    styles/globals.css     tokens (CSS variables) + markdown + highlight theme
```

Commands: `npm ci`, `npm test` (unit tests of `src/lib/theme` in `web/tests`, plain Node), `npm run dev` (Vite on :5173, `MAXXING_API=http://127.0.0.1:8809 npm run dev` for the mock),
`npm run build` (`tsc -b` + `vite build` → `web/dist`, committed), `npm run mock` (serves `dist` + fake API on :8809).
Tailwind finds class names by scanning `web/` (minus what `.gitignore` ignores) **except** the committed build: `globals.css` has `@source not "../../dist"`, so a class removed from `src/` leaves the CSS at the next build (one build is enough, a second one changes nothing). Add an `@source not` there for any other generated folder under `web/` that is not git-ignored.

## 1. Tokens

All colours are CSS variables in `styles/globals.css`, exposed to Tailwind through `@theme inline`
(`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`…). **Never hard-code a colour** — the only
exceptions are chart series (`--series-1..6`) and brand-neutral swatches in the accent picker.

| Token | Use |
|---|---|
| `background` / `foreground` | page |
| `card`, `popover` (+ `-foreground`) | raised surfaces (cards / menus, dialogs) |
| `muted` / `muted-foreground` | subtle fills, secondary text |
| `accent` / `accent-foreground` | hover & selected rows (neutral, NOT the brand colour) |
| `primary` / `primary-foreground` | the accent colour: links, focus ring (`ring`), selection, active nav indicator, unread / running dots, accent-tinted highlights (`bg-primary/10`); `primary-foreground` = text on a solid `bg-primary` (badges, counts) |
| `action` / `action-foreground` | filled buttons and checked controls: `Button` default variant, `Switch` (checked), `Checkbox` (checked), custom checkboxes / radios, the toast action button, `accent-color` of native checkboxes / radios / range inputs. The accent (`primary`, or a deeper / lighter step that carries its label at 4.5:1) or monochrome (`foreground` on `background`) with the palette's neutral buttons |
| `secondary` | secondary buttons, segmented/tab active background |
| `destructive`, `success`, `warning` | status (use at /10–/15 opacity for fills, solid for dots & text) |
| `border`, `input`, `ring` | hairlines, input borders, focus |
| `sidebar`, `sidebar-border`, `overlay` | shell & modal backdrop |

- **Colours come from the user's palette** (a Theme object, "Themes" below): `src/stores/ui.ts` writes every token
  into `<style id="mx-theme">` (`html:root` / `html:root.dark`, which outranks `:root` / `.dark`) and caches that CSS
  (localStorage `mx-theme`) for the inline script of `index.html`, which injects it before the first paint.
  `globals.css` keeps the default palette (Zinc & blue) as the fallback before any palette exists; `web/tests` checks
  that both stay equal. Dark is the default (`.dark` on `<html>`), light and system are available. `data-base`,
  `data-buttons`, `data-tint` and `data-accent` (the nearest named accent) on `<html>` say what is shown; no CSS
  depends on them.
- **Never pick between `primary` and `action` by look**: a filled control the user clicks or checks is `action`;
  a mark that points at something (link, dot, focus, current item) is `primary`. The notification marks keep their
  tokens (unread / activity dots and the selected row `primary`, "To handle" counts `destructive`); their buttons,
  switches, checkboxes and the volume slider are controls (`action`).

- **Fonts**: 23 interface fonts in groups (`FONT_GROUPS`: modern, character, rounded, serif, readable, mono, system; default `inter`) and 11 code fonts (default `system`) (`lib/fonts.ts`, mirrored in the `index.html` inline script, all bundled with `@fontsource-variable`; only Inter is in the entry CSS, the others are loaded on demand by `loadFont`, applied as `--mx-font-sans` / `--mx-font-mono` on `<html>`).
- **Radius**: `--radius` 10 px → `rounded-sm/md/lg/xl`. Cards `rounded-xl`, controls `rounded-md`.
- **Spacing**: Tailwind's 4-px scale only (`gap-2` = 8 px…). Card padding = `var(--pad-card)` (20 px comfortable,
  14 px compact — `data-density`).
- **Type**: Inter Variable (self-hosted, `@fontsource-variable/inter`), body 14 px / 1.5. Scale: page title 15–16 px
  semibold (header), section title 20 px, card title 14–15 px medium, body 14, secondary 13, meta 11–12.
  Numbers in columns use `tabular-nums`; big standalone figures do not.
- **Focus**: every interactive element shows a 2 px `ring` on `:focus-visible`. Never remove it.
- **Motion**: 100–220 ms (`animate-in`, `animate-sheet-up`…). `prefers-reduced-motion` disables all animation
  globally — do not add JS animations that ignore it.
- **Icons**: `lucide-react`, 16 px in controls (`size-4`), 18–20 px in navigation. No emoji in the UI.
  Widgets/extensions name icons in kebab-case; `<NamedIcon name>` renders the curated set in
  `components/ui/icon.tsx` (unknown → puzzle). Add names there when needed (keeps the bundle small).

### Themes (palettes)

A palette is a versioned, serializable **Theme** object (`src/lib/theme/model.ts`; the presets, the user's choice,
exported / imported files, the server's `look.palette`):

```json
{ "schema": 1, "id": "night-owl", "name": "Night owl", "description": "…", "author": "…",
  "base": "zinc" | "graphite" | "marine" | "custom", "accent": "blue" | … | "#14b8a6",
  "buttons": "accent" | "neutral", "tint": "neutral" | "tinted",
  "tokens": { "light": { "background": "#f3fbfa" }, "dark": { "card": "#0b1f29" } } }
```

- **Tokens** (`tokens.ts`, mirrored by `server/maxxing/themes.py` `TOKENS`): `background foreground card
  card-foreground popover popover-foreground primary primary-foreground action action-foreground secondary
  secondary-foreground muted muted-foreground accent accent-foreground destructive destructive-foreground success
  warning border input ring sidebar sidebar-border overlay`. `tokens` holds explicit values only; every missing token
  is derived (`derive.ts`): base surfaces (tinted with the accent hue or not) -> status colours -> accent -> action.
  A fill set without its foreground gets black or white.
- **Bases** (`bases.ts`, light and dark each): `zinc` (the historical neutrals, default), `graphite` (deeper, slightly
  cooler greys, hue 260; dark: bg `oklch(0.15 0.003 260)`, sidebar 0.179, card 0.201, hover 0.245, border 0.287),
  `marine` (navy: dark bg `#0b1220`, sidebar `#0e1628`, card `#121c32`, hover `#18243d`, border `#1f2c47`, text
  `#eef3fb`, muted text ≈`#94a3b8`; light: bg `oklch(0.98 0.007 255)`, white cards, navy text), `custom` (surfaces
  from `tokens`, zinc for the missing ones). **Tinted** keeps the base's lightness ladder and takes the accent hue
  at low chroma (dark borders: a tinted white at 8-15 % alpha).
- **Accents** (`accents.ts`): the 6 named swatches (a seed per mode + the label each prefers on a fill) or any colour
  (`#rrggbb`, seed = that colour in both modes, white label when white reaches 3:1 on it). One rule for both:
  `primary` = the seed with its OKLCH lightness moved (darker in light, lighter in dark) until it reads at 4.5:1 on
  background / card / popover / sidebar; `primary-foreground` = white when it reaches 4.5:1 on primary, else the one
  of black / white that contrasts most; `action` (accent buttons) = the seed under its preferred label, lightness
  moved until the label reaches 4.5:1; `ring` = primary. The settings warn (never block) when the picked colour
  itself is under 3:1 on the light or dark background. Manifest / app icon of a custom accent: the nearest named
  accent (`nearestAccent`); `theme-color` = the palette's page background.
- **Buttons**: `accent` (action = the accent step above) or `neutral` (action = `foreground`, action-foreground =
  `background`).
- **Presets** (`model.ts` `PRESETS`, names in i18n `colors.preset.<id>`): `zinc` = Zinc & blue (zinc, blue, accent
  buttons; the default), `graphite` = Graphite (graphite, blue, neutral buttons), `marine` = Marine (marine,
  `#2d6efd` from the logo, accent buttons), all with a neutral background. Changing any part in the settings makes
  the palette `custom` (or the preset it now equals) and drops the explicit tokens of that part (`stores/ui.ts`
  `editedPalette`); the last custom palette is kept per browser ("Custom" brings it back).
- **Validation** (`validate.ts` `normalizeTheme`, mirrored for the structure by `server/maxxing/themes.py`
  `clean_theme`): unknown keys dropped; `schema` must be 1 (missing = 1); `id` `[a-z0-9-]{1,48}` else `custom`;
  `name` ≤ 60, `description` ≤ 280, `author` ≤ 60 characters, control characters and `< >` removed; `base`,
  `buttons`, `tint`: known values else the default; `accent`: a named accent or a colour (stored `#rrggbb`); a file is
  16 KB at most. **Token values are colours only**: `#rgb #rgba #rrggbb #rrggbbaa`, `rgb()/rgba()`, `hsl()/hsla()`,
  `oklch()` with numbers (`%`, `deg`, an optional `/ alpha`), 64 characters at most; anything else (`url(`, `var(`,
  keywords, `;`, braces…) is refused and reported (the browser drops it; the server answers 422).
- **Contrast** (`CONTRAST_PAIRS`, light and dark): text ≥ 4.5:1 (foreground on background / sidebar, card and
  popover foregrounds, muted-foreground on background / card / muted / sidebar, secondary and accent foregrounds,
  primary / action / destructive foregrounds on their fills, primary on background / card (links), destructive on
  background / popover); UI parts ≥ 3:1 (ring on background, primary on sidebar, success and warning on
  background). A failing primary / action / destructive foreground is replaced by black or white (`report.fixed`);
  every other failure is reported (`report.issues`, shown in the settings and the import dialog), never blocking.
  Every preset combination (3 bases × 6 accents + the Marine blue × 2 button styles × 2 backgrounds × light / dark)
  passes: `web/tests/theme.test.ts`.
- **Storage and sync**: the palette lives in the UI store (`mx-ui`, `palette`, compacted: explicit tokens equal to the
  derived ones are dropped) and in the server's `look` (`PUT /api/settings/look`, API.md). `look.rev` grows with each
  palette change; a signed-in browser adopts a palette with a higher `rev` unless its own change is still pending
  (`palettePending`, sent again on the next start), at boot and live (bus topic `look` -> the auth state is
  refetched). A browser keeps its palette until the user changes one somewhere (migrated browsers start at `rev` 0).
  Theme, fonts and density stay per browser.
- **Untrusted themes, one door** (`src/features/themes/`): a theme from a file, a pasted code, a model (the theme
  generator) or a Team contact is always `normalizeTheme`d before it is previewed, saved or applied, shown in the
  review dialog (`ReviewDialog.tsx`: scoped `PalettePreview` in light / dark + `ThemeChecks` = colours only / contrast /
  automatic fixes in words) and applied only by the user's click (`setPalette`). Previews put the tokens as CSS
  variables on the preview element's `style` (`tokenStyle`), never into a `<style>` built from strings. The server
  validates the structure again (`themes.clean_theme`) wherever it stores, returns or relays one.
- **Export / import** (Settings -> Appearance): export writes `<name>.theme.json` with every token of both modes
  (`expandTheme`: the file does not depend on this version's tables, `downloadTheme`); import (button or drop zone of
  My themes) = `parseThemeFile` (16 KB) -> review dialog. **Theme code** (`lib/theme/share.ts`): `theme1:` +
  base64url of the compact theme JSON (explicit tokens only: short enough for a chat), `themeCode()` /
  `parseThemeText()` (also takes raw JSON; the decoded text goes through `parseThemeFile`); "Copy the theme code" in
  the share dialog, "Paste a code" in My themes. `sameLook(a, b)` = the same derived colours in both modes (the
  "Active" mark).
- **My themes** (`MyThemes.tsx`): the presets + the saved themes of the server (`/api/settings/themes`, 50 at most,
  the same on every device, bus `themes`), each with apply (click on its drawing), share, rename, delete; "Save the
  current palette" when the palette is neither a preset nor saved. Sources: `created` (theme generator), `imported`
  (file or code), `received` (Team, with the sender's name), `custom` (composed in the settings).
- **Share** (`ShareDialog.tsx`): to a Team contact or group (`POST /api/team/chats/{cid}/themes`, the DM created if
  needed; the theme normalized and named before it leaves), the file, the theme code; "Publish to the public gallery"
  is shown disabled with a *Soon* badge. In a chat, a theme message is a card (`TeamCard.tsx`: light + dark
  drawings, name, description, contrast line, **Install** -> the review dialog); it never applies itself.
- **Theme generator** (`Creator.tsx`, `/settings/appearance?create=1&session=<id>`): the user's words (+ up to 3
  images, uploaded to the topic) start a session in the topic `projects/system/topics/themes` (created on first use,
  with its project) whose first message asks for the skill `pilot-theme` (`skills/pilot-theme`: schema, tokens,
  rules, contrast, `check_theme.py`); refinements (chips More contrast / Neutral buttons / Cooler / Light version, or
  free text) are follow-up messages to the same session. When the turn ends, `GET
  /api/settings/themes/session/{id}?since=` returns the newest `*.theme.json` the session wrote (validated);
  `since` = the shown proposal's file time (server clock), so a refinement only shows a newer file. States: empty,
  working (skeleton + "Open the session"), proposal (`ThemeSample` with the navigation column, `SwatchStrip`, the
  agent's summary, Apply / Save to my themes / Discard), none / refused / session error (with Ask again).

## 2. Components (`@/components/ui`)

| Component | Notes |
|---|---|
| `Button` | variants `default` (filled, `action` tokens) `· secondary · outline · ghost · destructive · link`, sizes `default · sm · lg · icon · icon-sm`. `loading` shows a spinner **without changing the width**. 44 px tall on mobile automatically. |
| `Input`, `Textarea` (autosize `minRows/maxRows`), `SecretInput` (show/hide), `Label` | inputs are 16 px on touch screens (no iOS zoom), 14 px with a fine pointer. |
| `FormField` | label + one control + hint/error; wires `id`, `aria-describedby`, `aria-invalid`. |
| `Select` (shorthand `options`), `Combobox` (`@/components/ui/combobox`, not in the barrel: searchable, long lists; `options` may be a function built on open), `Segmented` (2–5 exclusive options), `Switch`, `Checkbox` | `Switch` / `Checkbox` checked = `action` tokens (the palette's button style) |
| `Card*`, `Badge` (`default · secondary · outline · success · warning · destructive · muted`), `Separator`, `Kbd` + `MOD` | |
| `Dialog*` | centered on desktop, **bottom sheet on mobile** (swipe down to close, `ui/sheet-drag.ts`). |
| `AlertDialog*` + `confirm({title, description, destructive, confirmText, typeToConfirm})` | `await confirm(...)` → boolean. `typeToConfirm` for irreversible actions (restore…). |
| `Sheet*` | side drawer (right/left) on desktop, bottom sheet on mobile; `side="bottom"` everywhere. Bottom sheets close with a swipe down (handle, header, or content scrolled to the top; `data-no-drag` opts an element out). |
| `DropdownMenu*` (`destructive` items), `Popover*`, `Tooltip` (shorthand `content`), `Tabs*`, `ScrollArea` | Radix-based, keyboard accessible. |
| `Skeleton`, `SkeletonText`, `Spinner`, `EmptyState`, `ProgressBar`, `StatusDot` | see §4. |
| `toast.success/error/info` + `<Toaster/>` (sonner) | bottom-right desktop, top-center mobile. |
| `CodeBlock` (block or `inline` one-liner with copy), `CopyButton` | |
| `Markdown` (`@/components/ui/markdown`, lazy-load it) | GFM, highlight.js, raw HTML escaped, unsafe URLs dropped, `/routes` via the router, external links `noopener noreferrer nofollow` in a new tab, code blocks with copy. `onLink(href)` to rewrite links (docs). |
| `QRCode` (`@/components/ui/qr-code`, not in the barrel) | client-side SVG (uqr). |
| `Avatar`, `NamedIcon`, `initials()` | |
| `Sensitive`, `useMask()`, `usePresentation()` | presentation mode, see §6. |

Shared feature blocks (`src/features`): the theme blocks of `features/themes` (§1 "Themes"), `Callout` (inline result/explanation, tones success/error/warning/info),
`Steps` (numbered instructions), `OptionCard` (radio card; `media` puts a logo tile first and the radio mark last, as the new session's agent modes), `SettingRow` (label left, control right), and the
domain components reused by onboarding **and** settings: `ClaudeConnect`, `ClaudeDefaults`, `CreateProjectTopic`
(+ `SlugPreview`), `TelegramSetup` (+ `ThreadList`), `BackupSetup` (+ `BackupWhy`), `RegionFields`.

**Conversation blocks** (`src/features/blocks`, API.md#conversation-blocks): `components/ui/markdown.tsx` asks the eager
`fence.tsx` whether a fence is a block, then mounts the lazy `BlockFence` chunk (with the `blocks` dictionary group).
Every renderer uses `BlockShell` (header: type icon, title, source · body · footer actions) and the fallback card
`BlockNotice`; its root carries `.mx-block` (`blocks.css` hands the markdown element styles back to Tailwind inside
it). Block data is model output: rendered as text only (never `dangerouslySetInnerHTML`), links through the safe
checks, HTML only inside the sandboxed frames. Sending to the conversation goes through `useSendToSession` (shows the
exact text, asks). The conversation view hooks in with `<BlockHostProvider value={{sessionId, send?, openPanel?,
agent?}}>` (`features/blocks/host.tsx`): each session column provides it (its `send` shows the message as sent at once
and resolves to false when it failed, its `openPanel` is the column's block panel, `pages/sessions/BlockPanel.tsx`);
without it the blocks find the session from `[data-mx-session]` / the URL and open their own side drawer
(`mx-block-open` window event too). `BlockFence panel` draws a block at its large size. Settings -> Conversation blocks
(`pages/settings/sections/Blocks.tsx`) lists, toggles and explains the plugins.

## 3. Layout rules

- **Two layouts**, decided once by `html[data-compact]` (`stores/media.ts` `isCompact()` / `useCompact()`, copied in
  `index.html` before the first paint): **desktop** (sidebar 232 px, collapsible to 60 px icons — auto-collapsed in
  a 768–1023 px window) and **touch** (phones, tablets = `(pointer: coarse) and (hover: none)`, any window < 768 px;
  Settings → General → Layout forces it per device). The Tailwind variants `md:` / `max-md:` are redefined in
  `globals.css` on that attribute (not on the width): `md:` = desktop layout, `max-md:` = touch layout. `sm:`,
  `lg:`, `xl:` stay width breakpoints.
- **Touch layout** (`components/shell/TouchNav.tsx`): no sidebar, no tab bar. Every top bar has ☰ on the left
  (`TouchSessionsButton`: sessions drawer = `SessionTree touch`, `pages/sessions/SessionsPanel.tsx`) and ⊞ on the
  right (`TouchAppButton`: app drawer = every entry of the sidebar). Drawers = `components/ui/drawer.tsx` (side
  panels on phones too, swipe back to close); any navigation closes them; edge swipes open them in the installed app.
  `/sessions` always shows one session full screen (the last one). Row menus open with a long press
  (`lib/long-press.ts`). A new sidebar entry must also appear in the app drawer.
- `<main id="main">` is the only scroll container
  (`scrollbar-gutter: stable` → no horizontal jump when content grows).
- **Every page** renders `<Page title description actions width>` (sticky header + centered body,
  `width` = `narrow 768 · default 1152 · wide 1600 · full`). Full-bleed pages (Sessions, Files) render
  `<PageHeader>` + their own body. The header **is** the top bar in the touch layout
  too (☰ on the left, ⊞ on the right): never add a second top bar.
- Page actions: ≤ 3 visible buttons; on mobile use icons (`<span className="max-sm:hidden">label</span>`) or a "…"
  `DropdownMenu`.
- Settings-like pages: stacked `SettingsCard`s (`grid gap-6`), danger zone last (`danger` prop).
- **Density**: rows 40 px comfortable / 32 px compact (`--row-h`); lists use `divide-y` inside a bordered card.
- Responsive targets: 375 / 768 / 1280 / 1920 px. Test at least 375 and 1280.

### Conversation view (Sessions)
- One header per session (breadcrumb project › topic, title, agent + model chip, context gauge in %, **…**, close);
  the Sessions page renders no `PageHeader` on a computer: the list's title row holds its actions. On `/sessions*`
  the sidebar is folded into a 64 px icon rail (`components/shell/rail-store.ts`; nav items 44 px).
- Reading column `--mx-read` = 740 px (set on the column, `none` once widened by hand); thread, composer and banners
  use `max-w-(--mx-read,…)`.
- `pages/sessions/Turn.tsx` groups items into turns: agent header (`AgentIcon` + name + time), runs of tool calls and
  thoughts folded into one activity line (expandable rows with +/-, diff / output on demand), the answer
  (`Markdown` with `.mx-answer`, styles in `pages/sessions/conversation.css`), written-file cards, a footer
  (duration · cost, copy, new session; model / tokens / cache in its tooltip). Rows are memoised on item identity.
- States at the end of the thread are cards (`tail`): plan to approve, failed turn (Retry; the last turn's error notes
  are then not shown, the card carries the error), agent question. A paused discussion ends with a dated separator
  (`PauseSeparator`: "Paused at 03:12 · limit of 20 replies").
- Conversation blocks in an answer keep the body type (14 px / 1.5, `[data-mx-block]` in `conversation.css`); the
  media paths of a block fence are not repeated as thumbnails under the message (`stripBlockFences`). "Open beside"
  docks the block on the right of the conversation in a tabbed panel when the column is at least 1040 px wide (the
  thread and the composer narrow), else opens it in a sheet (bottom sheet on a phone).
- Agents: `features/agents/AgentIcon.tsx` (`role="img"`, product names never translated). Discussion lanes use
  `--agent-claude` / `--agent-codex` (chart series slots, defined in `conversation.css`).
- Filled buttons (send, approve, retry, new session) are the shared `Button` so they follow the palette.

### Mobile
- Inputs 16 px (automatic), touch targets ≥ 44 px (buttons do it automatically below `md`), `Dialog`/`Sheet`
  become bottom sheets, respect `--safe-top/bottom/left/right`.
- iOS zooms into any field under 16 px when it gets the focus. `globals.css` forces 16 px with `!important` on
  touch screens (`pointer: coarse`) for inputs, textareas, selects and `contenteditable` (the code editor), so a
  `text-xs` / `text-[13px]` on a field is harmless there - never rely on a smaller size on mobile.
- No page zoom on touch screens (owner's decision, 2.0.0a77): `html { touch-action: pan-x pan-y }` (no double-tap,
  no pinch), viewport `maximum-scale=1, user-scalable=no`, and `lib/mobile-viewport.ts` cancels iOS Safari's pinch
  (`gesturestart` / two-finger `touchmove`), which ignores the viewport in a tab. The viewport has `interactive-widget=resizes-content` (Android: the keyboard resizes the page).
- Keyboard (`lib/mobile-viewport.ts`, touch screens): `html[data-kbd]` while a field has the focus sets
  `--safe-bottom` and `--safe-bottom-ui` to 0; `--kbd-inset` (bottom of the
  layout covered by the iOS keyboard) and `--vvh` (visual viewport height) keep bottom sheets above the keys. Fixed
  bottom elements use `bottom-[var(--kbd-inset)]` when they hold a field. The document never scrolls: iOS leaves it
  scrolled after the keyboard or a return from the background, so it is put back at 0.
- Closing animations: `data-[state=closed]:animate-sheet-down` / `animate-overlay-out` / `animate-out` (Radix keeps
  the element until the animation ends).
- Full-screen layers of the installed app (session on a phone) go back with a swipe from the left edge
  (`lib/edge-swipe.ts`; only in standalone mode, a browser tab keeps its own gesture).
- A control smaller than 28 px (icon "×", column selector, switch, checkbox) gets an invisible hit area:
  `relative before:absolute before:-inset-2.5 before:content-['']` (as `Switch` / `Checkbox` do).
- Horizontal overflow is a bug: give flex children `min-w-0` and long strings `truncate` / `break-all`.

## 4. States

| Situation | Do |
|---|---|
| First load of a page / card | **Skeleton with the final footprint** (same height as the content). Never a centered spinner, never an empty flash. |
| Refreshing data already shown | keep the old data visible (React Query does it), optional small spinner in the trigger, `opacity-60` on the card. |
| Lazy route chunk loading | nothing to do: the router keeps the previous page and shows the 2 px top progress bar after 120 ms. |
| Empty list | `EmptyState` with an icon, one sentence and a call to action. |
| Load error | inline `EmptyState tone="error"` / `Callout tone="error"` with a Retry button where it happened. |
| Result of an action (saved, sent, deleted) | `toast.success` / `toast.error` (default via `useMut`). |
| Form validation / a server refusal tied to a field | **inline** under the field (`FormField error`), `errorToast: false` in `useMut`. |
| Destructive action | `await confirm({destructive: true})`; irreversible → `typeToConfirm`. |
| Long operation (update, test call) | progress inline in the card, `aria-live="polite"`. |

## 5. Data, live updates, navigation

- **API client** `lib/api.ts`: `api.get/post/put/patch/del/upload`, same-origin cookie, `X-Maxxing: 1` on every
  non-GET, throws `ApiError {status, code, message}`. A 401 anywhere → redirect to `/login?next=<here>` (pass
  `noAuthRedirect: true` for calls where 401 is a form error, e.g. password change). `errorMessage(e)` for display.
- **Types**: `lib/types.ts` mirrors API.md exactly. Change API.md first, then types, then code.
- **Queries**: one hook per endpoint in `lib/queries/<domain>.ts`; keys in `keys.ts` always start with the domain
  (`['sessions', …]`). Mutations use `useMut(fn, {invalidate, successToast, errorToast, optimistic})`. Every toggle,
  switch or small edit is **instant**: `optimistic: (vars) => [{ key, update }]` patches the cache before the request
  and is rolled back on error (see `usePatchSession`); never make a button wait for a refetch.
- **Live**: the shell connects `/api/stream` once; `BUS_KEYS` maps each bus topic to the query prefixes it
  invalidates. Never poll what the bus already pushes (health also refetches every 60 s as a safety net).
  For per-resource streams use `useEventSource(url | () => url, {eventName: handler}, {onReconnect})` — pass a
  function to resume from the latest offset after a reconnect.
- **URLs are the state** for anything shareable: `/sessions?path=<topic>&session=<id>&new=1`,
  `/files?path=<abs path>`, `/tasks?task=<id>`, `/crons?job=<id>`, `/settings/<section>`, `/docs/<slug>`,
  `/x/<extension id>`. Built-in dashboard links use these routes.

### Adding a page
1. `src/pages/<name>/index.tsx` with `export default function NamePage()` rendering `<Page …>`.
2. Add a lazy entry in `src/routes.tsx` (`{ path: '<name>/*', lazy: page(() => import('./pages/<name>')) }`).
   The page owns its sub-paths (nested `<Routes>` inside, or `children` in the table).
3. Primary navigation item? Add it to `components/shell/nav.ts` (sidebar, touch app drawer, palette and `g <key>` follow).
4. Palette commands: `useRegisterCommands('<page>', [{id, title, group, icon, perform}], deps)` while mounted;
   search-as-you-type sources: `useRegisterProvider({id, group, search(q, signal)})`.
5. Shortcuts: `useHotkey('mod+enter', fn)` (single keys are ignored while typing); document them in the
   shortcuts dialog (`GLOBAL_SHORTCUTS` or a page section).
6. Strings in `i18n/en.ts` **and** `i18n/fr.ts`, user data wrapped in `<Sensitive>`.

### Extension pages
`/x/:id` imports `/ext/<id>/page.js` and calls `mount(el, ctx)`; `ctx = {id, api(path, {method, body, query}),
navigate(route), theme: 'dark'|'light', t(key)}`. `ctx.api('notes')` → `/api/ext/<id>/notes` (JSON, CSRF header),
resolves to the parsed JSON, rejects with an `Error`. The returned function is called on leave.

**UI kit for extensions** (`server/maxxing/assets/ui-kit.css`, served at `/ext/ui-kit.css`): the look of this design
system as plain `ui-*` classes, so pages and HTML widgets written by Claude (no React, no Tailwind) look like the app:
`ui-page ui-section ui-grid ui-row ui-stack`, `ui-h1/h2/h3 ui-text ui-muted ui-small ui-label`, `ui-card` (+ `-header`,
`-footer`), `ui-tile` (clickable card: `ui-icon-box` + `<div><b/><span/></div>`), `ui-btn` (+ `ui-secondary ui-outline
ui-ghost ui-danger ui-sm ui-icon-only`), `ui-field ui-input ui-select ui-textarea ui-check`, `ui-badge` / `ui-dot`
(+ `ui-success ui-warning ui-error ui-primary`), `ui-list ui-table ui-table-wrap ui-stat ui-progress ui-steps ui-callout ui-empty
ui-skeleton ui-code ui-kbd ui-link`. Scoped to `.mx-ext` (the page host) and `[data-mx-kit]` (`<html>` of a widget frame),
inside `:where()` so an extension's own CSS always wins; every colour is a theme variable (the widget frame receives
them all by message). `ctx.icon(name)` gives pages the curated icons of `NamedIcon`; Card list items take `icon` too.
When a component of `components/ui` changes its look, change its `ui-*` twin. No emoji in built-in cards, packs or
the default extensions: icons.

## 6. Presentation mode (mandatory)

A persisted flag (`useUI().presentation`, toggle in the sidebar / touch app drawer / palette / `Shift+P`).
`<Sensitive>{value}</Sensitive>` renders the value normally, or a mask (`••••`) when active — **the real value is
not rendered at all**, so nothing leaks in the DOM, tooltips or screenshots. `block` for paragraphs,
`placeholder` for custom masks (charts, QR codes), `useMask()` for strings in attributes/inputs.

**Rule: every page wraps user data** — names of projects/topics/sessions/files, paths, message text, numbers that
describe the user's business, tokens, ids, usernames, repository names, log lines. What *names an action or a
section* (labels, buttons, headings of the UI) stays readable. Settings › General has "Presentation mode by
default" (applied once per new browser).

## 7. i18n

`useT()` → `t('key', {vars})`. English is the reference (`en.ts`); `fr.ts` is typed
`Record<keyof typeof en, string>` so a missing translation fails the build. Plurals: add `key#one` (used when
`count` is 1 — French: 0 or 1). Keys are grouped by area (`common.*`, `nav.*`, `settings.*`, `onb.*`…). The language
comes from server settings once signed in (stored locally too for the login page). Format dates/numbers with
`lib/format.ts` + the current language and the configured time zone.

Loading: each dictionary is split at build time (`i18nSplit` in `vite.config.ts`) by namespace (the key's first
segment). `i18n/groups.ts` lists the namespaces that leave the core, by group (`settings`, `auth`, `infra`, `git`,
`tasks`, `files`, `show`, `convx`…); the core (everything else) is awaited before the first render. A route declares the
groups it shows (`page(() => import('./pages/tasks'), ['tasks'])` in `routes.tsx`, preloaded by `index.html` too) and
a lazy component wraps its import with `withGroups(['infra'], () => import(…))`. A key from a group that is not
loaded yet renders as an empty string and triggers its loading (then `useT` re-renders): a new namespace shown by the
shell or the dashboard stays out of `groups.ts`. What a conversation opens on demand (activity rows, footer details,
Change limits, summary, HUD, agent map, side question) is the `convx` group, fetched when the sessions page is idle,
so the first-load budget (`test_web_first_load.py`, 20 000 brotli bytes) holds; their entry points (menu items,
buttons) keep core keys (`sessions.menu.*`, `sessions.swarm.*`, `sessions.queue.ask*`).

## 8. Do / Don't

Do
- Use the components above; extend them rather than restyling ad hoc.
- Reserve space for anything that loads (skeletons, fixed-height charts, error lines under fields).
- Keep the previous data on screen while refetching; patch caches from mutation responses when possible.
- Make every action reachable by keyboard; dialogs trap focus and restore it (Radix does it).
- Give icon-only buttons an `aria-label` (and a `Tooltip` on desktop).

Don't
- `window.alert/confirm/prompt` — use `toast`, `confirm()`, a `Dialog`.
- Spinners for page loads, layout shifts when data arrives, content that jumps when a scrollbar appears.
- Hard-coded colours, raw `fetch` in components, `any` in API types, strings outside the dictionaries.
- Render user data outside `<Sensitive>`.
- Name endpoints or files `/log`, `/track`, `/ads`, `/stats` (ad blockers).
- Load a CDN: everything is bundled (fonts included) — the UI must work offline behind a VPN.

## 9. Mock & visual checks

`web/mock/server.mjs` implements every API.md endpoint with in-memory, product-neutral data and serves `web/dist`:
`MOCK_PORT=8809 MOCK_SCENARIO=ready|onboarding|login|setup|maxxing node mock/server.mjs`
(`maxxing`: 30 more sessions that keep finishing at random, for Maxxing mode; `MOCK_PASSWORD=…` asks for that password;
`MOCK_DIST=…` serves another build)
(`POST /__mock/scenario {"name"}` resets at runtime; setup token `dev-token`, password `password123`).
Visual pass = Playwright screenshots at 375 / 768 / 1280 / 1920 of every page in dark and light, plus a check that
the console has no errors.

## 10. PWA & guided tour

**PWA.** `public/manifest.webmanifest` + icons (`scripts/gen-icons.py` renders them from the logo; PNGs are
committed). `sw/sw.js` is hand-written; the `maxxing-sw` Vite plugin injects the build version (hash of the output
file names → cache names `mx-shell-<v>` / `mx-assets-<v>`) and the app-shell precache list. Strategies: navigations
network-first → `offline.html` when the server is unreachable (HTML is never cached); `/assets/*` cache-first;
other static files stale-while-revalidate; **`/api/*`, `/ext/*`, non-GET and cross-origin requests are never
intercepted**. Old caches are deleted on activate. A new build ⇒ new `sw.js` ⇒ toast "New version available —
Reload" (`SKIP_WAITING`, then reload on `controllerchange`). The server sends `sw.js`, `manifest.webmanifest` and
`offline.html` with `Cache-Control: no-cache`. The SW only registers in production builds on secure origins
(HTTPS or localhost). "Install app" (user menu, touch app drawer, palette, Settings › General) uses the deferred
`beforeinstallprompt`, or explains Share → Add to Home Screen on iOS; hidden once installed (standalone).

**Guided tour.** Steps target `data-tour="<id>"` attributes (`nav`, `tree`, `new-session`, `composer`, `palette`,
`nav-<page>`, `health`, `menu`); the first *visible* element of each id is used, several ids are unioned. A step
can route first (e.g. open a new-session column to show the composer); a target that does not show up within 3 s
is skipped — the tour never blocks. Keep these attributes when refactoring the shell. It starts once after
onboarding (`mx-tour-pending` in sessionStorage, `tourDone` in the UI store) and is replayable from the Help
group of the user menu, the palette and Settings › General. The closing card links to the
`projects/tutorial/topics/1-first-steps` topic when it exists (else to the docs).
- Counters: `CountBadge` / `CountDot` (`@/components/ui`) - round; tones `unread` (finished answers, green),
  `running` (the accent), `attention` (notifications to handle, red) and, for the dot only, `notice` (an accent dot:
  unread activity that needs nothing). They pulse (`.mx-badge-pulse`, never the running ones) only when the user
  turned on Settings -> Notifications -> On this device -> "Pulsing badges" (off by default).
- Notifications: the sidebar entry (a tile in the touch menu) opens the centre (`features/notifications`), "To handle"
  on top; the dashboard shows a "To handle" card only while something is pending - there is no permanent feed panel
  nor header bell. A discussion paused on its limit shows `PausedBanner` above its thread (warning tokens, Change
  limits + Resume); the session's **…** menu opens the same `ChangeLimitsDialog` for any discussion. Colours come
  from the semantic tokens only (`warning`, `destructive`, `success`, `primary`, `action`).

## 11. Motion & performance

- Motion is light and short (140-340 ms), **transform and opacity only**, and always disabled by
  `prefers-reduced-motion` (global rule in `globals.css`). Fill mode is `backwards`, never `both` or
  `forwards`: a finished animation must not keep a GPU layer alive per row.
- Utilities (`globals.css`): `.mx-rise` (item entrance), `.mx-card-in` (dashboard widgets, 32 ms apart, `--i` capped at 6), `.mx-unfold` (group opening), `.mx-fade`; stagger
  siblings with `style={{ '--i': n }}` (cap `n` at 10). `#main > *` fades each routed page in - **opacity
  only**, a transform would make the page the containing block of its `fixed` overlays.
- Dashboard cards build their content after `.mx-card-in`: `.mx-grow-y` (chart bars), `.mx-draw` (chart line,
  `pathLength="1"`), `.mx-sweep` (timeline tracks, `grow` progress bars), `.mx-dot-in` (timeline events, lane then
  time order via `--i` / `--x`), `.mx-rise` on list / table rows, a count-up on numeric stats (`useCountUp`, rAF,
  text only). A card below the fold carries `.mx-wait` (`animation-play-state: paused` on it and its children) and
  the `InView` context is false until it scrolls into view (IntersectionObserver), so its entrance is seen; never
  under reduced motion. When the grid changes (the "To handle" card coming or going, a widget shown / hidden / moved) `useGridFlip` slides the
  cards (2-D FLIP, transform only, 340 ms). The whole build of a card stays under ~0.9 s.
- A page is fully on screen within ~0.5 s of its data: a stagger never delays the last item by more than
  ~200 ms (cap `--i`), and an entrance does not replay when the user comes back to a page.
- First load: `index.html` sets `html[data-boot]` and paints a splash inside `#root`; `AppShell` removes
  the attribute after 1.3 s. Boot-only animations are scoped to it (`.mx-boot-side`, `.mx-boot-item`).
- Never use `backdrop-filter` / `backdrop-blur` anywhere: it is expensive on Windows and integrated GPUs and
  makes text look soft. Use an opaque or near-opaque background.
- Entrance animations run once: the session tree animates only nodes mounted during its first reveal
  (`TreeIntro`), on the first visit of the tab only; folders opened later only unfold. Switching the list Projects / Sessions replays that intro
  for the new view. Never stack two entrance animations on one element.
- Counters (`CountBadge`) pop in and shrink out with the Web Animations API (no clash with the CSS pulse): keep
  them mounted (`count={0}`) and give their wrapper `empty:hidden` instead of `{n > 0 && …}`, or they vanish.
- `useGlobalBus` batches server invalidations (250 ms) and `AppShell` prefetches the page chunks and the
  sessions list when idle (skipped on Save-Data / 2G).
- Settings: `SectionStack` wraps each card in `.mx-rise` (28 ms apart, cards after the 5th together, section heading first); the desktop sub-nav
  highlight is one absolute element moved with `transform` (items are `h-9` + `gap-0.5` = 2.375rem apart; each group heading,
  `h-7` + `gap-0.5`, adds 1.875rem).
- Settings menu: the sections are grouped under headings (`SETTINGS_GROUPS` in `pages/settings/sections.ts`: You, Agents, Data,
  Integrations, Platform; every section has a `group`, the list is in menu order), Support last without a heading. On a
  computer a search above the menu filters it (name, description, keywords; case and accents ignored; Enter opens the first
  match, Escape clears); only the menu scrolls, with its edge fade. The phone tabs keep one row, a thin divider between groups.
- Lists that change under the user (session rows, columns): `lib/presence.ts`. `usePresence` keeps a removed
  item rendered while it leaves; `animateOut` takes it out of the flow (absolute, parent `relative`) and fades
  it; `useFlip` slides the others from their previous place; `animateIn` fades + slides new ones. Transform and
  opacity only - never animate width/height (a column re-lays its whole thread out every frame). Off while the
  tree is filtered (`ms = 0`) and under `prefers-reduced-motion`.
- Long homogeneous lists: `.mx-cv` (`content-visibility: auto`) on rows of fixed height.
- Code that is not needed for the first paint (palette, tour, install dialog, shortcuts) is a lazy chunk
  mounted through `WhenIdle` in `AppShell`; keep their stores in separate files so the chunk can split.
- Files are opened with `openFileViewer(path, list)` (`features/files/viewerStore.ts`) - never a page-local
  drawer: one viewer (panel / fullscreen, ← / →, folders) for the whole app, its chunk loads on first open. A
  clickable path in a thread carries `data-mx-file` (or is a `#mx-file=` link) so ← / → can find it. Renderers
  per kind live in `features/files/viewers.tsx` (media, pdf, markdown) and `rich.tsx` (CSV, HTML, archive,
  font, folder); `PreviewBody` picks one.
- `window.__mxAuth` (set in `index.html`) is the auth-state request started before the bundle loads;
  `fetchAuthState` consumes it once.
- Boot: `index.html` preloads the page chunk of the opened URL and the UI language's dictionary chunks (core + the
  route's groups, see §7; route table read
  from `src/routes.tsx` at build time); `lib/boot.ts` starts the first screen's API calls with the hooks' own
  query keys as soon as the early auth check says signed in. Keep new pages in `routes.tsx` so they get it.
- Page data: `pages/pageData.ts` maps a URL to its page's main queries (`prefetchPageData`). It is called by the
  boot prefetch, by the AppShell route `loader` (in parallel with the lazy chunk, again on a page change) and by
  the sidebar / tab bar links on hover, focus or touch (`usePrefetchLink`, chunk + data). A new page adds its
  queries there, built with the same `xxxQuery()` factories as its hooks (same keys, so the hook finds them).
- Refetch on focus is off for `LIVE_KEYS` (`lib/queries/keys.ts`: data the bus keeps fresh); `useGlobalBus`
  refreshes them once when a tab comes back after 60 s hidden. Add a key there only if every change to it is
  pushed by the bus.
- Long lists: render progressively (first slice, then more as the end comes near, see `files/Listing.tsx`) or
  page them; a list that can reach thousands of rows never mounts them all at once.
- Build output: `maxxing-precompress` (vite.config.ts) writes `<asset>.br` (Brotli 11) next to each JS/CSS file
  and preloads the Latin Inter font; the server (`app.py`, `_mount_spa`) sends the `.br` twin with
  `Content-Encoding: br` when the browser accepts it.
- Accent in images: `src/lib/accent.ts` (manifest per named accent; colours before the stylesheet come from the
  palette cache `mx-theme`, read by `index.html` and `offline.html`) drives every logo: favicon, splash, installed-app manifest and icons, iOS home-screen icon,
  notifications. A new accent or a new logo: change the drawing in `web/scripts/gen-icons.py` and rerun it; never hard-code a
  blue icon, and use the SVG (`logoSrc`) wherever a browser draws it.
