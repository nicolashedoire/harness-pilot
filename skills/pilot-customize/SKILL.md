---
name: pilot-customize
description: Customize harness-pilot itself and keep the change through updates. Use when the user wants the product to behave differently (a server rule, a limit, a CLI command, a default, a Telegram message format...) and no extension can do it; when `pilot update` reports that customizations conflict (exit code 3) or rolled back (exit code 4); when doctor shows unsaved changes in the code directory; when restoring customizations on a new server; or to list, explain or remove customizations.
---

# Customizations of the product code

The user owns this server and may change anything - including harness-pilot itself. Never answer
"ask the authors"; say exactly what an update keeps:
- **kept untouched**: the workspace (projects, memory, tasks, extensions: widgets, pages, block plugins), the
  scheduled jobs and the settings. An extension is the first choice (section 0).
- **replayed**: a change of the product outside `web/` (server, CLI, skills, templates) recorded as a
  **customization** - a local git commit in the code directory, listed in `<workspace>/CUSTOMIZATIONS.md`. `pilot
  update` replays it on the new version; when the new code changed the same place, the update stops with nothing
  changed (exit 3) and you adapt it (section 2). An unsaved change found by the update is saved as one first.
- **not kept**: any change under `web/` (the sources or the built `web/dist`). `pilot custom save` refuses it and
  `pilot update` sets it aside (`git stash` in the code directory): the new version's interface runs without it.
  Rebuild what it does as a page or widget extension, and tell the user before they rely on it.

Paths: code directory = `pilot status` -> Code (here `{{CODE_DIR}}`), workspace =
`pilot status` -> Workspace (here `{{WORKSPACE}}`).

## 0. Extension first
| The user wants... | Do |
|---|---|
| a widget, a mini-game, a canvas, a page, an integration shown in the UI | an **extension** (skill `pilot-widgets-pages`): survives updates with nothing to adapt |
| a new scheduled job, task, memory rule, topic behaviour | crons / tasks / the topic's `CLAUDE.md` - not the code |
| the product to behave differently and nothing above can do it | a **customization** (this skill) |

Never customize `web/` (the UI is shipped pre-built in `web/dist` and cannot be rebuilt on this
server: `pilot custom save` refuses it, `pilot update` sets it aside) - build a page or widget extension instead.

## 1. Make a customization
Server command: `pilot` (`maxxing`, its earlier name, still works).
1. Read the relevant code first (`<code>/server/maxxing/...`, `docs/dev/INTERNALS.md` explains the
   modules). Make the **smallest** change that does what the user asked; one customization = one
   purpose. Never put secrets in code (Settings -> Keys).
2. Check it: `cd <code>/server && .venv/bin/python -m compileall -q maxxing` (syntax), then restart
   (say so first, the page reconnects in seconds): `systemctl restart claude-maxxing`, and verify
   `pilot doctor` + the behaviour itself.
3. Record it - mandatory, right away:
   ```bash
   pilot custom save "Short title of what it does" --why "why the user wanted it (their words)" \
     --check "a shell command that exits 0 while it works"
   ```
   The `--why` is what lets a future Claude adapt it to a new version: write the intent, not the diff.
   The `--check` is run after every update (`pilot update --verify`, from the workspace, `$MAXXING_CODE` =
   code directory): e.g. `grep -q 'LIMIT = 50' $MAXXING_CODE/server/maxxing/rules.py`, or a `curl -fsS` of the
   endpoint it adds. Add or change it later with `pilot custom check <id> "<command>"`.
4. Tell the user it is recorded and that updates replay it (you adapt it if a new version changes the same
   code); note it in this topic's memory.md.

`pilot custom` (status) lists customizations, unsaved changes and any pending update.
`pilot custom drop <id>` removes one (ask first; restart afterwards).

## 2. During an update (topic system/harness, or system/update on older servers)
First `pilot update --preflight` (changes nothing): per customization `carries over`, `carries over, on
code that changed` (verify it after), `now included` (check the new version really does it, then `pilot
custom drop <id>`), `conflicts` (adapt it, below). Edits of the web UI cannot be kept: the update sets them
aside (`git -C <code> stash list`); rebuild what they did as an extension. Then `pilot update`
replays the customizations on top of the new version:
- **exit 0** - carried over ("N customization(s) carried over"). Check each still works.
- **exit 3 - conflict**: nothing changed, the old version keeps running. Adapt them:
  ```bash
  cat <workspace>/CUSTOMIZATIONS.md                     # intent of each customization
  pilot custom status                                 # conflicting files
  cd <code> && git rebase origin/main                   # stops on the first conflict
  git status ; git diff                                 # see both sides
  ```
  For each conflicted file: rewrite it so the **new version's code** is kept and the customization
  still does what its `why` says (the upstream code may have moved, been renamed or now does it
  natively - then the customization can be dropped: `git rebase --skip`, after telling the user).
  Remove every conflict marker (`grep -n '<<<<<<<\|>>>>>>>' <file>` must print nothing), then
  `git add <file>` and `GIT_EDITOR=true git rebase --continue` (no terminal: keep the message as
  is); repeat until the rebase ends. Check syntax (`compileall` above), then finish with:
  ```bash
  pilot update --resume        # deps, skills, restart, health check, records CUSTOMIZATIONS.md
  ```
  If you cannot make it work: `git rebase --abort` (back to the running version, nothing lost),
  explain what blocks to the user, and propose dropping that customization or staying on the
  current version.
- **exit 4 - rolled back**: the new version did not start (or dependencies failed); the previous
  code was restored automatically. Read `journalctl -u claude-maxxing -n 80 --no-pager`; if a
  customization is the cause, fix it in a rebase as above or drop it, then `pilot update` again.
- `pilot update --rollback` returns to the code that ran before the last update.
- After any update: `pilot update --verify` (extensions load, widgets answer, each customization's check
  passes) and fix what fails. A customization without a check: give it one.

## 3. Unsaved changes
Doctor "unsaved change(s) in the code directory" = someone edited the code without recording it.
Look (`git -C <code> diff`), ask the user what it is for, then `pilot custom save ... --why ...`
(or discard with `git -C <code> checkout -- <file>` if they confirm it is unwanted). An update
auto-saves them as "Unsaved changes found by the update": rename by dropping and re-saving with a
real title, or just add the purpose to this topic's memory.md.

## 4. New server
The memory backup contains `CUSTOMIZATIONS.md` and `customizations/*.patch`. After a restore, the
installer re-applies them; otherwise run `pilot custom restore`. If they do not apply to the
installed version, adapt them like a conflict (section 2) using the patch files as reference.
