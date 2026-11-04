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
  CLI references in recognized template-owned CLAUDE.md lines are also refreshed to the current spelling.
  Text the user wrote is never touched: Claude proposes those changes to the user (upgrade notes).
"""
from __future__ import annotations

import logging
import os
import re
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
_CLI_ALIAS_NOTES = (" (`maxxing`, its earlier name, still works)",
                    " (`maxxing` = the same command, earlier name)")
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
    if dst.is_symlink() or not dst.is_file():
        return 0
    try:
        text = dst.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0
    if not has_old_skill(text):
        return 0
    from .cmd_core import render_template
    try:
        product = {_neutral(ln) for ln in render_template(template.read_text(encoding="utf-8"), variables).splitlines()}
    except (OSError, UnicodeDecodeError):
        return 0
    out, n = [], 0
    for ln in text.splitlines(keepends=True):
        body = ln.rstrip("\r\n")
        if has_old_skill(body):
            new = rename_skills(body)
            if _neutral(new) in product:
                ln = new + ln[len(body):]
                n += 1
        out.append(ln)
    if n:
        _write_text(dst, "".join(out))
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
    """Refresh only original product instruction lines; custom prose and historical messages are untouched."""
    from .cmd_core import render_template, template_vars
    variables = template_vars(ws)
    changed = []
    for template, dst in _template_pairs(ws):
        try:
            if dst.name != 'CLAUDE.md' or not _workspace_file(ws, dst) or not dst.is_file():
                continue
            text = dst.read_bytes().decode('utf-8')  # keep CRLF and missing final newlines
            if not _OLD_CLI.search(text):
                continue
            current = render_template(template.read_text(encoding='utf-8'), variables).splitlines()
            product = {_neutral(line): line for line in current}
            out, n = [], 0
            for line in text.splitlines(keepends=True):
                body = line.rstrip('\r\n')
                lookup = body
                for note in _CLI_ALIAS_NOTES:
                    lookup = lookup.replace(note, '')
                target = product.get(_neutral(lookup))
                if target is not None and _OLD_CLI.search(body) and target != body:
                    line = target + line[len(body):]
                    n += 1
                out.append(line)
            if n:
                _write_text(dst, ''.join(out))
                changed.append(str(dst.relative_to(ws)))
        except (OSError, UnicodeDecodeError) as error:
            log.warning('CLI guidance: %s not migrated: %s', dst, error)
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
    """-> {"files": [relative paths], "jobs": [ids]} changed by product-name migrations (empty once done)."""
    files = migrate_workspace(ws) + migrate_cli_workspace(ws)
    return {"files": list(dict.fromkeys(files)), "jobs": migrate_jobs()}
