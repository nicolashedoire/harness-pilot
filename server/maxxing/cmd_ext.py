"""`pilot ext` - extensions (widgets, pages, block plugins) from scripts and sessions.

    pilot ext check [ID] [--json]       run one extension (every one without ID) through the server's own path

Exit codes: 0 everything checked works (warnings allowed), 1 at least one is broken, 2 no extension has that id,
3 that extension is turned off (nothing was run). See maxxing/extcheck.py and docs/user/17-cli-reference.md.
"""
from __future__ import annotations

import json
import os
import sys

from . import cli


def _configure(p) -> None:
    sub = p.add_subparsers(dest="action", required=True)
    c = sub.add_parser("check", help="load an extension, compute its card / parse its page or HTML as the server does")
    c.add_argument("id", nargs="?", help="the extension's folder name (all extensions when left out)")
    c.add_argument("--json", action="store_true", help="machine-readable result")


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


def _handler(a) -> int:
    from . import extcheck
    if a.id:
        one = extcheck.check(a.id)
        if one is None:
            print(f"{a.id}: no extension with this id in {_root()}", file=sys.stderr)
            return 2
        results = [one]
    else:
        results = extcheck.check_all()
    broken = [r for r in results if r["status"] == "error"]
    code = 1 if broken else 3 if a.id and results[0]["status"] == "skipped" else 0
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
