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

## In the conversation

When an agent proposes something, its answer shows a violet **proposal card**: what it is (a widget, a page…, new or
a new version), what the agent says it does, what it asks for (sites, keys, files), how many files, and the result of
its check. Nothing runs by itself: **Preview with your data** runs it once, in a sandboxed frame. Then:

- **Add to the dashboard** (or **Turn the page on**, **Turn the new version on**…) approves it right there;
- **Ask for a change** opens a field in the card: what you write goes to the agent, in this session, and it proposes
  again;
- **Open in the Studio** opens the full review screen (files, line by line).

A card that says *Being registered* belongs to an agent that has not finished its turn yet (Codex): it fills in by
itself. Once decided, the card says what became of the proposal (approved as vN, refused, replaced by a newer one).

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

## A creation's page: versions and going back

Click a row (or **Details and versions** in its **…** menu) to open its page:

- the header shows its state and version, with **Open** (where it lives in the app), **Disable** / **Turn on**, and
  **…** → **Ask for a change**;
- **It is broken**, when it is: what failed and where (it does not load, its card fails, its page or HTML widget
  failed while you used it…), the error with the lines it went through, **Ask for a fix** (the agent gets the error
  and the files, in the session that made it, or a new session in *system › harness*) and **Go back to vN**, the
  last version that worked;
- what it does, what it asks for (as on the review screen) and the files of the version that runs. Under what it
  asks for: the keys it was **granted before permissions existed** (in amber: it keeps working, but nothing limits
  those keys until the agent declares them), the keys it tried to read and was **refused**, and **Allow** /
  **Refuse** when a declared key waits for you (the same buttons as in Settings → Extensions);
- **Versions**, newest first: the active one is marked; each says what the agent did, in which session, when, how it
  was approved (by you, by itself because it asks for nothing, or because it existed before the Studio) and whether it
  worked while it was active. **Changes** shows what that version changed; **Back here** makes an older version
  active again, after a confirmation (the current one stays kept: you can come back to it). How long versions are
  kept is shown under the list (90 days, and always the 10 newest, by default);
- **History**: every approval, refusal and return to an earlier version.

When its files were changed outside the Studio, a notice says so: it keeps running with them, and **Accept the
changes** makes them a new version. Themes, skills, customizations and cron jobs have a page too, which says where
they are managed; they have no versions here.

**History** (top of the list) shows the proposals of the last 30 days and what became of them: waiting, approved
(and as which version), refused (with your reason), replaced by a newer one.

## Where the rows come from

Extensions (widgets, HTML widgets, pages, conversation blocks, agent engines and cards pinned from a conversation)
are versioned by the Studio. Themes, skills, customizations and cron jobs are listed so that you see everything in one
place; they keep their own settings pages. Extensions that existed before the Studio are listed as approved version 1,
with an unknown origin.
