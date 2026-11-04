"""The product skill rename (old `maxxing-*` names -> `pilot-*`) and the `pilot` command, as an upgrade of an
existing install sees them.

Old names are only ever built from `renames.SKILL_RENAMES` here (never written literally), so a re-run of the
rename script on a merged tree leaves this file alone."""
from __future__ import annotations

import json
import logging
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


# ---- doctor: which `pilot` runs ----------------------------------------------------------------
def _program(path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)
    return path


def _paths(monkeypatch, shell: list, sessions: list | None = None) -> None:
    """The PATH of the shell running the doctor, and the one sessions get (spawn.base_env)."""
    from maxxing.sessions import spawn
    monkeypatch.setenv("PATH", ":".join(map(str, shell)))
    monkeypatch.setattr(spawn, "base_env", lambda: {"PATH": ":".join(map(str, shell if sessions is None else sessions))})


def test_doctor_warns_when_another_pilot_comes_first(tmp_path, monkeypatch):
    other = _program(tmp_path / "usr-bin" / "pilot", "#!/bin/sh\necho a file browser\n")
    _paths(monkeypatch, [other.parent])
    c = cmd_core.check_cli_name()
    assert c["id"] == "cli" and c["level"] == cmd_core.WARN
    assert str(other) in c["title"] and "not harness-pilot" in c["detail"]
    assert "use `maxxing`, the same command" in c["fix"]
    binary = _program(tmp_path / "bin2" / "pilot", "\x7fELF not a script")       # a compiled program: not ours
    _paths(monkeypatch, [binary.parent])
    assert cmd_core.check_cli_name()["level"] == cmd_core.WARN


def test_doctor_accepts_our_pilot_link_wrapper_and_venv_script(tmp_path, monkeypatch):
    link_dir = cmd_core.PILOT_LINK.parent
    _program(cmd_core.BIN_LINK, "#!/bin/bash\n# claude-maxxing CLI wrapper (custom state dir)\nexec /x/maxxing \"$@\"\n")
    cmd_core.PILOT_LINK.symlink_to("maxxing")                                     # what `init` creates
    _paths(monkeypatch, [link_dir])
    c = cmd_core.check_cli_name()
    assert c["level"] == cmd_core.OK and c["detail"] == str(cmd_core.PILOT_LINK)
    venv = _program(tmp_path / "venv" / "bin" / "pilot", "#!/x/python\nimport sys\nfrom maxxing.cli import main\n")
    _paths(monkeypatch, [venv.parent])                                            # `uv run pilot` in a checkout
    assert cmd_core.check_cli_name()["level"] == cmd_core.OK


def test_doctor_checks_the_pilot_that_sessions_run(tmp_path, monkeypatch):
    other = _program(tmp_path / "home-local-bin" / "pilot", "#!/bin/sh\necho other\n")
    _program(cmd_core.BIN_LINK, "#!/x/python\nfrom maxxing.cli import main\n")
    cmd_core.PILOT_LINK.symlink_to("maxxing")
    _paths(monkeypatch, [cmd_core.PILOT_LINK.parent], [other.parent, cmd_core.PILOT_LINK.parent])
    c = cmd_core.check_cli_name()
    assert c["level"] == cmd_core.WARN and "(sessions)" in c["title"] and "this shell" in c["detail"]
    assert f"put {cmd_core.PILOT_LINK.parent} before {other.parent}" in c["fix"]


def test_doctor_without_pilot_on_the_path(tmp_path, monkeypatch):
    _paths(monkeypatch, [tmp_path / "empty"])
    assert cmd_core.check_cli_name() is None                                      # a checkout, nothing installed
    _program(cmd_core.BIN_LINK, "#!/x/python\nfrom maxxing.cli import main\n")
    c = cmd_core.check_cli_name()
    assert c["level"] == cmd_core.INFO and "maxxing init" in c["fix"] and "`maxxing` works" in c["detail"]


def test_doctor_output_names_the_way_round(env, tmp_path, monkeypatch, capsys):
    run_cli("init", "--workspace", str(env["ws"]), "--quiet")
    other = _program(tmp_path / "usr-bin" / "pilot", "#!/bin/sh\necho other\n")
    _paths(monkeypatch, [other.parent, *os.environ["PATH"].split(":")])
    capsys.readouterr()
    run_cli("doctor", "--json", "--offline")
    ids = {c["id"]: c for c in json.loads(capsys.readouterr().out)["checks"]}
    assert ids["cli"]["level"] == "warn" and "maxxing doctor" in ids["cli"]["fix"]


# ---- the `pilot` command in the product instructions of an older workspace ----------------------
OUR_PILOT = "#!/x/python\nfrom maxxing.cli import main\n"              # uv's console script: this program
OTHER_PILOT = "#!/bin/sh\necho a file browser\n"
HELP = "projects/system/topics/help/CLAUDE.md"
ROOT_LINE = "UI; the server CLI is `pilot` (`maxxing`, its earlier name, still works):"
HELP_LINE = "| `17-cli-reference.md` | every `pilot` command (`maxxing`, its earlier name, still works) |"


def _sessions_path(monkeypatch, *dirs) -> None:
    """The PATH the sessions get (spawn.base_env), where refresh_cli_guidance looks for their `pilot`."""
    from maxxing.sessions import spawn
    monkeypatch.setattr(spawn, "base_env", lambda: {"PATH": ":".join(map(str, dirs))})


def _as_older_version(ws) -> dict:
    """The root and help-topic CLAUDE.md as a version before `pilot` wrote them, and an install.json without the
    record of the refresh -> {relative path: current text}."""
    current = {}
    for rel, line, before in (("CLAUDE.md", ROOT_LINE, "UI; the server CLI is `maxxing`:"),
                              (HELP, HELP_LINE, "| `17-cli-reference.md` | every `maxxing` command |")):
        f = ws / rel
        current[rel] = f.read_text()
        assert line in current[rel].splitlines()
        f.write_text(current[rel].replace(line, before).replace("`pilot ", "`maxxing "))
    st = cmd_core._install_state()
    st.pop(renames.CLI_REFRESHED, None)
    config.write_json(config.STATE / "install.json", st)
    return current


def test_templates_give_one_alias_note():
    """The three product texts naming the command say `pilot` with the same note on `maxxing`."""
    ws = config.TEMPLATES_DIR / "workspace"
    assert ROOT_LINE in (ws / "CLAUDE.md").read_text().splitlines()
    assert HELP_LINE in (ws / HELP).read_text().splitlines()
    assert "`maxxing`, its earlier name, still works)." in (ws / "projects/system/CLAUDE.md").read_text()
    for f in ws.rglob("CLAUDE.md"):
        text = f.read_text()
        assert text.count("earlier name") == text.count("`maxxing`, its earlier name, still works"), f


def test_retained_doctor_guidance_is_refreshed_without_rewriting_custom_lines(env):
    ws = env['ws']
    cmd_core.copy_templates(ws)
    root = ws / 'CLAUDE.md'
    canonical = root.read_text()
    before = canonical.replace('`pilot ', '`maxxing ').replace(ROOT_LINE, 'UI; the server CLI is `maxxing`:')
    custom = '\nMy own command: `maxxing doctor --offline` for my legacy script.\n'
    root.write_text(before + custom)
    root.chmod(0o640)
    changed = renames.migrate_cli_workspace(ws)
    assert 'CLAUDE.md' in changed
    assert root.read_text() == canonical + custom
    assert root.stat().st_mode & 0o777 == 0o640
    assert renames.migrate_cli_workspace(ws) == []
    from maxxing.sessions import codex
    context = codex.workspace_context(ws, ws)
    assert '| `pilot doctor [--json]` |' in context
    assert '| `maxxing doctor [--json]` |' not in context


def test_init_refreshes_the_command_once_so_a_line_changed_back_stays(env, tmp_path, monkeypatch):
    ws = env["ws"]
    ours = tmp_path / "venv-bin" / "pilot"
    _program(ours, OUR_PILOT)
    _sessions_path(monkeypatch, ours.parent)
    assert run_cli("init", "--workspace", str(ws), "--quiet") == 0
    record = json.loads((env["state"] / "install.json").read_text())[renames.CLI_REFRESHED]
    assert record == [str(ws.resolve())]                              # a new workspace: nothing to do, recorded
    current = _as_older_version(ws)
    assert run_cli("init", "--quiet") == 0
    assert {rel: (ws / rel).read_text() for rel in current} == current
    root = ws / "CLAUDE.md"
    mine = current["CLAUDE.md"].replace("| `pilot doctor [--json]` |", "| `maxxing doctor [--json]` |")
    assert mine != current["CLAUDE.md"]
    root.write_text(mine)                                             # the user wants `maxxing` there, after the refresh
    assert run_cli("init", "--quiet") == 0
    assert root.read_text() == mine                                   # never reverted
    assert renames.refresh_cli_guidance(ws) == []


def test_no_refresh_while_another_program_is_pilot(env, monkeypatch, capsys):
    """ensure_cli_alias keeps a `pilot` that is not ours and the agents use `maxxing`: the product lines keep it,
    nothing is recorded; once the link is ours (made by the same init), they get `pilot`."""
    ws = env["ws"]
    assert run_cli("init", "--workspace", str(ws), "--quiet") == 0
    current = _as_older_version(ws)
    older = {rel: (ws / rel).read_text() for rel in current}
    monkeypatch.delenv("MAXXING_SPAWN", raising=False)                # a server installation
    monkeypatch.setattr(cmd_core, "SYSTEMD_DIR", env["tmp"] / "no-systemd")
    _program(cmd_core.BIN_LINK, OUR_PILOT)
    _program(cmd_core.PILOT_LINK, OTHER_PILOT)
    _sessions_path(monkeypatch, cmd_core.PILOT_LINK.parent)
    assert run_cli("init", "--json") == 0
    report = json.loads(capsys.readouterr().out)
    assert "another program" in report["cli"] and report["cli_guidance"] == []
    assert {rel: (ws / rel).read_text() for rel in current} == older
    assert renames.CLI_REFRESHED not in cmd_core._install_state()
    cmd_core.PILOT_LINK.unlink()                                      # the user removes the other program
    assert run_cli("init") == 0
    out = capsys.readouterr().out
    assert "pilot: created" in out and "command `pilot` in the product instructions of 2 workspace file(s)" in out
    assert "new skill names" not in out
    assert {rel: (ws / rel).read_text() for rel in current} == current
    assert cmd_core._install_state()[renames.CLI_REFRESHED] == [str(ws.resolve())]


def test_only_the_known_earlier_lines_change_their_alias_note(env):
    ws = env['ws']; cmd_core.copy_templates(ws)
    root, help_file = ws / 'CLAUDE.md', ws / HELP
    current, help_current = root.read_text(), help_file.read_text()
    first = '| `17-cli-reference.md` | every `pilot` command (`maxxing` = the same command, earlier name) |'
    help_file.write_text(help_current.replace(HELP_LINE, first))       # the first `pilot` text of the help topic
    mine = ('| `maxxing doctor [--json]` (`maxxing`, its earlier name, still works) | full health check with fix hints |\n'
            '| `maxxing status` (`maxxing` = the same command, earlier name) | version, URL, service, Claude auth, '
            'Telegram, backup |\n' + first + '\n')
    root.write_text(current + mine)                                    # notes the user wrote, the help line elsewhere
    assert renames.migrate_cli_workspace(ws) == [HELP]
    assert help_file.read_text() == help_current
    assert root.read_text() == current + mine


def test_a_read_only_file_is_left(env, caplog):
    caplog.set_level(logging.INFO, logger='maxxing.renames')
    ws = env['ws']; cmd_core.copy_templates(ws)
    root = ws / 'CLAUDE.md'
    current = root.read_text()
    older = as_before(current).replace('`pilot ', '`maxxing ')
    root.write_text(older)
    root.chmod(0o444)                                                  # the folder stays writable: os.replace could
    try:
        assert renames.migrate_cli_workspace(ws) == []
        assert renames.migrate_workspace(ws) == []
        assert root.read_text() == older
        assert 'read-only' in caplog.text
        root.chmod(0o644)
        assert renames.migrate_workspace(ws) == ['CLAUDE.md'] and renames.migrate_cli_workspace(ws) == ['CLAUDE.md']
        assert root.read_text() == current
    finally:
        root.chmod(0o644)


@pytest.mark.parametrize("end", ["\f", "\u2028", "\x85", "\v"])
def test_a_line_keeps_its_own_end(env, monkeypatch, end):
    """str.splitlines also ends a line at a form feed, U+2028, NEL...: a changed line keeps it (never joined)."""
    template_root = env['tmp'] / 'templates'
    (template_root / 'workspace').mkdir(parents=True)
    text = 'Run `pilot doctor`.\nThen `pilot status`.\nUse the pilot-tasks skill.\nEnd.\n'
    (template_root / 'workspace/CLAUDE.md').write_text(text)
    monkeypatch.setattr(config, 'TEMPLATES_DIR', template_root)
    ws = env['ws']; ws.mkdir()
    f = ws / 'CLAUDE.md'
    f.write_bytes(as_before(text).replace('`pilot ', '`maxxing ').replace('\n', end, 3).encode())
    assert renames.migrate_cli_workspace(ws) == ['CLAUDE.md']
    assert renames.migrate_workspace(ws) == ['CLAUDE.md']
    assert f.read_bytes() == text.replace('\n', end, 3).encode()


def test_a_file_over_the_size_cap_is_skipped(env, caplog):
    ws = env['ws']; cmd_core.copy_templates(ws)
    root = ws / 'CLAUDE.md'
    older = as_before(root.read_text()).replace('`pilot ', '`maxxing ')
    big = older + ('<!-- notes -->\n' * ((1 << 20) // 15 + 1))         # over 1 MiB: no template's copy
    assert len(big.encode()) > 1 << 20
    root.write_text(big)
    assert renames.migrate_cli_workspace(ws) == [] and renames.migrate_workspace(ws) == []
    assert root.read_text() == big
    assert 'larger than' in caplog.text and renames.MAX_FILE_BYTES == 1 << 20


def test_guidance_refresh_keeps_modules_services_paths_and_line_endings(env, monkeypatch):
    template_root = env['tmp'] / 'templates'
    (template_root / 'workspace').mkdir(parents=True)
    text = 'Run `pilot doctor`.\nUse `python -m maxxing`.\nService `claude-maxxing`.\nPath `/root/maxxing`.\n'
    (template_root / 'workspace/CLAUDE.md').write_text(text)
    monkeypatch.setattr(config, 'TEMPLATES_DIR', template_root)
    ws = env['ws']; ws.mkdir()
    mine = ('Run `maxxing doctor`.\n'                                   # the template's line: refreshed
            'Use `python -m maxxing serve` on my laptop.\n'             # lines that differ from the template: kept
            'Service `claude-maxxing` restarts at night.\n'
            'Path `/root/maxxing/projects`, see `maxxing status`.\n'
            'Run `maxxing doctor` every morning.\n'
            'Use `python -m maxxing`.\n')                               # equal to the template: nothing to change
    (ws / 'CLAUDE.md').write_bytes(mine.replace('\n', '\r\n').encode())
    assert renames.migrate_cli_workspace(ws) == ['CLAUDE.md']
    expected = mine.replace('Run `maxxing doctor`.\n', 'Run `pilot doctor`.\n', 1)
    assert (ws / 'CLAUDE.md').read_bytes() == expected.replace('\n', '\r\n').encode()


def test_guidance_refresh_never_follows_a_linked_topic(env):
    ws = env['ws']; cmd_core.copy_templates(ws)
    topic = ws / 'projects/system/topics/help'
    outside = env['tmp'] / 'outside-topic'
    shutil.copytree(topic, outside)
    original = (outside / 'CLAUDE.md').read_text().replace('`pilot ', '`maxxing ')
    (outside / 'CLAUDE.md').write_text(original)
    shutil.rmtree(topic); topic.symlink_to(outside, target_is_directory=True)
    assert renames.migrate_cli_workspace(ws) == []
    assert (outside / 'CLAUDE.md').read_text() == original


def test_local_launcher_refreshes_workspace_guidance_without_migrating_jobs():
    script = (config.CODE / 'scripts/dev-local.sh').read_text()
    assert 'renames.migrate_workspace(ws)' in script
    assert 'renames.refresh_cli_guidance(ws)' in script               # once, and only when `pilot` is ours
    assert 'renames.migrate_cli_workspace(ws)' not in script and 'renames.migrate(ws)' not in script
