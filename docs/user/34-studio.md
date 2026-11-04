---
section: Extending
---
# Studio

The **Studio** (*Atelier* in French) is where everything your agents create for the platform waits for you: dashboard
widgets, pages, conversation blocks, themes, skills, customizations of the product and cron jobs. Open it from the
sidebar, right under your extension pages (on a phone: the app menu, top right).

Nothing an agent makes is switched on behind your back. When Claude or Codex builds a widget or a page, it writes it
aside as a **proposal**; it only runs, and only shows on the dashboard, once you approve it. Every approved version is
kept, so you can go back to an earlier one.

## The list

- **Waiting for your approval**: a violet banner on top counts the proposals waiting for you and names them.
  **Review** opens the first one.
- **Filters**: the chips keep one type (Widgets, Pages, Blocks, Themes, Skills, Customizations, and Agent engines or
  Crons when you have some), each with its count. The field next to them filters by name, by what the agent said it
  did, or by the session it came from.
- **Each row** shows the type, the name, what it does (or its error when it is broken), its state, where it comes from
  (the agent, the session it was made in, when) and its version.

| State | Meaning | What the row offers |
|---|---|---|
| To approve | A proposal waits for you: a new creation, or a new version of one that runs | **Review** |
| Active / Applied | It runs (a theme or a customization: it is applied) | the **…** menu |
| Error | It runs but is broken: it does not load, or it failed while you used it | **Get it fixed** |
| Review after the update | A customization conflicts with the new version of harness-pilot (or an extension was built for an older one) | **See the conflict** |
| Disabled | Turned off (Settings → Extensions, a cron job off, a saved theme not applied) | the **…** menu |

**Changed outside** next to a name means its files were edited without going through the Studio (by hand, or by an
agent writing straight into the extensions folder). It keeps working as before; its page lets you accept those changes
as a new version.

The **…** menu of a row opens the creation where it lives (the dashboard, its page, the theme settings…), its details
and versions, turns an extension off or on, and **Ask for a change**: a new session in the topic the creation was made
in, with its name already written, so you only say what to change.

**Create with an agent** (top right) opens a new session in the *system › harness* topic with the start of a request:
say what you want (a widget, a page, a theme, a skill…) and send.

## Where the rows come from

Extensions (widgets, HTML widgets, pages, conversation blocks, agent engines and cards pinned from a conversation)
are versioned by the Studio. Themes, skills, customizations and cron jobs are listed so that you see everything in one
place; they keep their own settings pages. Extensions that existed before the Studio are listed as approved version 1,
with an unknown origin.
