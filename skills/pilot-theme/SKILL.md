---
name: pilot-theme
description: Create or adjust a colour theme (palette) of the harness-pilot web app from the user's words and, optionally, an image (a logo, a screenshot, a photo). Use when the user asks for a theme, a palette, "colours like my logo", a light or dark variant, more contrast, warmer or cooler colours, neutral buttons - and for every request sent by Settings -> Appearance -> Create with harness-pilot. Writes one `<name>.theme.json` file and answers with a short summary.
---

# Colour themes

A theme is a small JSON object: a neutral base, an accent colour, a button style, a background style and, when
needed, explicit colours for some of the 26 tokens of the interface, in light and in dark. The app fills every
token you leave out, checks the contrast again and shows the user a preview: nothing is applied until they click
**Apply**. Your job is a theme that looks like what they asked for and stays readable.

## 1. What you deliver

1. One file `<slug>.theme.json` in the **current working directory** (the session's folder: the app reads the
   newest `*.theme.json` written there during your turn). `<slug>` = the theme's `id` (lowercase, digits, dashes).
   A refinement may overwrite the same file or write a new one; the newest wins.
2. A short answer in the user's language, 2 to 4 lines: the theme's name, the idea in one sentence (base, accent,
   buttons), what you changed if it is a refinement, and anything you could not do (for example "the logo's yellow
   is too pale for links: I used a deeper shade"). No JSON in the answer, no file listing.

Never change anything else: no other file, no setting, no command that applies the theme. Never ask the user to
paste the theme into the settings - the app picks the file up by itself.

## 2. The format (schema 1)

```json
{
  "schema": 1,
  "id": "ember",
  "name": "Ember",
  "description": "Warm dark surfaces, orange buttons, calm text.",
  "author": "harness-pilot",
  "base": "custom",
  "accent": "#e8915a",
  "buttons": "accent",
  "tint": "neutral",
  "tokens": {
    "light": { "background": "#fbf7f3" },
    "dark":  { "background": "#14100d", "card": "#1c1612" }
  }
}
```

| Key | Value |
|---|---|
| `schema` | always `1` |
| `id` | `[a-z0-9][a-z0-9-]{0,47}` (else the app uses `custom`) |
| `name` | shown to the user, 60 characters at most, in the user's language, short and evocative ("Ember", "Sauge", "Night owl") |
| `description` | optional, 280 characters at most, one sentence |
| `author` | optional, 60 characters at most (leave it out unless the user gives one) |
| `base` | `zinc` (neutral greys, the default), `graphite` (deeper, slightly cooler greys), `marine` (navy), `custom` (surfaces from `tokens`, zinc for the missing ones) |
| `accent` | a named accent (`blue`, `clay`, `violet`, `green`, `amber`, `rose`) or a colour `#rrggbb` |
| `buttons` | `accent` (filled buttons, switches and checkboxes in the accent colour) or `neutral` (monochrome: text colour on page colour) |
| `tint` | `neutral` (plain greys) or `tinted` (surfaces take the accent's hue at low chroma, the base's lightness kept) |
| `tokens` | `{ "light": {...}, "dark": {...} }`: explicit values, they win over the derived ones. Only the 26 names below |

Unknown keys are dropped. The whole file is **16 KB at most**.

## 3. The 26 tokens

| Token | Where it shows |
|---|---|
| `background` / `foreground` | the page and its text |
| `card` / `card-foreground` | cards, panels |
| `popover` / `popover-foreground` | menus, dialogs |
| `primary` / `primary-foreground` | the accent: links, focus ring, selection, active page marker, unread and running dots; its foreground = text on a solid accent badge |
| `action` / `action-foreground` | filled buttons and checked controls (switch, checkbox, radio) and their label |
| `secondary` / `secondary-foreground` | secondary buttons, the active option of a segmented control |
| `muted` / `muted-foreground` | subtle fills; secondary text (dates, hints, meta) |
| `accent` / `accent-foreground` | hover and selected rows - a **neutral** fill, not the brand colour |
| `destructive` / `destructive-foreground` | errors, delete buttons |
| `success`, `warning` | status dots and icons |
| `border`, `input`, `ring` | hairlines, field borders, focus ring |
| `sidebar`, `sidebar-border` | the navigation column |
| `overlay` | the backdrop behind dialogs (keep it translucent black, e.g. `oklch(0 0 0 / 60%)`) |

## 4. How the app fills the gaps

For each mode: the base's surfaces (tinted with the accent hue when `tint` is `tinted`) -> status colours ->
`primary` (the accent, its lightness moved until it reads at 4.5:1 on background, card, popover and sidebar) ->
`action` (the accent under the label it prefers, moved until that label reaches 4.5:1; or `foreground` on
`background` with neutral buttons) -> `ring` = `primary`. A fill you set without its foreground gets black or white.

So **prefer the parts over explicit tokens**: `base` + `accent` + `buttons` + `tint` already give a complete,
readable theme in both modes. Add tokens only for what the parts cannot express (a warm brown dark background, a
cream light background, a specific card colour), and then set the surfaces of that mode together (background,
card, popover, sidebar, muted, secondary, accent, border, input, sidebar-border) with their foregrounds, so they
stay one family. Remember both modes: a theme asked "dark" still needs a sensible light mode (the derived one is
fine when you set no light token).

## 5. Rules the app enforces (anything else is refused)

- **Colours only**: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()`, `hsl()` / `hsla()`, `oklch()` with
  numbers (`%`, `deg`, an optional `/ alpha`), 64 characters at most. Never `url(`, `var(`, `calc(`, colour
  keywords (`red`, `transparent`, `currentColor`), gradients, `;`, braces or comments: the browser drops such a
  token and the server refuses the whole theme (`invalid_theme`).
- `schema` must be 1; `base`, `buttons`, `tint` take only the values above; `accent` is a name or a colour.
- `name` / `description` / `author`: control characters and `< >` are removed, then cut to their length.
- A theme from you, from a file, from a pasted code or from a Team contact is always checked the same way before
  it is previewed, stored or applied. It is never applied without the user's click.

## 6. Contrast (both modes)

| Pair | Minimum |
|---|---|
| `foreground` on `background` and on `sidebar`; `card-foreground` on `card`; `popover-foreground` on `popover` | 4.5:1 |
| `muted-foreground` on `background`, `card`, `muted`, `sidebar` | 4.5:1 |
| `secondary-foreground` on `secondary`; `accent-foreground` on `accent` | 4.5:1 |
| `primary-foreground` on `primary`; `action-foreground` on `action`; `destructive-foreground` on `destructive` | 4.5:1 |
| `primary` on `background` and `card` (links); `destructive` on `background` and `popover` | 4.5:1 |
| `ring` on `background`; `primary` on `sidebar`; `success` and `warning` on `background` | 3:1 |

A failing `primary-` / `action-` / `destructive-foreground` is replaced by black or white by the app ("fixed
automatically" in the preview); every other failure is shown to the user as a warning. Aim for zero warnings:
muted text is the usual culprit on tinted or coloured backgrounds - lift it rather than lowering the bar.

## 7. Procedure

1. **Read the request.** Note the mood (warm, calm, punchy, corporate...), light or dark preference, the colour
   words, what the buttons should look like, and any constraint ("readable", "less saturated", "like my logo").
2. **An image is attached?** Look at it and pick 2 to 4 dominant colours: the brand colour becomes the `accent`
   (`#rrggbb`), a dark or cream tone of the image may become the surfaces of one mode (`base: custom`). A logo on
   white says little about backgrounds: keep a neutral base then. Pale yellows and light greens make poor link
   colours on white: the app darkens them for links, say so in the answer.
3. **Start from the parts**: choose `base`, `accent`, `buttons`, `tint`. A preset is often the right start (§9).
4. **Add tokens** only where needed (§4), as `#rrggbb` or `oklch()`.
5. **Check** with the script of this skill (it is in this skill's folder):
   `python3 <this skill's folder>/check_theme.py <slug>.theme.json` - fix every error and every contrast failure it
   lists (it checks the explicit tokens; the derived ones are checked by the app). No Python? Compute the WCAG
   ratios of the pairs you set by hand.
6. **Write** the file, then answer (§1).

## 8. Refinements

The user may ask for changes in the same session ("More contrast", "Neutral buttons", "Cooler", "Light version",
or their own words). Read your last `*.theme.json`, change only what was asked, keep the name (or adjust it when the
change is big: "Ember - light"), check again and write the file again. Typical moves:

- **More contrast**: text closer to white / black, muted text 1 step stronger, borders a little stronger, surfaces
  further apart (card vs background).
- **Neutral buttons**: `"buttons": "neutral"` and drop any `action` / `action-foreground` tokens.
- **Cooler / warmer**: rotate the accent's hue (towards blue / towards orange) and, with explicit surfaces, their
  hue too; keep the lightness.
- **Light version**: the same identity for a light page: set or adjust the `light` tokens (cream or white
  surfaces, deep text) and make the light mode the one the description talks about. The user switches light / dark
  in Settings -> Appearance -> Theme; a theme always carries both modes.

## 9. Examples

The presets of the app (no explicit token):

```json
{ "schema": 1, "id": "zinc", "name": "Zinc & blue", "base": "zinc", "accent": "blue", "buttons": "accent", "tint": "neutral", "tokens": { "light": {}, "dark": {} } }
{ "schema": 1, "id": "graphite", "name": "Graphite", "base": "graphite", "accent": "blue", "buttons": "neutral", "tint": "neutral", "tokens": { "light": {}, "dark": {} } }
{ "schema": 1, "id": "marine", "name": "Marine", "base": "marine", "accent": "#2d6efd", "buttons": "accent", "tint": "neutral", "tokens": { "light": {}, "dark": {} } }
```

Parts only - "a calm green, tinted, buttons in the accent":

```json
{ "schema": 1, "id": "sauge", "name": "Sauge", "description": "Sage green on softly tinted greys.", "base": "zinc", "accent": "#5f8f6b", "buttons": "accent", "tint": "tinted", "tokens": { "light": {}, "dark": {} } }
```

Explicit surfaces for one mode - "warm dark theme from my orange logo, less saturated, orange buttons, readable":

```json
{
  "schema": 1, "id": "ember", "name": "Ember", "description": "Warm dark surfaces, orange buttons, calm text.",
  "base": "custom", "accent": "#e8915a", "buttons": "accent", "tint": "neutral",
  "tokens": {
    "light": {},
    "dark": {
      "background": "#14100d", "foreground": "#f6efe8", "card": "#1c1612", "card-foreground": "#f6efe8",
      "popover": "#211a15", "popover-foreground": "#f6efe8", "secondary": "#2b221b", "secondary-foreground": "#f6efe8",
      "muted": "#241c16", "muted-foreground": "#b8a99a", "accent": "#2b221b", "accent-foreground": "#f6efe8",
      "border": "#2e241c", "input": "#3a2e24", "sidebar": "#181310", "sidebar-border": "#2e241c",
      "primary": "#f2b48a", "action": "#e8915a", "action-foreground": "#1a0f08"
    }
  }
}
```

## 10. Do not

- Do not invent token names, keys or values other than colours; do not add comments to the JSON.
- Do not apply, install or upload the theme, and do not edit the app's settings or files.
- Do not write more than one theme file per turn unless the user asked for several options (then one file each,
  and say which is which).
