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

## Reviewing a proposal

**Review** opens the proposal on its own screen. Nothing of it is installed yet.

- **Preview, with your real data** (left): a dashboard widget is run once, with your data, and drawn in a dashed frame
  exactly as the dashboard would draw it; an HTML widget runs in its sandboxed frame. The round arrow runs it again.
  A page is never run before you approve it (its code would run inside the app with your session), and a
  conversation block is tried once approved: for them, read the files.
- Under it, the result of the **check** harness-pilot ran on the files without running them (it loads like an
  installed one, or what fails), then **What it does**, in the agent's words, and the changes you already asked for.
- **What it asks for** (right): the sites on the internet it calls (**Network**), the **keys and secrets** it reads
  (Settings → Keys), and the **files it reads** outside its folder. A dot turns amber when it asks for something.
  **Not declared** in amber means it does not say what it needs: nothing limits what its code does.
- **Files**: what the proposal adds, changes or removes compared with the version that runs now (unchanged files are
  folded), and the changes of the file you pick, line by line.

Then, at the bottom (always in sight):

- **Add to the dashboard** (or **Turn the page on**, **Turn the new version on**…) installs it as a new version. If
  another version became active while you were reading, harness-pilot says so and shows the changes again instead.
  A proposal whose check found an error cannot be turned on.
- **Ask for a change** sends your words to the session the proposal came from: the agent picks them up there and
  proposes again (a new session in the same topic when that session is gone). The proposal waits meanwhile.
- **Refuse**, with a reason if you like: nothing is installed, and its files go to the trash.

After a decision, the next proposal waiting opens, until none is left.

## Settings of the Studio

The gear button at the top of the Studio opens its settings:

- **Turn on safe creations by themselves** (off by default): a proposal that declares no network and no secret - no
  site on the internet, no key - and whose check passes goes live as soon as the agent proposes it; a notification
  tells you. Everything else keeps waiting for your approval. A declaration is what the creation says it uses: it is
  checked, but its server code is not locked in, so keep this off unless you trust what your agents build. Every such
  version is kept like the others and can be undone from its page.
- **Keeping versions**: a version stays while it is younger than the number of days set here (90 by default) or among
  the newest versions of its creation (10 by default). The active version, and the one a waiting proposal builds on,
  are always kept.

## Where the rows come from

Extensions (widgets, HTML widgets, pages, conversation blocks, agent engines and cards pinned from a conversation)
are versioned by the Studio. Themes, skills, customizations and cron jobs are listed so that you see everything in one
place; they keep their own settings pages. Extensions that existed before the Studio are listed as approved version 1,
with an unknown origin.
