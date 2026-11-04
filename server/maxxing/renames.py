"""Product names that changed, and the safe migration of what earlier versions wrote with the old names.

The product skills were renamed from `maxxing-*` to `pilot-*` (SKILL_RENAMES). Every `pilot init` (so every
update) then:
- `cmd_core.install_skills()` installs the new folders and drops the copies of the old ones it had installed (an old
  folder it did not install is moved to the trash, never deleted);
- `migrate(ws)` replaces the old skill names in what the product itself wrote earlier:
  * the lines of the workspace files copied from a template (root, project and topic `CLAUDE.md`, starter packs)
    that are still the product's text: a line changes only when, with the new names, it is a line of the current
    template (the CLI name `maxxing` / `pilot` and the product name may differ). A line the user wrote or edited
    stays as it is;
  * the prompt of a default job or a starter-pack job the user never edited (equal to the shipped prompt once
    renamed).
  Only the exact old skill names are replaced. Text the user wrote is never touched: Claude proposes those
  changes to the user (upgrade notes).
The command was renamed from `maxxing` to `pilot` (`maxxing` stays its alias). `refresh_cli_guidance(ws)` (init, after
the `pilot` link is made, and the local start-up) gives `pilot` to the product lines of the template `CLAUDE.md` files
that still name `maxxing`, once per workspace and only when the agents' `pilot` is this program: where another program
has that name, the agents keep using `maxxing`, and a line the user changes back later stays as written.
"""
from __future__ import annotations

import logging
import os
import re
import stat
import tempfile
from pathlib import Path

from . import config

log = logging.getLogger("maxxing.renames")

SKILL_RENAMES = {                       # old name -> new name (keep every pair: workspaces of any age are migrated)
    "maxxing-setup": "pilot-setup",
    "maxxing-doctor": "pilot-doctor",
    "maxxing-telegram": "pilot-telegram",
    "maxxing-backup": "pilot-backup",
    "maxxing-cron": "pilot-crons",
    "maxxing-tasks": "pilot-tasks",
    "maxxing-feed": "pilot-notifications",
    "maxxing-mcp": "pilot-mcp",
    "maxxing-extension": "pilot-widgets-pages",
    "maxxing-customize": "pilot-customize",
    "maxxing-infra": "pilot-infra",
}
# a skill name stands alone: `maxxing-cron-<id>` (a job's systemd unit) or `harness-maxxing-infra` is not one
_OLD_SKILL = re.compile(r"(?<![\w-])(" + "|".join(re.escape(n) for n in sorted(SKILL_RENAMES, key=len, reverse=True))
                        + r")(?![\w-])")
_PRODUCT = re.compile(r"Harness Maxxing|harness-pilot")
_CLI = re.compile(r"(?<![\w./@-])(?:pilot|maxxing)(?![\w./@-])")
_OLD_CLI = re.compile(r"(?<![\w./@-])maxxing(?![\w./@-])")
_ALIAS_NOTE = "(`maxxing`, its earlier name, still works)"
# exact lines of earlier templates that differ from their current version by more than the CLI name -> that version
# (applied only while it is a line of the file's current template; no other line loses or gains an alias note)
_CLI_LINES = {
    "UI; the server CLI is `maxxing`:":                                         # root CLAUDE.md before 2.0.0a109
        f"UI; the server CLI is `pilot` {_ALIAS_NOTE}:",
    "| `17-cli-reference.md` | every `maxxing` command |":                       # help topic before 2.0.0a109
        f"| `17-cli-reference.md` | every `pilot` command {_ALIAS_NOTE} |",
    "| `17-cli-reference.md` | every `pilot` command (`maxxing` = the same command, earlier name) |":  # first `pilot` text
        f"| `17-cli-reference.md` | every `pilot` command {_ALIAS_NOTE} |",
}
CLI_REFRESHED = "cli_guidance"          # install.json: the workspaces whose product lines got `pilot` (once each)
MAX_FILE_BYTES = 1 << 20                # a larger workspace file is no template's copy: skipped (logged), never read
RENDERED_SUFFIXES = (".md", ".json", ".txt")


def rename_skills(text: str) -> str:
    """`text` with every old product skill name replaced by the new one."""
    return _OLD_SKILL.sub(lambda m: SKILL_RENAMES[m.group(1)], text)


def has_old_skill(text: str) -> bool:
    return _OLD_SKILL.search(text) is not None


def _neutral(line: str) -> str:
    """A line without what may differ between the text an older version wrote and the current template, apart from
    the skill names: the CLI name and the product name."""
    return _CLI.sub("<cli>", _PRODUCT.sub("<product>", line)).rstrip()


def _read_text(path: Path, what: str) -> str | None:
    """The text of a workspace file a migration may change: a regular file (not a link) of at most MAX_FILE_BYTES
    (a larger one is skipped and logged, never read whole), in UTF-8; read as bytes, so CRLF and a missing final
    newline stay. None otherwise."""
    try:
        st = path.lstat()
    except FileNotFoundError:                    # a default topic the user deleted, a pack never installed
        return None
    except OSError as e:
        log.warning("%s: %s not migrated: %s", what, path, e)
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    try:
        data = b""
        if st.st_size <= MAX_FILE_BYTES:
            with open(path, "rb") as f:
                data = f.read(MAX_FILE_BYTES + 1)
        if st.st_size > MAX_FILE_BYTES or len(data) > MAX_FILE_BYTES:
            log.warning("%s: %s skipped: larger than %d bytes", what, path, MAX_FILE_BYTES)
            return None
        return data.decode("utf-8")
    except UnicodeDecodeError:                   # not a text a template made
        return None
    except OSError as e:
        log.warning("%s: %s not migrated: %s", what, path, e)
        return None


def _rewrite(path: Path, text: str, what: str) -> bool:
    """Write `text` into `path` unless the user made it read-only (no write bit, or not writable for this process:
    os.replace would only need the folder) -> written."""
    if not path.stat().st_mode & 0o222 or not os.access(path, os.W_OK):
        log.info("%s: %s skipped: read-only", what, path)
        return False
    _write_text(path, text)
    return True


def _lines(text: str) -> list[tuple[str, str]]:
    """(line, its end) as str.splitlines() cuts `text`: besides LF and CRLF, a form feed, U+2028, NEL... end a line
    too, and a changed line keeps its own end (two lines are never joined)."""
    out = []
    for full in text.splitlines(keepends=True):
        body = full.splitlines()[0]
        out.append((body, full[len(body):]))
    return out


def _write_text(path: Path, text: str) -> None:
    """Atomic rewrite keeping the file's permissions."""
    mode = path.stat().st_mode & 0o7777
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _template_pairs(ws: Path) -> list[tuple[Path, Path]]:
    """(template file, workspace file) for every rendered template file of the workspace and of the starter packs
    (a pack lives in projects/<project> or projects/<project>-N, see packs.py)."""
    pairs: list[tuple[Path, Path]] = []
    root = config.TEMPLATES_DIR / "workspace"
    if root.is_dir():
        pairs += [(f, ws / f.relative_to(root)) for f in sorted(root.rglob("*"))
                  if f.is_file() and f.suffix in RENDERED_SUFFIXES]
    packs, projects = config.TEMPLATES_DIR / "packs", ws / "projects"
    if not packs.is_dir() or not projects.is_dir():
        return pairs
    names = [p.name for p in projects.iterdir() if p.is_dir() and not p.is_symlink()]
    for pack in sorted(packs.iterdir()):
        src = pack / "project"
        data = config.read_json(pack / "pack.json", {}) or {}
        base = str(data.get("project") or pack.name) if isinstance(data, dict) else pack.name
        if not src.is_dir():
            continue
        for name in names:
            if name == base or re.fullmatch(re.escape(base) + r"-\d+", name):
                pairs += [(f, projects / name / f.relative_to(src)) for f in sorted(src.rglob("*"))
                          if f.is_file() and f.suffix in RENDERED_SUFFIXES]
    return pairs


def _migrate_file(template: Path, dst: Path, variables: dict[str, str]) -> int:
    """Rename the old skills in the lines of `dst` that are the template's text -> number of lines changed."""
    text = _read_text(dst, "skill rename")
    if text is None or not has_old_skill(text):
        return 0
    from .cmd_core import render_template
    try:
        product = {_neutral(ln) for ln in render_template(template.read_text(encoding="utf-8"), variables).splitlines()}
    except (OSError, UnicodeDecodeError):
        return 0
    out, n = [], 0
    for body, end in _lines(text):
        if has_old_skill(body):
            new = rename_skills(body)
            if _neutral(new) in product:
                body = new
                n += 1
        out.append(body + end)
    if n and not _rewrite(dst, "".join(out), "skill rename"):
        return 0
    return n


def _workspace_file(ws: Path, dst: Path) -> bool:
    """Never follow a link in a template destination, including a linked project or topic folder."""
    parts = dst.relative_to(ws).parts
    return not any(ws.joinpath(*parts[:i]).is_symlink() for i in range(1, len(parts) + 1))


def migrate_workspace(ws: Path) -> list[str]:
    """Workspace files (relative paths) whose product lines got the new skill names."""
    from .cmd_core import template_vars
    variables = template_vars(ws)
    changed = []
    for template, dst in _template_pairs(ws):
        try:
            if not _workspace_file(ws, dst):
                continue
            if _migrate_file(template, dst, variables):
                changed.append(str(dst.relative_to(ws)))
        except OSError as e:
            log.warning("skill rename: %s not migrated: %s", dst, e)
    return changed


def migrate_cli_workspace(ws: Path) -> list[str]:
    """One pass of `pilot` over the template CLAUDE.md files (refresh_cli_guidance decides when) -> changed files.
    A line naming `maxxing` as the command becomes the line of the current template it equals once the CLI and
    product names are ignored, or, for an exact earlier line of _CLI_LINES, its new version. Lines the user wrote or
    edited, and conversation history, are left."""
    from .cmd_core import render_template, template_vars
    variables = template_vars(ws)
    changed = []
    for template, dst in _template_pairs(ws):
        try:
            if dst.name != "CLAUDE.md" or not _workspace_file(ws, dst):
                continue
            text = _read_text(dst, "CLI guidance")
            if text is None or not _OLD_CLI.search(text):
                continue
            current = render_template(template.read_text(encoding="utf-8"), variables).splitlines()
            product = {_neutral(line): line for line in current}
            out, n = [], 0
            for body, end in _lines(text):
                if _OLD_CLI.search(body):
                    target = _CLI_LINES.get(body)
                    if target not in current:
                        target = product.get(_neutral(body))
                    if target is not None and target != body:
                        body = target
                        n += 1
                out.append(body + end)
            if n and _rewrite(dst, "".join(out), "CLI guidance"):
                changed.append(str(dst.relative_to(ws)))
        except (OSError, UnicodeDecodeError) as error:
            log.warning("CLI guidance: %s not migrated: %s", dst, error)
    return changed


def refresh_cli_guidance(ws: Path) -> list[str]:
    """migrate_cli_workspace(ws) once per workspace (install.json CLI_REFRESHED), and only when the `pilot` the
    sessions run is this program (cmd_core.sessions_run_our_pilot): where another program has the name, the product
    lines keep `maxxing` and nothing is recorded, so a later init tries again. Once done, a line the user changes
    back to `maxxing` stays. -> changed files."""
    from . import cmd_core
    key = str(ws.resolve())
    done = cmd_core._install_state().get(CLI_REFRESHED)
    done = [w for w in done if isinstance(w, str)] if isinstance(done, list) else []
    if key in done or not cmd_core.sessions_run_our_pilot():
        return []
    changed = migrate_cli_workspace(ws)
    try:
        cmd_core._save_install_state(**{CLI_REFRESHED: sorted({*done, key})})
    except OSError as e:                         # never stops an init or the local start-up: tried again next time
        log.warning("CLI guidance: %s not recorded: %s", ws, e)
    return changed


def _product_prompts() -> set[str]:
    """The prompts the product ships: default jobs (cmd_core) and starter-pack jobs."""
    from . import cmd_core
    prompts = {cmd_core.COMPACTION_JOB["prompt"], cmd_core.MORNING_TASKS_PROMPT}
    packs = config.TEMPLATES_DIR / "packs"
    for f in sorted(packs.glob("*/pack.json")) if packs.is_dir() else []:
        data = config.read_json(f, {}) or {}
        for c in data.get("crons", []) if isinstance(data, dict) else []:
            if isinstance(c, dict) and isinstance(c.get("prompt"), str):
                prompts.add(c["prompt"])
    return prompts


def migrate_jobs() -> list[str]:
    """Ids of the jobs whose prompt was a shipped prompt with the old skill names (never edited by the user)."""
    try:
        from . import crons
        jobs = crons.list_jobs()
    except Exception:  # noqa: BLE001 - no crons module / unreadable jobs.json: nothing to migrate
        return []
    product = _product_prompts()
    changed = []
    for j in jobs:
        prompt = j.get("prompt") or ""
        if not isinstance(prompt, str) or not has_old_skill(prompt):
            continue
        new = rename_skills(prompt)
        if new not in product:
            continue                      # written or edited by the user: left to Claude and the user
        try:
            crons.update_job(j["id"], {"prompt": new})
            changed.append(j["id"])
        except Exception as e:  # noqa: BLE001 - e.g. its topic was deleted: never fail an init for this
            log.warning("skill rename: job %s not migrated: %s", j.get("id"), e)
    return changed


def migrate(ws: Path) -> dict:
    """-> {"files": [relative paths], "jobs": [ids]} changed by the skill rename (empty once done)."""
    return {"files": migrate_workspace(ws), "jobs": migrate_jobs()}
