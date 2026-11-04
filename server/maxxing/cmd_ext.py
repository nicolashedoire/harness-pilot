"""`pilot ext` - extensions (widgets, pages, block plugins) from scripts and sessions.

    pilot ext check [ID] [--json]       run one extension (every one without ID) through the server's own path
    pilot ext check ID --dir PATH       the same for a draft folder (a temporary copy, in this process)
    pilot ext draft ID [--from-draft D] [--reset]    the draft folder to write a creation in (Atelier)
    pilot ext propose ID [--summary TEXT] [--dir PATH]   submit the draft for the user's approval (Atelier)

Exit codes of check: 0 everything checked works (warnings allowed), 1 at least one is broken, 2 no extension has
that id, 3 that extension is turned off (nothing was run). propose: 0 registered (or queued until the turn ends),
1 the check failed (nothing submitted), 2 no draft folder / bad id, 3 the instance is held after a restore.
See maxxing/extcheck.py, maxxing/atelier.py and docs/user/17-cli-reference.md.
"""
from __future__ import annotations

import json
import os
import sys
import time

from . import cli


def _configure(p) -> None:
    sub = p.add_subparsers(dest="action", required=True)
    c = sub.add_parser("check", help="load an extension, compute its card / parse its page or HTML as the server does")
    c.add_argument("id", nargs="?", help="the extension's folder name (all extensions when left out)")
    c.add_argument("--json", action="store_true", help="machine-readable result")
    c.add_argument("--dir", help="check this draft folder as the extension ID (its code runs in this process)")
    d = sub.add_parser("draft", help="create (or find) the draft folder of a creation and print its path")
    d.add_argument("id", help="the extension's id (folder name)")
    d.add_argument("--from-draft", dest="from_draft", help="start from the files of that proposal (d_...)")
    d.add_argument("--reset", action="store_true", help="replace an existing draft folder")
    d.add_argument("--json", action="store_true")
    pr = sub.add_parser("propose", help="submit a draft to the Atelier: nothing runs until the user approves it")
    pr.add_argument("id", help="the extension's id (folder name)")
    pr.add_argument("--summary", default="", help="what you made or changed, for the user (one or two sentences)")
    pr.add_argument("--dir", help="the draft folder (default: .atelier/<id> in the session's folder)")
    pr.add_argument("--json", action="store_true")


def _print(r: dict) -> None:
    from .cmd_core import FAIL, INFO, OK, WARN, line
    level = {"ok": OK, "warn": WARN, "error": FAIL, "skipped": INFO}
    print(f"{r['id']} ({r['kind']}) - {r['status']}")
    for s in r["steps"]:
        first, *rest = (s["detail"] or s["step"]).splitlines() or [s["step"]]
        line(level.get(s["status"], INFO), f"{s['step']:<9} {first}")
        for x in rest:
            print(f"      {x}")
    for fr in r.get("trace") or []:
        print(f"      at {fr}")
    errs = r.get("runtime_errors") or []
    if errs:
        print(f"  recorded while it ran (since its files last changed): {len(errs)}")
        for e in errs[:3]:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(e["at"]))
            print(f"    {e['where']:<6} {when}" + (f" x{e['count']}" if e["count"] > 1 else "") + f"  {e['message']}")
            for x in (e.get("stack") or "").splitlines()[:4]:
                print(f"           {x}")


def _session() -> tuple[str | None, str | None]:
    from .sessions import store
    sid = (os.environ.get("MAXXING_SESSION") or "").strip()
    agent = (os.environ.get("MAXXING_AGENT") or "").strip() or None
    return (sid if store.is_valid_id(sid) and store.read(sid) is not None else None), agent


def _draft(a) -> int:
    from . import atelier
    sid, _agent = _session()
    try:
        res = atelier.make_draft(a.id, sid, a.from_draft, a.reset)
    except atelier.AtelierError as e:
        print(f"{a.id}: {e.message}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"{a.id}: cannot write the draft folder ({e})", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(res, indent=2))
        return 0
    how = {"active": "a copy of the active version", "draft": f"the files of {a.from_draft}",
           "empty": "empty (a new creation)", "existing": "already there, left as it is"}[res["from"]]
    print(res["path"])
    print(f"  {how}. Write the creation there, check it with `pilot ext check {a.id} --dir {res['path']}`, then "
          f"submit it with `pilot ext propose {a.id} --summary \"...\"`.", file=sys.stderr)
    return 0


def _propose(a) -> int:
    from pathlib import Path

    from . import atelier, config
    sid, agent = _session()
    folder = Path(a.dir).expanduser().resolve() if a.dir else atelier.draft_folder(a.id, sid)
    if not folder.is_dir():
        print(f"{a.id}: no draft folder {folder} - create it with `pilot ext draft {a.id}`", file=sys.stderr)
        return 2
    if folder.name != a.id:
        print(f"{a.id}: the draft folder must be named {a.id} (it is {folder.name})", file=sys.stderr)
        return 2
    if config.load_config().get("restore_hold"):
        print("This restored instance is in review mode (Settings -> Backup): nothing can be proposed yet.",
              file=sys.stderr)
        return 3
    chk = atelier.check_dir(folder, a.id)
    if chk["status"] == "error":
        if a.json:
            print(json.dumps({"ok": False, "status": "check_failed", "check": chk}, indent=2, ensure_ascii=False))
        else:
            _print({"id": a.id, "kind": chk["type"], "status": chk["status"], "steps": chk["steps"]})
            print("Nothing was submitted: fix the errors above, then run `pilot ext propose` again.")
        return 1
    req = atelier.write_request(folder, a.id, a.summary, sid, agent)
    status, rec = "queued", None
    try:
        rec = atelier.register(folder)
        status = "active" if rec.get("status") == "approved" else "pending"
    except atelier.AtelierError as e:
        print(f"{a.id}: {e.message}", file=sys.stderr)
        with __import__("contextlib").suppress(OSError):
            (folder / atelier.REQUEST).unlink()
        return 3 if e.code == "restore_hold" else 2
    except OSError:
        pass                     # <state> is not writable here (Codex's sandbox): the server registers it at turn end
    did = req["draft"]
    perms = chk["permissions"]
    block = "```proposal\n" + json.dumps({"draft": did, "title": chk["name"]}, ensure_ascii=False) + "\n```"
    if a.json:
        print(json.dumps({"ok": True, "draft": did, "status": status, "id": a.id, "name": chk["name"],
                          "type": chk["type"], "permissions": perms, "check": chk["status"], "block": block},
                         indent=2, ensure_ascii=False))
        return 0
    when = {"pending": "is waiting for the user's approval in the Atelier",
            "queued": "is submitted: it reaches the Atelier when this turn ends, then waits for the user's approval",
            "active": "was activated at once (it declares no network and no secret, and the user allows that)"}
    print(f"Proposal {did}: {chk['name']} ({chk['type'].replace('_', ' ')}) {when[status]}.")
    print(f"  network: {', '.join(perms['network']) or 'none'} · secrets: {', '.join(perms['secrets']) or 'none'}"
          + (" · check: warnings" if chk["status"] == "warn" else ""))
    if status != "active":
        print("  Nothing of it runs or shows on the dashboard until the user approves it: tell the user it is "
              "waiting for them in the Atelier, and put this block in your answer (the user approves it from there):")
    print(block)
    return 0


def _check_dir(a) -> int:
    import shutil
    import tempfile
    from pathlib import Path

    from . import atelier, extcheck, extensions
    src = Path(a.dir).expanduser().resolve()
    if not src.is_dir():
        print(f"{a.id}: no folder {src}", file=sys.stderr)
        return 2
    tmp = Path(tempfile.mkdtemp(prefix="mx-extcheck-dir-"))
    saved = extensions._root_override, extensions._state_override, extensions.disabled_ids   # noqa: SLF001
    try:
        dest = tmp / "extensions" / a.id
        dest.mkdir(parents=True)
        for rel, p in atelier.walk(src)[0]:
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dest / rel)
        extensions._root_override, extensions._state_override = dest.parent, tmp / "state"   # noqa: SLF001
        extensions.disabled_ids = lambda: set()        # a draft is checked even when the installed one is off
        one = extcheck.check(a.id)
        if one is None:
            print(f"{a.id}: nothing to check in {src}", file=sys.stderr)
            return 2
        one["dir"], one["runtime_errors"] = str(src), []
        return _report([one], a, True)
    finally:
        extensions._root_override, extensions._state_override, extensions.disabled_ids = saved   # noqa: SLF001
        with __import__("contextlib").suppress(Exception):
            extensions.scan()                        # this process's registry: the real folder again
        shutil.rmtree(tmp, ignore_errors=True)


def _handler(a) -> int:
    from . import extcheck
    if a.action == "draft":
        return _draft(a)
    if a.action == "propose":
        return _propose(a)
    if getattr(a, "dir", None):
        if not a.id:
            print("--dir needs the extension's id: pilot ext check ID --dir PATH", file=sys.stderr)
            return 2
        return _check_dir(a)
    if a.id:
        one = extcheck.check(a.id)
        if one is None:
            print(f"{a.id}: no extension with this id in {_root()}", file=sys.stderr)
            return 2
        results = [one]
        try:                                    # run from a harness-pilot turn: the session that made / fixes it
            from . import extfix
            extfix.record_origin(a.id, os.environ.get("MAXXING_SESSION"))
        except Exception:  # noqa: BLE001 - never fails the check
            pass
    else:
        results = extcheck.check_all()
    return _report(results, a, bool(a.id))


def _report(results: list[dict], a, one: bool) -> int:
    from . import extcheck
    broken = [r for r in results if r["status"] == "error"]
    code = 1 if broken else 3 if one and results[0]["status"] == "skipped" else 0
    if a.json:
        print(json.dumps({"ok": not broken, "problems": len(broken), "extensions": results}, indent=2,
                         ensure_ascii=False, default=str))
    else:
        if not results:
            print(f"No extension in {_root()}")
        for r in results:
            _print(r)
        if len(results) > 1:
            print(f"{len(results)} extension(s), {len(broken)} broken")
    sys.stdout.flush()
    if extcheck.timed_out(results):         # a card() still holds a thread: leave without waiting for it
        sys.stderr.flush()
        os._exit(code)
    return code


def _root() -> str:
    from . import extensions
    return str(extensions.root())


cli.register("ext", "extensions: check one (or all) the way the server runs them", _configure, _handler)
