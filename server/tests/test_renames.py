"""The product skill rename (old `maxxing-*` names -> `pilot-*`) and the `pilot` command, as an upgrade of an
existing install sees them.

Old names are only ever built from `renames.SKILL_RENAMES` here (never written literally), so a re-run of the
rename script on a merged tree leaves this file alone."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tomllib

import pytest

from maxxing import cli, cmd_core, config, renames
from test_cmd_core import env, run_cli  # noqa: F401  (fixtures)

OLD_TO_NEW = renames.SKILL_RENAMES
NEW_TO_OLD = {new: old for old, new in OLD_TO_NEW.items()}
_NEW = re.compile(r"(?<![\w-])(" + "|".join(map(re.escape, sorted(NEW_TO_OLD, key=len, reverse=True))) + r")(?![\w-])")


def as_before(text: str) -> str:
    """What an earlier version wrote: the same text with the old skill names."""
    return _NEW.sub(lambda m: NEW_TO_OLD[m.group(1)], text)


def test_mapping_matches_the_shipped_skills():
    shipped = {p.name for p in config.SKILLS_DIR.iterdir() if (p / "SKILL.md").is_file()}
    assert set(OLD_TO_NEW.values()) <= shipped
    assert not shipped & set(OLD_TO_NEW), "an old skill folder is back: run the rename script"
    for name in shipped:
        head = (config.SKILLS_DIR / name / "SKILL.md").read_text(encoding="utf-8").split("\n---", 1)[0]
        assert f"\nname: {name}\n" in head + "\n", f"{name}: the front matter `name:` must be the folder name"
    assert set(cmd_core.product_skill_names()) == shipped


def test_no_live_text_names_an_old_skill():
    """A merge that brings back an old skill name fails here: re-run the rename script (history files excepted)."""
    roots = [config.SKILLS_DIR, config.TEMPLATES_DIR, config.CODE / "docs" / "user", config.CODE / "server" / "maxxing",
             config.CODE / "web" / "src"]
    files = [config.CODE / "docs" / "dev" / "INTERNALS.md", config.CODE / "install.sh", config.CODE / "README.md"]
    for root in roots:
        files += [f for f in root.rglob("*") if f.is_file() and "__pycache__" not in f.parts
                  and f.suffix in (".md", ".py", ".json", ".txt", ".ts", ".tsx", ".sh", ".toml", ".js")]
    left = []
    for f in files:
        if f.name == "renames.py":
            continue
        for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for m in re.finditer(r"(?<![\w-])(" + "|".join(map(re.escape, OLD_TO_NEW)) + r")(?![\w-])(?!/\{)", line):
                if OLD_TO_NEW[m.group(1)] not in line:            # a line naming both is a mapping (old -> new)
                    left.append(f"{f.relative_to(config.CODE)}:{i}")
    assert not left, left


def test_upgrade_installs_the_pilot_skills_and_drops_the_old_copies(env, tmp_path, monkeypatch):
    """An install made by an earlier version has the old skill folders in <claude dir>/skills: the next init
    installs the new ones, deletes the old copies it had installed and moves an unrecorded one to the trash."""
    real = config.SKILLS_DIR
    before = tmp_path / "skills-before"
    for new, old in NEW_TO_OLD.items():
        shutil.copytree(real / new, before / old)
        md = before / old / "SKILL.md"
        md.write_text(as_before(md.read_text(encoding="utf-8")), encoding="utf-8")
    shutil.copytree(real / "memory", before / "memory")
    monkeypatch.setattr(config, "SKILLS_DIR", before)
    assert run_cli("init", "--workspace", str(env["ws"]), "--quiet") == 0
    target = env["home"] / ".claude" / "skills"
    assert sorted(p.name for p in target.iterdir()) == sorted([*OLD_TO_NEW, "memory"])
    (target / "my-skill").mkdir()
    (target / "my-skill" / "SKILL.md").write_text("keep me")
    # one old copy the product has no record of (installed by hand, restored from somewhere...)
    stray = sorted(OLD_TO_NEW)[0]
    state_file = env["state"] / "install.json"
    st = json.loads(state_file.read_text())
    st["skills"].remove(stray)
    state_file.write_text(json.dumps(st))

    monkeypatch.setattr(config, "SKILLS_DIR", real)                    # the update brings the renamed skills
    assert run_cli("init", "--quiet") == 0
    names = {p.name for p in target.iterdir()}
    assert set(OLD_TO_NEW.values()) <= names and not names & set(OLD_TO_NEW)
    assert names == set(cmd_core.product_skill_names()) | {"my-skill"}
    assert (target / "my-skill" / "SKILL.md").read_text() == "keep me"
    trash = sorted((env["state"] / "trash" / "skills").iterdir())
    assert [p.name.rsplit("-", 1)[0] for p in trash] == [stray]          # never deleted: it was not ours
    assert renames.has_old_skill((trash[0] / "SKILL.md").read_text())
    assert json.loads(state_file.read_text())["skills"] == cmd_core.product_skill_names()
    assert all(s["state"] == "ok" for s in cmd_core.skills_status())
    for name in OLD_TO_NEW.values():                                  # cross-references use the new names
        assert not renames.has_old_skill((target / name / "SKILL.md").read_text())


def test_init_renames_old_skills_in_product_lines_only(env):
    ws = env["ws"]
    assert run_cli("init", "--workspace", str(ws), "--quiet") == 0
    root = ws / "CLAUDE.md"
    current = root.read_text()
    assert not renames.has_old_skill(current) and "pilot-tasks" in current
    # what an earlier version wrote: old skill names, and the CLI still called `maxxing` in its text
    lines = [re.sub(r"`pilot ", "`maxxing ", ln) for ln in as_before(current).splitlines(keepends=True)]
    old = next(i for i, ln in enumerate(lines) if renames.has_old_skill(ln))
    edited = lines[old].rstrip("\n") + " (my own words)\n"           # a product line the user edited
    lines[old] = edited
    mine = f"- My rule: use the {NEW_TO_OLD['pilot-crons']} skill only after asking me.\n"   # written by the user
    root.write_text("".join(lines) + mine)

    assert run_cli("init", "--quiet") == 0
    after = root.read_text().splitlines(keepends=True)
    assert after[old] == edited and after[-1] == mine                 # user text: untouched
    expected = [ln if i == old else renames.rename_skills(ln) for i, ln in enumerate(lines)] + [mine]
    assert after == expected                                          # only the old skill names changed
    assert sum(renames.has_old_skill(ln) for ln in after) == 2


def test_init_renames_old_skills_in_a_starter_pack_copy(env):
    packs = pytest.importorskip("maxxing.packs")
    assert run_cli("init", "--workspace", str(env["ws"]), "--quiet") == 0
    packs.install("freelance")
    second = packs.install("freelance")["project"]                    # freelance-2
    f = env["ws"] / "projects" / second / "CLAUDE.md"
    current = f.read_text()
    assert second == "freelance-2" and _NEW.search(current)
    f.write_text(as_before(current))
    assert renames.migrate(env["ws"])["files"] == [f"projects/{second}/CLAUDE.md"]
    assert f.read_text() == current
    assert renames.migrate(env["ws"]) == {"files": [], "jobs": []}   # done once


def test_init_renames_the_skill_in_default_job_prompts_never_edited(env):
    crons = pytest.importorskip("maxxing.crons")
    assert run_cli("init", "--workspace", str(env["ws"]), "--quiet") == 0
    morning = next(j for j in crons.list_jobs() if j["name"] == "Morning tasks")
    assert morning["prompt"] == cmd_core.MORNING_TASKS_PROMPT and "pilot-tasks" in morning["prompt"]
    crons.update_job(morning["id"], {"prompt": as_before(morning["prompt"])})     # as an earlier version made it
    own = as_before("Use the pilot-tasks skill, then post the summary with the pilot-notifications skill.")
    mine = crons.create_job({"name": "Mine", "schedule": "0 7 * * *", "kind": "claude",
                             "topic_path": "projects/general/topics/inbox", "prompt": own, "enabled": False})
    assert run_cli("init", "--quiet") == 0
    assert crons.get_job(morning["id"])["prompt"] == cmd_core.MORNING_TASKS_PROMPT
    assert crons.get_job(mine["id"])["prompt"] == own                  # the user's job: left as written
    assert renames.migrate_jobs() == []


# ---- the `pilot` command ---------------------------------------------------------------------
def test_pyproject_exposes_pilot_and_the_maxxing_alias():
    scripts = tomllib.loads((config.CODE / "server" / "pyproject.toml").read_text())["project"]["scripts"]
    assert scripts["pilot"] == scripts["maxxing"] == "maxxing.cli:main"


@pytest.mark.parametrize("argv0, prog", [("/usr/local/bin/pilot", "pilot"), ("/usr/local/bin/maxxing", "maxxing"),
                                          ("/opt/x/server/maxxing/__main__.py", "pilot")])
def test_help_shows_the_name_the_command_was_called_by(argv0, prog, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", [argv0, "--help"])
    with pytest.raises(SystemExit):
        cli.main(["--help"])
    out = capsys.readouterr().out
    assert out.startswith(f"usage: {prog} ") and "alias" in out


def test_init_links_pilot_next_to_the_maxxing_command(env, monkeypatch):
    monkeypatch.delenv("MAXXING_SPAWN", raising=False)
    link, pilot = cmd_core.BIN_LINK, cmd_core.PILOT_LINK
    assert cmd_core.ensure_cli_alias().startswith("skipped")            # no installed command (a dev checkout)
    link.symlink_to("/nonexistent/.venv/bin/maxxing")
    assert cmd_core.ensure_cli_alias() == "created"
    assert os.readlink(pilot) == link.name                            # same entry point, same state dir
    assert cmd_core.ensure_cli_alias() == "ok"
    pilot.unlink()
    pilot.write_text("#!/bin/sh\necho another program\n")             # a `pilot` that is not ours: kept
    assert "kept" in cmd_core.ensure_cli_alias()
    assert pilot.read_text() == "#!/bin/sh\necho another program\n"
    monkeypatch.setenv("MAXXING_SPAWN", "direct")
    assert cmd_core.ensure_cli_alias().startswith("skipped")            # tests and dev servers


def test_uninstall_removes_the_pilot_link_only_when_ours(env):
    assert run_cli("init", "--workspace", str(env["ws"]), "--quiet") == 0
    cmd_core.BIN_LINK.symlink_to("/nonexistent/.venv/bin/maxxing")
    cmd_core.PILOT_LINK.symlink_to("maxxing")
    assert run_cli("uninstall", "--yes") == 0
    assert not cmd_core.PILOT_LINK.is_symlink() and not cmd_core.BIN_LINK.is_symlink()
    cmd_core.PILOT_LINK.write_text("another program")
    assert run_cli("uninstall", "--yes") == 0
    assert cmd_core.PILOT_LINK.read_text() == "another program"
