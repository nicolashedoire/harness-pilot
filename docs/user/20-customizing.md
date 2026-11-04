---
section: Extending
---
# Customizing the workspace

You can tailor project instructions, topic memory, scheduled jobs and workspace extensions to your needs. The [memory guide](memory) explains how Claude and Codex receive shared context. Extensions are stored in the workspace; see [Dashboard widgets](dashboard-widgets) and [Page extensions](page-extensions).

## Colours and palettes

**Settings -> Appearance** chooses how the interface looks:

- **Theme**: dark, light, or the system's.
- **Palette**: three ready-made palettes - *Zinc & blue* (the default), *Graphite* (deeper greys, monochrome
  buttons) and *Marine* (navy surfaces, the blue of the logo) - or your own, *Custom*, as soon as you change any part:
  - **Accent colour**: one of the six swatches or any colour (colour picker or a code such as `#2d6efd`). It colors
    links, selections, unread and running dots, the active page and the focus ring. A colour too pale (or too dark)
    against the background is shown a little darker (or lighter) where it is used as text, and the settings say so.
  - **Main buttons**: *Neutral* (white on dark, near-black on light) or *Accent colour*. Checkboxes, switches and radio
    buttons follow this choice.
  - **Background**: *Neutral* greys, or *Tinted* with a shade of the accent.
- A live **preview** shows buttons, a switch, a checkbox, a notification and a link before you leave the page, and a
  line tells you whether every text keeps enough contrast in light and dark.
- **Back to the default look** returns to *Zinc & blue*.

The palette follows you: choose it on your computer and your phone shows it too (the theme, fonts and density stay
per device). The sign-in page uses it as well.

**Export** saves the palette as a `.theme.json` file (every colour written out, light and dark); **Share** sends it
to a Team contact, saves the file or copies a short *theme code* (`theme1:…`) you can paste in a message.

### Create a theme with harness-pilot

**Settings -> Appearance -> My themes -> Create with harness-pilot** turns your words into a theme:

1. Describe what you want ("a warm dark theme from my logo, less saturated, orange buttons, very readable text"),
   add an image if you like (a logo, a screenshot: up to 3), then **Generate**. A session starts in the topic
   `system/themes` (created the first time) with the skill `pilot-theme`: one turn of your agent, which you can open
   from the page.
2. The proposal shows in a preview (dark or light, your choice) with its colours and the **Checks**: colours only (no
   external link, no code), readable text in dark and light, and what was fixed automatically (for example button
   labels turned black to stay readable on orange).
3. **Refine** with one click - *More contrast*, *Neutral buttons*, *Cooler*, *Light version* - or in your own words:
   each one is a new message to the same session, and the new proposal replaces the previous one.
4. **Apply**, **Save to my themes**, or **Discard**. Nothing changes until you click Apply.

### My themes

**My themes** lists the ready-made palettes and the themes you saved: created with harness-pilot, imported from a
file or a code, received from a Team contact, or your own palette (**Save the current palette**). The list follows
you on every device (50 themes at most). Click a theme's drawing to use it; its **…** menu shares, renames or deletes
it. **Import a file** (or drop a `.theme.json` on the import area) and **Paste a code** open the theme in a preview
with its checks first, then **Use this palette** or **Save to my themes**.

Whatever its origin - a file, a code, your agent or a contact - a theme is checked before anything is shown: only
colours are read (anything else, such as a link or code, is ignored or refused), the contrast is measured in light and
dark, and it is never applied without your click.

The application itself can also be changed in the repository. The web interface is built from `web/src`; run `npm run typecheck` and `npm run build` from `web` after changing it. Restart the local server when server code changes. Keep a backup and review changes before applying them.

## Updates and customizations

The legacy server's customization replay, smart updates and rollback flow have not been validated for this repository. Automatic updates are disabled in the local setup. Do not assume an update will preserve or replay changes automatically; review the Git changes and back up the workspace first. See [Local installation](installation) and the [audit](https://github.com/nicolashedoire/harness-pilot/blob/main/docs/AUDIT.md) for the supported path and current limitations.
