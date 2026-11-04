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

**Export** saves the palette as a `.theme.json` file (every colour written out, light and dark); **Import** opens such
a file, shows it in the preview with its contrast check and applies it only when you confirm. Only colours are read
from a file: anything else is ignored.

The application itself can also be changed in the repository. The web interface is built from `web/src`; run `npm run typecheck` and `npm run build` from `web` after changing it. Restart the local server when server code changes. Keep a backup and review changes before applying them.

## Updates and customizations

The legacy server's customization replay, smart updates and rollback flow have not been validated for this repository. Automatic updates are disabled in the local setup. Do not assume an update will preserve or replay changes automatically; review the Git changes and back up the workspace first. See [Local installation](installation) and the [audit](../AUDIT.md) for the supported path and current limitations.
