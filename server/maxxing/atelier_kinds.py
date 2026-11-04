"""The Atelier's read-only kinds: saved themes, workspace skills, product customizations and cron jobs, listed as
AtelierItems (docs/dev/API.md#atelier) from their own modules - nothing is copied, nothing is versioned (rollback is
`422 not_versioned`). Provenance only where it is known (a theme made by the generator in a session, a job's topic).

Also `mirror_skills()`: Codex does not read Claude's `.claude/skills`; the workspace skills are copied into Codex's
skills folder (`cmd_core.codex_skills_target()`, where the product skills are) so Codex sessions see them too. Only
folders this module wrote (marker `.pilot-workspace-skill`) are ever replaced or removed there.
"""
from __future__ import annotations

import hashlib
import logging
import re
import shutil
import time
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("maxxing.atelier")
MIRROR_MARK = ".pilot-workspace-skill"
SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")


def _ro(kind: str, iid: str, name: str, icon: str, state: str, **extra: Any) -> dict:
    out = {"kind": kind, "id": iid, "type": kind, "name": name, "icon": icon, "state": state, "version": None,
           "version_label": None, "versions": 0, "pending": None, "unreviewed": False, "unreviewed_since": None,
           "origin": None, "approval": None, "error": None, "updated": None, "href": None, "actions": []}
    out.update(extra)
    return out


# ---- themes -------------------------------------------------------------------------------------------------------
def _themes() -> list[dict]:
    from . import themes
    try:
        saved = themes.saved()
    except Exception:  # noqa: BLE001 - a damaged themes.json lists nothing
        return []
    look = config.load_config().get("look") or {}
    applied = None
    try:
        if isinstance(look, dict) and isinstance(look.get("palette"), dict):
            applied = themes._colours(themes.clean_theme(look["palette"]))           # noqa: SLF001
    except Exception:  # noqa: BLE001
        applied = None
    out = []
    for e in saved:
        t = e["theme"]
        name = t.get("name") or e.get("from") or "Theme"
        on = applied is not None and themes._colours(t) == applied                    # noqa: SLF001
        origin = None
        if e.get("source") == "created":                    # the theme generator (a session wrote it)
            origin = {"agent": "unknown", "session": None, "session_title": None, "session_path": None,
                      "at": e.get("saved"), "summary": None}
        elif e.get("source") == "received":
            origin = {"agent": "user", "session": None, "session_title": None, "session_path": None,
                      "at": e.get("saved"), "summary": f"received from {e['from']}" if e.get("from") else None}
        out.append(_ro("theme", e["id"], str(name)[:80], "palette", "active" if on else "disabled",
                       origin=origin, updated=e.get("saved"), href="/settings/appearance",
                       source=e.get("source")))
    return out


# ---- skills -------------------------------------------------------------------------------------------------------
def _front(text: str) -> dict[str, str]:
    m = re.match(r"^---\s*\n(.*?)\n---\s*(\n|$)", text, re.S)
    out: dict[str, str] = {}
    for line in (m.group(1).splitlines() if m else []):
        k, sep, v = line.partition(":")
        if sep and k.strip() in ("name", "description"):
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _product_names() -> set[str]:
    from . import cmd_core
    try:
        return set(cmd_core.product_skill_names())
    except Exception:  # noqa: BLE001
        return set()


def workspace_skills() -> dict[str, dict]:
    """{name: {dir, agents, name, description, updated}} of `<workspace>/.claude/skills` and `.agents/skills`
    (product skills excluded)."""
    ws = config.workspace()
    product = _product_names()
    found: dict[str, dict] = {}
    for sub, agent in ((".claude/skills", "claude"), (".agents/skills", "codex")):
        base = ws / sub
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir()):
            md = d / "SKILL.md"
            if d.name.startswith(".") or d.name in product or not SKILL_NAME_RE.match(d.name) or not md.is_file():
                continue
            try:
                text = md.read_text("utf-8", "replace")[:8000]
                mtime = md.stat().st_mtime
            except OSError:
                continue
            fm = _front(text)
            it = found.setdefault(d.name, {"dir": str(d), "agents": [], "name": fm.get("name") or d.name,
                                           "description": fm.get("description") or "", "updated": mtime})
            it["agents"].append(agent)
            it["updated"] = max(it["updated"], mtime)
    mirrored = _mirrored()
    for name, it in found.items():
        if "codex" not in it["agents"] and name in mirrored:
            it["agents"].append("codex")
    return found


def _skills() -> list[dict]:
    return [_ro("skill", name, it["name"][:80], "sparkles", "active", updated=it["updated"],
                agents=sorted(set(it["agents"])), description=it["description"][:300], path=it["dir"])
            for name, it in sorted(workspace_skills().items())]


def _sig(d: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(d.rglob("*")):
        if p.is_file() and not p.is_symlink() and not any(x.startswith(".") for x in p.relative_to(d).parts):
            st = p.stat()
            h.update(f"{p.relative_to(d)}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8", "surrogateescape"))
    return h.hexdigest()


def _mirror_dir() -> Path:
    from . import cmd_core
    return cmd_core.codex_skills_target()


def _mirrored() -> set[str]:
    try:
        base = _mirror_dir()
        return {d.name for d in base.iterdir() if (d / MIRROR_MARK).is_file()} if base.is_dir() else set()
    except OSError:
        return set()


def mirror_skills() -> dict:
    """Copy `<workspace>/.claude/skills/<name>/` into Codex's skills folder (only names no other folder holds there,
    marked with MIRROR_MARK = the source signature); remove the mirrors whose source is gone. -> {copied, removed}."""
    copied, removed = [], []
    try:
        dst_root = _mirror_dir()
        src_root = config.workspace() / ".claude" / "skills"
        product = _product_names()
        sources = {d.name: d for d in sorted(src_root.iterdir())
                   if d.is_dir() and not d.is_symlink() and (d / "SKILL.md").is_file() and SKILL_NAME_RE.match(d.name)
                   and d.name not in product} if src_root.is_dir() else {}
        for name, src in sources.items():
            dst = dst_root / name
            if dst.exists() and not (dst / MIRROR_MARK).is_file():
                continue                                   # the user's own Codex skill (or a product one): never ours
            sig = _sig(src)
            if (dst / MIRROR_MARK).is_file() and (dst / MIRROR_MARK).read_text().strip() == sig:
                continue
            tmp = dst_root / f".{name}.tmp-{time.time_ns()}"
            shutil.copytree(src, tmp, symlinks=False, ignore=shutil.ignore_patterns(".*"))
            (tmp / MIRROR_MARK).write_text(sig + "\n")
            if dst.exists():
                shutil.rmtree(dst)
            tmp.rename(dst)
            copied.append(name)
        if dst_root.is_dir():
            for d in dst_root.iterdir():
                if (d / MIRROR_MARK).is_file() and d.name not in sources:
                    shutil.rmtree(d, ignore_errors=True)
                    removed.append(d.name)
    except OSError:
        log.warning("workspace skills not mirrored for Codex", exc_info=True)
    return {"copied": copied, "removed": removed}


# ---- customizations -------------------------------------------------------------------------------------------------
_customs_cache: dict[str, Any] = {"at": 0.0, "key": None, "items": []}
CUSTOMS_TTL_S = 30.0


def _list_customs() -> list[dict]:
    """customs.list_customs() (git commands) at most every CUSTOMS_TTL_S for the same HEAD."""
    from . import customs
    try:
        key = (config.CODE / ".git" / "HEAD").stat().st_mtime_ns
    except OSError:
        key = None
    now = time.time()
    if _customs_cache["key"] == key and now - _customs_cache["at"] < CUSTOMS_TTL_S:
        return _customs_cache["items"]
    items = customs.list_customs()
    _customs_cache.update(at=now, key=key, items=items)
    return items


def _customs() -> list[dict]:
    from . import customs
    try:
        items = _list_customs()
        pend = customs.pending() or {}
    except Exception:  # noqa: BLE001 - not a git checkout, git missing
        return []
    conflict = pend.get("reason") == "conflict"
    files = set(pend.get("conflicts") or [])
    titles = set(pend.get("customs") or [])
    out = []
    for c in items:
        review = conflict and (bool(files & set(c.get("files") or [])) or (not files and c["title"] in titles))
        err = None
        if review:
            target = pend.get("target_version") or pend.get("target") or "the new version"
            touched = sorted(files & set(c.get("files") or []))
            err = {"message": f"conflicts with the update to {target}" + (f": {', '.join(touched[:3])}" if touched
                                                                           else ""),
                   "where": "check", "at": pend.get("at"), "count": 1}
        saved = None
        try:
            saved = time.mktime(time.strptime(c.get("saved") or "", "%Y-%m-%d"))
        except ValueError:
            pass
        out.append(_ro("customization", c["id"], c["title"][:80] or c["id"], "wrench", "review" if review else "active",
                       error=err, updated=saved, href="/settings/updates", description=(c.get("why") or "")[:300],
                       files_changed=c.get("files") or []))
    return out


# ---- cron jobs ----------------------------------------------------------------------------------------------------
def _crons() -> list[dict]:
    from . import crons
    try:
        jobs = crons.list_jobs()
    except Exception:  # noqa: BLE001 - a damaged jobs.json is reported by the Crons page
        return []
    out = []
    for j in jobs:
        last = j.get("last_run") or {}
        err = None
        if last and last.get("ok") is False:
            err = {"message": f"the last run failed (exit code {last.get('code')})", "where": "run",
                   "at": last.get("at"), "count": 1}
        state = "disabled" if not j.get("enabled") else "error" if err else "active"
        out.append(_ro("cron", j["id"], str(j.get("name") or j["id"])[:80], "clock", state, error=err,
                       updated=j.get("updated") or j.get("created"), href=f"/crons?job={j['id']}",
                       description=j.get("human") or "", job_kind=j.get("kind")))
    return out


KINDS = {"theme": _themes, "skill": _skills, "customization": _customs, "cron": _crons}


def items() -> list[dict]:
    out: list[dict] = []
    for fn in KINDS.values():
        try:
            out += fn()
        except Exception:  # noqa: BLE001 - one kind failing never hides the others
            log.warning("atelier: %s not listed", fn.__name__, exc_info=True)
    return out


def detail(kind: str, iid: str) -> dict:
    from .atelier import AtelierError
    fn = KINDS.get(kind)
    it = next((x for x in (fn() if fn else []) if x["id"] == iid), None)
    if it is None:
        raise AtelierError(404, "not_found", f"no {kind} {iid}")
    return {"item": it, "versions": [], "history": [], "drafts": [], "files": [], "permissions": None,
            "health": {"state": it["state"], "error": it["error"], "errors": [it["error"]] if it["error"] else [],
                       "checked_at": time.time()}}
