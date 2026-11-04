"""The Atelier: what the agents create for the platform, staged as drafts, approved by the user, versioned.

API: docs/dev/API.md#atelier; design: docs/dev/INTERNALS.md `maxxing.atelier`.

- An agent writes a creation (an extension) into a **draft folder**, `<session folder>/.atelier/<id>/` (writable by
  Claude and by Codex's workspace-write sandbox, whereas `<workspace>/extensions` is not for Codex), and submits it
  with `pilot ext propose <id>`: a request file `.proposal.json` in that folder, then `register()` - in the CLI process
  when it may write `<state>`, else by the server when that session's turn ends (`ingest_session`).
- `register` freezes a copy of the files under `<state>/atelier/drafts/<did>/<id>/`, checks it statically (no code of
  a draft runs before approval: `check_dir`), records `draft.json` and posts the feed event `atelier.proposed`.
- `approve` installs the frozen files into `<workspace>/extensions/<id>/` in one step and records a version (files kept
  content-addressed under `<state>/atelier/objects/`, metadata in `<state>/atelier/items/<kind>/<id>.json`).
- `refresh` notices extension folders changed outside the Atelier (`unreviewed`) and, once, records every extension
  that existed before the Atelier as an approved v1 of unknown origin (migration).

Every write holds `locked()` (thread lock + flock on `<state>/atelier/lock`: the CLI and the server share it), always
before `extensions.publishing()`, and touches `<state>/atelier/rev` (the server turns that into the bus topic).
"""
from __future__ import annotations

import ast
import contextlib
import difflib
import fcntl
import hashlib
import json
import os
import re
import secrets as _secrets
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterator

from . import config, extensions

DRAFT_DIR = ".atelier"                       # in a session's folder: <folder>/.atelier/<id>/
REQUEST = ".proposal.json"                   # the proposal request, inside the draft folder (never part of the files)
DRAFT_ID_RE = re.compile(r"^d_[0-9a-f]{12}\Z")
KINDS = ("extension", "theme", "skill", "customization", "cron")
SKIP_DIRS = {"__pycache__", "node_modules"}
MAX_FILES = 2000                             # files of a draft or a version
MAX_BYTES = 64 * 1024 * 1024                 # bytes of a draft or a version
SUMMARY_MAX = 2000
REASON_MAX = 500
MESSAGE_MAX = 4000
DIFF_MAX = 200 * 1024                        # bytes of one file's unified diff
TEXT_MAX = 2 * 1024 * 1024                   # a file shown as text (draft file route, diffs)
DECIDED_KEEP_S = 30 * 86400                  # decided drafts listed by ?status=all
REFRESH_EVERY_S = 2.0
AGENT_RE = re.compile(r"^(claude|codex|user|unknown|plugin:[a-z0-9][a-z0-9-]{0,47})\Z")
DEFAULTS = {"auto_activate_safe": False, "keep_days": 90, "keep_versions": 10}


class AtelierError(Exception):
    """`status` + machine `code` for the API; `extra` = more fields of the error body."""

    def __init__(self, status: int, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


# ---- paths, lock, change stamp ------------------------------------------------------------------------------------
def root() -> Path:
    return config.STATE / "atelier"


def _drafts() -> Path:
    return root() / "drafts"


def _objects() -> Path:
    return root() / "objects"


def _item_path(kind: str, iid: str) -> Path:
    return root() / "items" / kind / f"{iid}.json"


_tlock = threading.RLock()
_depth = 0


@contextlib.contextmanager
def locked() -> Iterator[None]:
    """Serializes every Atelier write, across threads and processes (the CLI registers proposals too)."""
    global _depth
    with _tlock:
        fd = None
        if _depth == 0:
            root().mkdir(parents=True, exist_ok=True)
            fd = os.open(root() / "lock", os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
        _depth += 1
        try:
            yield
        finally:
            _depth -= 1
            if fd is not None:
                os.close(fd)


def touch() -> None:
    """Something changed: the server's watcher of `rev` sends the bus topic `atelier` to the browsers."""
    p = root() / "rev"
    try:
        p.write_text(str(time.time()))
    except OSError:
        pass


def rev() -> float:
    try:
        return (root() / "rev").stat().st_mtime
    except OSError:
        return 0.0


def _write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    config.write_json(path, data, mode=0o600)


# ---- settings ---------------------------------------------------------------------------------------------------------
def settings() -> dict:
    raw = config.load_config().get("atelier")
    raw = raw if isinstance(raw, dict) else {}
    out = dict(DEFAULTS)
    if isinstance(raw.get("auto_activate_safe"), bool):
        out["auto_activate_safe"] = raw["auto_activate_safe"]
    for k, lo, hi in (("keep_days", 1, 3650), ("keep_versions", 1, 100)):
        v = raw.get(k)
        if isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi:
            out[k] = v
    return out


def save_settings(**changes: Any) -> dict:
    cur = settings()
    for k, v in changes.items():
        if v is None:
            continue
        if k == "auto_activate_safe":
            if not isinstance(v, bool):
                raise AtelierError(400, "bad_settings", "auto_activate_safe must be true or false")
        elif k in ("keep_days", "keep_versions"):
            lo, hi = (1, 3650) if k == "keep_days" else (1, 100)
            if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
                raise AtelierError(400, "bad_settings", f"{k} must be a whole number from {lo} to {hi}")
        else:
            raise AtelierError(400, "bad_settings", f"unknown setting {k}")
        cur[k] = v
    with config._lock:                                   # noqa: SLF001 - read-modify-write of config.json
        config.update_config(atelier=cur)
    touch()
    return cur


# ---- files, blobs -----------------------------------------------------------------------------------------------------
def walk(d: Path) -> tuple[list[tuple[str, Path]], list[str]]:
    """(files of a creation's folder as (relative path, path), symbolic links found). Hidden entries, __pycache__ and
    node_modules are never part of a creation; links are never followed (nor copied)."""
    files: list[tuple[str, Path]] = []
    links: list[str] = []
    for top, dirs, names in os.walk(d):
        rel_top = os.path.relpath(top, d)
        keep = []
        for x in sorted(dirs):
            if x.startswith(".") or x in SKIP_DIRS:
                continue
            if os.path.islink(os.path.join(top, x)):
                links.append(x if rel_top == "." else f"{rel_top}/{x}")
                continue
            keep.append(x)
        dirs[:] = keep
        for n in sorted(names):
            if n.startswith("."):
                continue
            p = Path(top) / n
            rel = n if rel_top == "." else f"{rel_top}/{n}"
            if p.is_symlink():
                links.append(rel)
            elif p.is_file():
                files.append((rel.replace(os.sep, "/"), p))
    return files, links


def stat_sig(d: Path) -> str:
    """Cheap signature of a folder's files (path, size, mtime): changes when a file is written."""
    h = hashlib.sha256()
    files, links = walk(d) if d.is_dir() else ([], [])
    for rel, p in files[:MAX_FILES * 2]:
        try:
            st = p.stat()
        except OSError:
            continue
        h.update(f"{rel}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8", "surrogateescape"))
    for rel in links:
        h.update(f"{rel}\0link\n".encode("utf-8", "surrogateescape"))
    return h.hexdigest()


def sha_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_hash(files: dict[str, dict]) -> str:
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f"{rel}\0{files[rel]['sha256']}\n".encode("utf-8", "surrogateescape"))
    return h.hexdigest()


def manifest(d: Path) -> dict[str, dict]:
    """{relative path: {sha256, size, mode}} of a folder's files (walk rules)."""
    out: dict[str, dict] = {}
    for rel, p in walk(d)[0]:
        st = p.stat()
        out[rel] = {"sha256": sha_file(p), "size": st.st_size, "mode": 0o755 if st.st_mode & 0o111 else 0o644}
    return out


def _blob(sha: str) -> Path:
    return _objects() / sha[:2] / sha


def _store(p: Path, sha: str) -> None:
    dest = _blob(sha)
    if dest.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as out, open(p, "rb") as src:
            shutil.copyfileobj(src, out)
        os.chmod(tmp, 0o600)
        os.replace(tmp, dest)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def snapshot(d: Path) -> tuple[dict[str, dict], bool]:
    """Keep a folder's files in the object store -> (file list, restorable). Over the limits the list is recorded
    without the contents (restorable False)."""
    files = manifest(d)
    if len(files) > MAX_FILES or sum(f["size"] for f in files.values()) > MAX_BYTES:
        return files, False
    for rel, f in files.items():
        _store(d / rel, f["sha256"])
    return files, True


def _read_blob(sha: str) -> bytes | None:
    try:
        return _blob(sha).read_bytes()
    except OSError:
        return None


# ---- permissions (maxxing.permissions owns the declaration) -----------------------------------------------------------
def _host_list(v: Any) -> list[str]:
    return [str(x).strip()[:255] for x in v if isinstance(x, str) and x.strip()][:64] if isinstance(v, list) else []


def permissions_of(ext: extensions.Extension) -> dict:
    """What a creation declares, in the Atelier's shape {network, secrets, read, declared}."""
    try:
        from . import permissions as perms                   # the permissions contract, when it is installed
        if hasattr(perms, "view"):
            v = perms.view(getattr(ext, "permissions", None))
            if isinstance(v, dict):
                return {"network": list(v.get("network") or []), "secrets": list(v.get("secrets") or []),
                        "read": list(v.get("read") or []), "declared": bool(v.get("declared"))}
    except ImportError:
        pass
    raw = None
    if ext.type == "block":
        raw = (ext.block or {}).get("permissions") if isinstance(ext.block, dict) else None
        if raw is None and isinstance(ext.block, dict) and ext.block.get("network"):
            raw = {"network": ext.block.get("network")}
    else:
        m = config.read_json(ext.dir / "manifest.json", {})
        raw = m.get("permissions") if isinstance(m, dict) else None
    if not isinstance(raw, dict):
        return {"network": [], "secrets": [], "read": [], "declared": False}
    return {"network": _host_list(raw.get("network")), "secrets": _host_list(raw.get("secrets")),
            "read": _host_list(raw.get("read")), "declared": True}


def _accept_permissions(eid: str) -> None:
    try:
        from . import permissions as perms
        if hasattr(perms, "accept"):
            perms.accept(eid)
    except ImportError:
        pass


# ---- types ------------------------------------------------------------------------------------------------------------
def type_of(ext: extensions.Extension) -> str:
    if ext.type in ("block", "agent", "page"):
        return ext.type
    if ext.id.startswith("pin-") and (ext.dir / "card.json").is_file():
        return "pin"
    return "html_widget" if ext.has_html else "widget"


def href_of(ext: extensions.Extension) -> str | None:
    t = type_of(ext)
    if t == "page":
        return f"/x/{ext.id}"
    if t in ("widget", "html_widget", "pin"):
        return f"/?widget={ext.id}"
    if t == "block":
        return "/settings/blocks"
    return None


# ---- static check (a draft's code never runs) -------------------------------------------------------------------------
def _defines(tree: ast.Module, name: str) -> bool:
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return True
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return True
        if isinstance(node, (ast.ImportFrom, ast.Import)) and any((a.asname or a.name) == name for a in node.names):
            return True
    return False


def _static_page(run: Any, ext: extensions.Extension, has_handle: bool) -> None:
    from . import extcheck as xc
    run.file("page.js")
    seen: set[str] = set()
    todo = [("page.js", "")]
    calls_api = node_missing = False
    while todo and len(seen) < xc.MAX_MODULES:
        rel, by = todo.pop(0)
        if rel in seen:
            continue
        seen.add(rel)
        p = extensions.module_file(ext, rel)
        if p is None:
            run.add("modules", xc.ERROR, f"{by} imports {rel}: not a module of the folder the app serves (.js .mjs "
                                         ".css .json, no hidden file, no link out of the folder)" if by else
                                         "page.js is missing or cannot be served")
            continue
        run.file(rel)
        if p.suffix not in (".js", ".mjs"):
            continue
        try:
            src = p.read_text("utf-8")
        except (OSError, UnicodeDecodeError) as e:
            run.add("modules", xc.ERROR, f"{rel} cannot be read ({e})")
            continue
        err = xc._node_check(src, rel, module=True)                          # noqa: SLF001
        if err is None:
            node_missing = True
        elif err:
            run.add("syntax", xc.ERROR, err)
        specs, code = xc._scan_js(src)                                       # noqa: SLF001
        calls_api = calls_api or bool(xc._CTX_API.search(code))              # noqa: SLF001
        if not by and not xc._MOUNT.search(code):                            # noqa: SLF001
            run.add("mount", xc.ERROR, "page.js does not export mount(el, ctx) (export function mount(el, ctx) {...})")
        if xc._EVAL.search(code):                                            # noqa: SLF001
            run.add("csp", xc.WARN, f"{rel} uses eval / new Function: the app's script policy refuses them (it throws)")
        for spec in specs:
            if re.match(r"^[a-z][a-z0-9+.-]*:|^//", spec, re.I):
                run.add("modules", xc.ERROR, f"{rel} imports {spec}: the app only runs scripts it serves itself - copy "
                                             "the module into the extension folder and import it with ./")
                continue
            if not spec.startswith(("./", "../")):
                run.add("modules", xc.ERROR, f"{rel} imports \"{spec}\": import a file of the folder with ./name.js")
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(rel), spec.split("?")[0].split("#")[0]))
            if target.startswith(".."):
                run.add("modules", xc.ERROR, f"{rel} imports {spec}: outside the extension folder")
                continue
            todo.append((target.replace(os.sep, "/"), rel))
    if node_missing:
        run.add("syntax", xc.WARN, "Node.js is not installed: the JavaScript syntax was not checked")
    elif not any(s["step"] == "syntax" and s["status"] == xc.ERROR for s in run.steps):
        run.add("syntax", xc.OK, f"{len(seen)} module(s) parse" if len(seen) > 1 else "page.js parses")
    if calls_api and not has_handle:
        run.add("api", xc.ERROR, "the page calls ctx.api() but api.py has no handle(ctx, method, path, query, body)")


def check_dir(d: Path, eid: str | None = None) -> dict:
    """The static check of a creation's folder: as the server would load it, without importing or running anything.
    -> {status: ok|warn|error, steps, files, type, name, icon, permissions}."""
    from . import extcheck as xc
    eid = eid or d.name
    tmp = None
    try:
        if d.name != eid:                           # the server reads the id from the folder name
            tmp = tempfile.mkdtemp(prefix="mx-atelier-")
            dst = Path(tmp) / eid
            dst.mkdir()
            for rel, p in walk(d)[0]:
                (dst / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, dst / rel)
            d = dst
        return _check(d, eid, xc)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def _check(d: Path, eid: str, xc: Any) -> dict:
    ext = extensions._load_one(d, load_code=False)                            # noqa: SLF001
    run = xc._Run(ext, xc._kind(ext))                                         # noqa: SLF001
    run.file("block.json" if ext.type == "block" else "manifest.json")
    files, links = walk(d)
    size = 0
    for _rel, p in files:
        with contextlib.suppress(OSError):
            size += p.stat().st_size
    if not extensions.ID_RE.match(eid):
        run.add("load", xc.ERROR, "the id must be a lowercase slug (a-z, 0-9, -), 48 characters at most")
    elif ext.error:
        run.add("load", xc.ERROR, ext.error)
    else:
        run.add("load", xc.OK, {"block": "block.json is valid", "agent": "manifest.json is valid"}.get(
            ext.type, "manifest.json is valid"))
    if links:
        run.add("files", xc.ERROR, "symbolic links cannot be proposed (copy the file into the folder): "
                                   + ", ".join(links[:5]))
    if len(files) > MAX_FILES or size > MAX_BYTES:
        run.add("files", xc.ERROR, f"{len(files)} file(s), {size // 1024} kB: at most {MAX_FILES} files and "
                                   f"{MAX_BYTES // (1024 * 1024)} MB")
    has_handle = False
    if (d / "api.py").is_file() and ext.type not in ("block", "agent"):
        run.file("api.py")
        try:
            tree = ast.parse((d / "api.py").read_bytes(), "api.py")
            compile(tree, "api.py", "exec")
            has_handle = _defines(tree, "handle")
            run.add("python", xc.OK, "api.py compiles (not run: a proposal runs only once approved)")
            if ext.type == "widget" and not ext.has_html and not _defines(tree, "card"):
                run.add("python", xc.ERROR, "api.py must define card(ctx)")
        except SyntaxError as e:
            run.add("python", xc.ERROR, f"api.py:{e.lineno}: {e.msg}" + (f"\n  {e.text.strip()}" if e.text else ""))
        except (OSError, ValueError) as e:
            run.add("python", xc.ERROR, f"api.py cannot be read ({e})")
    if not ext.error and not links:
        try:
            if ext.type == "widget" and ext.has_html:
                run.file("widget.html")
                xc._check_document(run, "widget.html", (d / "widget.html").read_bytes(), api_ok=has_handle,  # noqa: SLF001
                                   bridge="widget")
            elif ext.type == "page":
                _static_page(run, ext, has_handle)
            elif ext.type == "block":
                entry = str((ext.block or {}).get("entry") or "block.html")
                run.file(entry)
                xc._check_document(run, entry, (d / entry).read_bytes(), api_ok=False, bridge="block")  # noqa: SLF001
        except Exception as e:  # noqa: BLE001 - a check that fails is a result
            run.add("check", xc.ERROR, f"the check itself failed: {type(e).__name__}: {e}")
    res = run.result()
    return {"status": res["status"], "steps": res["steps"], "files": res["files"], "type": type_of(ext),
            "name": ext.label(), "icon": ext.icon, "permissions": permissions_of(ext)}


# ---- origin -----------------------------------------------------------------------------------------------------------
def _session(sid: str | None) -> dict | None:
    if not sid:
        return None
    try:
        from .sessions import store
        return store.read(sid) if store.is_valid_id(sid) else None
    except Exception:  # noqa: BLE001 - a damaged meta is an unknown origin
        return None


def _agent_of(meta: dict | None, claimed: str | None) -> str:
    if claimed and AGENT_RE.match(claimed):
        return claimed
    prov = str((meta or {}).get("provider") or "")
    if prov in ("claude", "codex") or prov.startswith("plugin:"):
        return prov
    return "unknown" if meta else "user"


def origin(sid: str | None, agent: str | None, at: float | None, summary: str | None) -> dict:
    meta = _session(sid)
    return {"agent": _agent_of(meta, agent) if (sid or agent) else "user", "session": meta["id"] if meta else None,
            "session_title": (meta or {}).get("title") or None, "session_path": (meta or {}).get("path") if meta else None,
            "at": at, "summary": (summary or None)}


UNKNOWN = {"agent": "unknown", "session": None, "session_title": None, "session_path": None, "at": None, "summary": None}


def _live_origin(o: dict | None) -> dict | None:
    """An origin with the session's title as it is now (renamed, deleted)."""
    if not o:
        return None
    o = dict(o)
    meta = _session(o.get("session"))
    if meta:
        o["session_title"] = meta.get("title") or o.get("session_title")
        o["session_path"] = meta.get("path") or ""
    elif o.get("session"):
        o["session_path"] = None
    return o


# ---- draft folders (the agent's side) ---------------------------------------------------------------------------------
def session_folder(sid: str | None) -> Path:
    """The folder a session works in (the workspace root without a session)."""
    from . import workspace
    meta = _session(sid)
    if meta:
        with contextlib.suppress(ValueError):
            return workspace.topic_dir(meta.get("path") or "")
    return workspace.root()


def draft_folder(eid: str, sid: str | None = None) -> Path:
    return session_folder(sid) / DRAFT_DIR / eid


def make_draft(eid: str, sid: str | None = None, from_draft: str | None = None, reset: bool = False) -> dict:
    """Create (or find) the draft folder of `eid` -> {path, created, from: "active"|"draft"|"empty"|"existing"}."""
    if not extensions.ID_RE.match(eid):
        raise AtelierError(400, "bad_id", "the id must be a lowercase slug (a-z, 0-9, -), 48 characters at most")
    dest = draft_folder(eid, sid)
    if dest.exists() and not reset:
        return {"path": str(dest), "created": False, "from": "existing"}
    if from_draft:
        src = _draft_files(from_draft)
        if src is None or not src.is_dir():
            raise AtelierError(404, "not_found", f"no proposal {from_draft}")
    else:
        live = extensions.root() / eid
        src = live if live.is_dir() else None
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    if src is not None:
        for rel, p in walk(src)[0]:
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dest / rel)
    return {"path": str(dest), "created": True, "from": "draft" if from_draft else "active" if src else "empty"}


def new_draft_id() -> str:
    return "d_" + _secrets.token_hex(6)


def write_request(folder: Path, eid: str, summary: str | None, sid: str | None, agent: str | None) -> dict:
    req = {"draft": new_draft_id(), "id": eid, "summary": (summary or "").strip()[:SUMMARY_MAX] or None,
           "session": sid or None, "agent": agent or None, "at": time.time()}
    (folder / REQUEST).write_text(json.dumps(req, indent=2) + "\n", "utf-8")
    return req


# ---- items (versions metadata) ----------------------------------------------------------------------------------------
def load_item(kind: str, iid: str) -> dict | None:
    d = config.read_json(_item_path(kind, iid), None)
    return d if isinstance(d, dict) and isinstance(d.get("versions"), list) else None


def _save_item(item: dict) -> None:
    _write(_item_path(item["kind"], item["id"]), item)


def _new_item(kind: str, iid: str) -> dict:
    return {"kind": kind, "id": iid, "active": None, "next": 1, "versions": [], "history": [],
            "live": {"sig": None, "hash": None}, "unreviewed_since": None}


def _version(item: dict, n: int) -> dict | None:
    return next((v for v in item["versions"] if v.get("n") == n), None)


def active_version(item: dict | None) -> dict | None:
    return _version(item, item["active"]) if item and item.get("active") is not None else None


def origin_session(eid: str) -> str | None:
    """The session that proposed the active version of extension `eid` (else the newest version that has one)."""
    item = load_item("extension", eid)
    if not item:
        return None
    act = active_version(item)
    for v in ([act] if act else []) + sorted(item["versions"], key=lambda v: v["n"], reverse=True):
        sid = (v.get("origin") or {}).get("session")
        if sid:
            return sid
    return None


def _event(item: dict, action: str, *, version: int | None = None, draft: str | None = None, by: str = "user",
           note: str | None = None) -> None:
    item["history"] = ([{"at": time.time(), "action": action, "version": version, "draft": draft, "by": by,
                         "note": note}] + item.get("history", []))[:200]


def _errors_since(eid: str, since: float) -> list[dict]:
    try:
        from . import exterrors
        rows = exterrors._load().get(eid) or []                                 # noqa: SLF001
    except Exception:  # noqa: BLE001
        return []
    return [r for r in rows if isinstance(r, dict) and float(r.get("at") or 0) >= since]


def _close_active(item: dict) -> None:
    """The active version stops being active: its health says whether it ran without error meanwhile."""
    v = active_version(item)
    if not v:
        return
    errs = _errors_since(item["id"], float(v.get("activated_at") or v.get("at") or 0))
    if errs:
        e = errs[0]
        v["health"] = "error"
        v["error"] = {"message": e.get("message"), "where": e.get("where"), "at": e.get("at"),
                      "count": int(e.get("count") or 1)}
    else:
        v["health"] = "ok"


def _add_version(item: dict, files: dict, restorable: bool, origin_: dict, approval: dict, base: int | None,
                 note: str | None = None, activate: bool = True) -> dict:
    n = max(int(item.get("next") or 1), max((v["n"] for v in item["versions"]), default=0) + 1)
    item["next"] = n + 1
    v = {"n": n, "at": time.time(), "files": files, "hash": tree_hash(files), "base": base, "origin": origin_,
         "approval": approval, "restorable": restorable, "health": "unknown", "error": None, "note": note,
         "activated_at": None, "size": sum(f["size"] for f in files.values())}
    item["versions"].append(v)
    if activate:
        _close_active(item)
        item["active"] = n
        v["activated_at"] = time.time()
    return v


# ---- install (one step) -----------------------------------------------------------------------------------------------
def _install(eid: str, write: Any) -> None:
    """Replace `<workspace>/extensions/<eid>/` by the files `write(folder)` puts in a new folder, in one step: both
    renames inside `extensions.publishing()` (a scan never sees the gap; hidden folders are never scanned)."""
    base = extensions.root()
    base.mkdir(parents=True, exist_ok=True)
    new = base / f".atelier-new-{eid}-{time.time_ns()}"
    new.mkdir()
    try:
        write(new)
    except BaseException:
        shutil.rmtree(new, ignore_errors=True)
        raise
    live = base / eid
    old = None
    with extensions.publishing():
        try:
            if live.exists() or live.is_symlink():
                old = base / f".atelier-old-{eid}-{time.time_ns()}"
                os.rename(live, old)
            os.rename(new, live)
        except BaseException:
            if old is not None and not live.exists():
                os.rename(old, live)
                old = None
            shutil.rmtree(new, ignore_errors=True)
            raise
    if old is not None:
        if old.is_symlink():
            old.unlink()
        else:
            shutil.rmtree(old, ignore_errors=True)


def _copy_tree(src: Path) -> Any:
    def write(dest: Path) -> None:
        for rel, p in walk(src)[0]:
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dest / rel)                 # fresh mtimes: the extension's signature changes
            if os.stat(p).st_mode & 0o111:
                os.chmod(dest / rel, 0o755)
    return write


def _keep_direct(item: dict, live: Path) -> None:
    """Files changed outside the Atelier are kept as a version before anything replaces them."""
    if not live.is_dir():
        return
    files, ok = snapshot(live)
    act = active_version(item)
    if act and tree_hash(files) == act["hash"]:
        return
    if not files:
        return
    _add_version(item, files, ok, dict(UNKNOWN, at=time.time()), {"by": None, "at": None},
                 item.get("active"), note="changed outside the Atelier", activate=False)
    _event(item, "direct", version=item["versions"][-1]["n"], by="system", note="kept before it was replaced")


def _set_live(item: dict, live: Path) -> None:
    item["live"] = {"sig": stat_sig(live), "hash": active_version(item)["hash"] if active_version(item) else None}
    item["unreviewed_since"] = None


# ---- refresh: migration and changes outside the Atelier ---------------------------------------------------------------
_last_refresh = {"at": 0.0, "root": ""}


def _state() -> dict:
    d = config.read_json(root() / "state.json", {})
    return d if isinstance(d, dict) else {}


def refresh(force: bool = False) -> None:
    """Record extension folders the Atelier does not know (approved v1 at the migration, unreviewed afterwards) and
    notice files changed outside it. At most every REFRESH_EVERY_S unless forced. Never raises."""
    now = time.time()
    key = str(extensions.root())
    if not force and _last_refresh["root"] == key and now - _last_refresh["at"] < REFRESH_EVERY_S:
        return
    _last_refresh.update(at=now, root=key)
    try:
        _refresh()
    except OSError:
        import logging
        logging.getLogger("maxxing.atelier").warning("atelier refresh failed", exc_info=True)


def _ext_dirs() -> list[Path]:
    base = extensions.root()
    if not base.is_dir():
        return []
    return [d for d in sorted(base.iterdir()) if d.is_dir() and not d.name.startswith((".", "_"))
            and extensions.ID_RE.match(d.name)]


def _refresh() -> None:
    with locked():
        st = _state()
        migrated = st.get("migrated_at")
        changed = False
        for d in _ext_dirs():
            item = load_item("extension", d.name)
            sig = stat_sig(d)
            if item is None:
                files, ok = snapshot(d)
                item = _new_item("extension", d.name)
                if migrated:
                    _add_version(item, files, ok, dict(UNKNOWN, at=time.time()), {"by": None, "at": None}, None,
                                 note="created outside the Atelier")
                    _event(item, "direct", version=item["active"], by="system")
                    item["live"] = {"sig": sig, "hash": active_version(item)["hash"]}
                    item["unreviewed_since"] = time.time()
                else:
                    _add_version(item, files, ok, dict(UNKNOWN), {"by": "migration", "at": time.time()}, None,
                                 note="existed before the Atelier")
                    _event(item, "migrate", version=item["active"], by="system")
                    item["live"] = {"sig": sig, "hash": active_version(item)["hash"]}
                _save_item(item)
                changed = True
                continue
            if (item.get("live") or {}).get("sig") == sig:
                continue
            h = tree_hash(manifest(d))
            act = active_version(item)
            if act and h == act["hash"]:
                item["live"] = {"sig": sig, "hash": h}
                if not act.get("restorable"):          # metadata restored from a backup: the files are back
                    act["files"], act["restorable"] = snapshot(d)
                    act.pop("file_count", None)
                if item.get("unreviewed_since"):
                    item["unreviewed_since"] = None
                    changed = True
            else:
                item["live"] = {"sig": sig, "hash": h}
                if not item.get("unreviewed_since"):
                    item["unreviewed_since"] = time.time()
                    changed = True
            _save_item(item)
        if not migrated:
            _write(root() / "state.json", {**st, "migrated_at": time.time()})
            changed = True
        if changed:
            touch()


def record_user_install(eid: str, note: str) -> None:
    """An extension the user installed from the app (a dashboard pin, a pack): its files become a version approved by
    the user. Never raises."""
    try:
        d = extensions.root() / eid
        if not d.is_dir():
            return
        with locked():
            item = load_item("extension", eid) or _new_item("extension", eid)
            files, ok = snapshot(d)
            act = active_version(item)
            if act and act["hash"] == tree_hash(files):
                return
            _add_version(item, files, ok, {**UNKNOWN, "agent": "user", "at": time.time()},
                         {"by": "user", "at": time.time()}, item.get("active"), note=note)
            _event(item, "approve", version=item["active"], by="user", note=note)
            _set_live(item, d)
            _save_item(item)
            touch()
    except Exception:  # noqa: BLE001
        import logging
        logging.getLogger("maxxing.atelier").warning("could not record %s", eid, exc_info=True)


# ---- drafts -----------------------------------------------------------------------------------------------------------
def _draft_dir(did: str) -> Path:
    if not DRAFT_ID_RE.match(did or ""):
        raise AtelierError(404, "not_found", f"no proposal {did}")
    return _drafts() / did


def _draft_files(did: str) -> Path | None:
    rec = load_draft(did)
    return (_draft_dir(did) / rec["target"]) if rec else None


def load_draft(did: str) -> dict | None:
    try:
        d = config.read_json(_draft_dir(did) / "draft.json", None)
    except AtelierError:
        return None
    return d if isinstance(d, dict) and d.get("id") == did else None


def _save_draft(rec: dict) -> None:
    _write(_drafts() / rec["id"] / "draft.json", rec)


def all_drafts() -> list[dict]:
    if not _drafts().is_dir():
        return []
    out = []
    for p in _drafts().iterdir():
        if DRAFT_ID_RE.match(p.name):
            rec = load_draft(p.name)
            if rec:
                out.append(rec)
    return sorted(out, key=lambda r: r.get("created") or 0, reverse=True)


def pending_for(eid: str) -> list[dict]:
    return [d for d in all_drafts() if d.get("target") == eid and d.get("status") == "pending"]


def _feed_proposed(rec: dict) -> None:
    from . import feed
    o = rec.get("origin") or {}
    perms = rec.get("permissions") or {}
    who = {"claude": "Claude", "codex": "Codex"}.get(o.get("agent") or "", "An agent")
    feed.system(f"{rec['name']} is waiting for your approval",
                f"{who} proposes {'a new' if rec['change'] == 'new' else 'a change to the'} {rec['type'].replace('_', ' ')}"
                + (f": {rec['summary'][:300]}" if rec.get("summary") else "."),
                level="warning", source="system", url=f"/atelier/drafts/{rec['id']}", group=f"atelier:{rec['id']}",
                kind="atelier.proposed",
                params={"draft_id": rec["id"], "kind": "extension", "id": rec["target"], "name": rec["name"],
                        "type": rec["type"], "change": rec["change"], "agent": o.get("agent") or "unknown",
                        "session_id": o.get("session"), "network": len(perms.get("network") or []),
                        "secrets": len(perms.get("secrets") or [])},
                actions=[feed.link("review", "Review", f"/atelier/drafts/{rec['id']}")])


def _feed_resolve(did: str) -> None:
    from . import feed
    feed.system_resolve("system", f"atelier:{did}")


def qualifies_auto(rec: dict) -> bool:
    perms = rec.get("permissions") or {}
    return (rec.get("check") or {}).get("status") != "error" and not perms.get("network") and not perms.get("secrets")


def register(folder: Path, request: dict | None = None, *, scanned_for: dict | None = None) -> dict:
    """Register the proposal of a draft folder (its `.proposal.json`, or `request`) -> the Draft record.
    `scanned_for`: the session whose folder the server scanned (server-side registration: the origin is that session
    unless the request names another session of the same folder). Idempotent for one draft id."""
    folder = Path(folder)
    req = request if request is not None else config.read_json(folder / REQUEST, None)
    if not isinstance(req, dict):
        raise AtelierError(400, "bad_request", f"no proposal request in {folder}")
    did, eid = str(req.get("draft") or ""), str(req.get("id") or folder.name)
    if not DRAFT_ID_RE.match(did):
        raise AtelierError(400, "bad_request", "the request has no valid draft id")
    if eid != folder.name or not extensions.ID_RE.match(eid):
        raise AtelierError(400, "bad_id", f"the draft folder must be named after the id ({eid})")
    if extensions.RESERVED_IDS & {eid}:
        raise AtelierError(400, "bad_id", f"{eid!r} is the id of a built-in widget")
    if config.load_config().get("restore_hold"):
        raise AtelierError(409, "restore_hold", "This restored instance is in review mode: enable its services first.")
    sid = req.get("session") if isinstance(req.get("session"), str) else None
    if scanned_for is not None:
        meta = _session(sid)
        if not meta or (meta.get("path") or "") != (scanned_for.get("path") or ""):
            sid = scanned_for.get("id")
    summary = req.get("summary") if isinstance(req.get("summary"), str) else None
    with locked():
        existing = load_draft(did)
        if existing:
            with contextlib.suppress(OSError):
                (folder / REQUEST).unlink()
            return existing
        dest = _drafts() / did
        tmp = _drafts() / f".tmp-{did}-{time.time_ns()}"
        (tmp / eid).mkdir(parents=True)
        try:
            files, links = walk(folder)
            for rel, p in files:
                (tmp / eid / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, tmp / eid / rel)
            os.rename(tmp, dest)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        frozen = dest / eid
        chk = check_dir(frozen, eid)
        if links:
            chk["steps"].append({"step": "files", "status": "error",
                                 "detail": "symbolic links were left out: " + ", ".join(links[:5])})
            chk["status"] = "error"
        item = load_item("extension", eid)
        live = extensions.root() / eid
        rec = {"id": did, "kind": "extension", "target": eid, "name": chk["name"], "type": chk["type"],
               "icon": chk["icon"], "status": "pending",
               "change": "update" if (live.is_dir() or active_version(item)) else "new",
               "base": item.get("active") if item else None, "created": time.time(),
               "origin": origin(sid, req.get("agent") if isinstance(req.get("agent"), str) else None,
                                float(req.get("at") or time.time()), summary),
               "summary": (summary or "").strip()[:SUMMARY_MAX] or None,
               "permissions": chk["permissions"], "check": {"status": chk["status"], "steps": chk["steps"]},
               "file_list": manifest(frozen), "source_dir": str(folder), "decided": None, "superseded_by": None,
               "change_requests": []}
        rec["auto"] = qualifies_auto(rec)
        for old in pending_for(eid):
            old.update(status="superseded", superseded_by=did, decided={"at": time.time(), "by": "agent"})
            _save_draft(old)
            _feed_resolve(old["id"])
        _save_draft(rec)
        with contextlib.suppress(OSError):
            (folder / REQUEST).unlink()
        if item is not None:
            _event(item, "propose", draft=did, by="agent", note=rec["summary"])
            _save_item(item)
        touch()
        if rec["auto"] and settings()["auto_activate_safe"]:
            res = approve(did, by="auto")
            return res["draft"]
        _feed_proposed(rec)
    return rec


def ingest_session(session: dict) -> list[str]:
    """Server side: register the proposals left in a session's folder (a Codex turn cannot write <state>). Called
    when a turn of that session ends. Never raises -> the draft ids registered."""
    import logging
    out: list[str] = []
    try:
        from . import workspace
        base = workspace.topic_dir(session.get("path") or "") / DRAFT_DIR
    except ValueError:
        return out
    if not base.is_dir():
        return out
    for req in sorted(base.glob(f"*/{REQUEST}")):
        try:
            if req.is_symlink() or not req.is_file():
                continue
            rec = register(req.parent, scanned_for=session)
            out.append(rec["id"])
        except AtelierError as e:
            logging.getLogger("maxxing.atelier").warning("proposal in %s not registered: %s", req.parent, e.message)
        except Exception:  # noqa: BLE001
            logging.getLogger("maxxing.atelier").warning("proposal in %s not registered", req.parent, exc_info=True)
    return out


# ---- diffs ------------------------------------------------------------------------------------------------------------
def _text(b: bytes | None) -> str | None:
    if b is None or b"\0" in b[:8192] or len(b) > TEXT_MAX:
        return None
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _old_bytes(item: dict | None, rel: str, sha: str) -> bytes | None:
    data = _read_blob(sha)
    if data is None and item is not None:                  # not kept: the live file, when it is still that one
        p = extensions.root() / item["id"] / rel
        with contextlib.suppress(OSError):
            if p.is_file() and not p.is_symlink() and sha_file(p) == sha:
                data = p.read_bytes()
    return data


def diff_files(new: dict[str, dict], new_bytes: Any, old: dict[str, dict], old_bytes: Any) -> list[dict]:
    """DraftFile list: `new` / `old` file lists, `*_bytes(rel, sha) -> bytes | None`."""
    out = []
    for rel in sorted(set(new) | set(old)):
        n, o = new.get(rel), old.get(rel)
        status = "added" if o is None else "removed" if n is None else "same" if n["sha256"] == o["sha256"] else "changed"
        row = {"path": rel, "status": status, "size": n["size"] if n else None, "old_size": o["size"] if o else None,
               "binary": False, "diff": None, "truncated": False}
        if status != "same":
            a = _text(old_bytes(rel, o["sha256"])) if o else ""
            b = _text(new_bytes(rel, n["sha256"])) if n else ""
            if a is None or b is None:
                row["binary"] = True
            else:
                text = "".join(difflib.unified_diff(a.splitlines(True), b.splitlines(True),
                                                    "/dev/null" if o is None else f"a/{rel}",
                                                    "/dev/null" if n is None else f"b/{rel}", n=3))
                if len(text.encode()) > DIFF_MAX:
                    text = text.encode()[:DIFF_MAX].decode("utf-8", "ignore")
                    row["truncated"] = True
                row["diff"] = text
        out.append(row)
    return out


def _counts(rows: list[dict]) -> dict:
    return {"count": sum(1 for r in rows if r["status"] != "removed"),
            "size": sum(r["size"] or 0 for r in rows if r["status"] != "removed"),
            "added": sum(1 for r in rows if r["status"] == "added"),
            "changed": sum(1 for r in rows if r["status"] == "changed"),
            "removed": sum(1 for r in rows if r["status"] == "removed")}


def _draft_rows(rec: dict) -> tuple[list[dict], dict | None]:
    item = load_item("extension", rec["target"])
    act = active_version(item)
    frozen = _draft_dir(rec["id"]) / rec["target"]

    def new_bytes(rel: str, _sha: str) -> bytes | None:
        with contextlib.suppress(OSError):
            return (frozen / rel).read_bytes()
        return None
    return diff_files(rec.get("file_list") or {}, new_bytes, (act or {}).get("files") or {},
                      lambda rel, sha: _old_bytes(item, rel, sha)), item


def public_draft(rec: dict, rows: list[dict] | None = None) -> dict:
    if rows is None:
        rows = _draft_rows(rec)[0] if rec.get("status") == "pending" else []
    out = {k: rec.get(k) for k in ("id", "kind", "target", "name", "type", "icon", "status", "change", "base",
                                   "created", "summary", "permissions", "check", "decided", "superseded_by",
                                   "change_requests", "auto")}
    out["origin"] = _live_origin(rec.get("origin"))
    files = rec.get("file_list") or {}
    out["files"] = _counts(rows) if rows else {"count": len(files), "size": sum(f["size"] for f in files.values()),
                                               "added": 0, "changed": 0, "removed": 0}
    return out


def list_drafts(status: str = "pending") -> list[dict]:
    now = time.time()
    out = []
    for rec in all_drafts():
        if status == "pending" and rec.get("status") != "pending":
            continue
        if rec.get("status") != "pending" and now - float((rec.get("decided") or {}).get("at") or 0) > DECIDED_KEEP_S:
            continue
        out.append(public_draft(rec))
    return out


def draft_detail(did: str) -> dict:
    rec = load_draft(did)
    if rec is None:
        raise AtelierError(404, "not_found", f"no proposal {did}")
    rows, item = _draft_rows(rec)
    active = item.get("active") if item else None
    return {"draft": public_draft(rec, rows), "files": rows, "active_version": active,
            "stale": rec.get("status") == "pending" and active != rec.get("base"),
            "preview": preview_kind(rec)}


def preview_kind(rec: dict) -> str:
    t = rec.get("type")
    return "card" if t in ("widget", "pin") else "html" if t == "html_widget" else "none"


def draft_file(did: str, rel: str) -> dict:
    rec = load_draft(did)
    if rec is None or rel not in (rec.get("file_list") or {}):
        raise AtelierError(404, "not_found", f"no file {rel} in proposal {did}")
    p = _draft_dir(did) / rec["target"] / rel
    try:
        data = p.read_bytes()
    except OSError:
        raise AtelierError(404, "not_found", f"the files of proposal {did} are no longer kept") from None
    text = _text(data)
    return {"path": rel, "size": len(data), "binary": text is None and b"\0" in data[:8192], "content": text}


def _pending(did: str) -> dict:
    rec = load_draft(did)
    if rec is None:
        raise AtelierError(404, "not_found", f"no proposal {did}")
    if rec.get("status") != "pending":
        raise AtelierError(409, "not_pending", f"this proposal is already {rec.get('status')}")
    return rec


# ---- decisions --------------------------------------------------------------------------------------------------------
def approve(did: str, base: Any = ..., by: str = "user") -> dict:
    """Install a pending draft as the extension's new active version -> {draft, item, version}. `base` = the active
    version the user reviewed (`...`: not checked)."""
    with locked():
        rec = _pending(did)
        eid = rec["target"]
        with contextlib.suppress(OSError):
            _refresh()                                   # migration first: what runs now is its own version
        frozen = _draft_dir(did) / eid
        chk = check_dir(frozen, eid)
        if chk["status"] == "error":
            rec["check"] = {"status": chk["status"], "steps": chk["steps"]}
            _save_draft(rec)
            raise AtelierError(422, "check_failed", "the proposal does not pass its check", check=rec["check"])
        item = load_item("extension", eid) or _new_item("extension", eid)
        if base is not ... and base != item.get("active"):
            raise AtelierError(409, "stale", "another version became active since you reviewed this proposal",
                               active=item.get("active"), base=base)
        live = extensions.root() / eid
        _keep_direct(item, live)
        files, ok = snapshot(frozen)
        _install(eid, _copy_tree(frozen))
        now = time.time()
        v = _add_version(item, files, ok, rec.get("origin") or dict(UNKNOWN), {"by": by, "at": now},
                         rec.get("base"))
        _event(item, "auto" if by == "auto" else "approve", version=v["n"], draft=did, by="system" if by == "auto"
               else "user")
        _set_live(item, live)
        _save_item(item)
        rec.update(status="approved", decided={"at": now, "by": by, "version": v["n"]})
        _save_draft(rec)
        _accept_permissions(eid)
        _feed_resolve(did)
        prune()
        if by == "auto":
            from . import feed
            o = rec.get("origin") or {}
            feed.system(f"{rec['name']} was added", "It declares no network access and no secret: activated without "
                        "review (Atelier settings).", level="success", source="system",
                        url=f"/atelier/extension/{eid}", kind="atelier.activated",
                        params={"draft_id": did, "kind": "extension", "id": eid, "name": rec["name"],
                                "type": rec["type"], "version": v["n"], "agent": o.get("agent") or "unknown",
                                "session_id": o.get("session")},
                        actions=[feed.link("open", "Open", f"/atelier/extension/{eid}")])
        touch()
        return {"draft": rec, "item": item, "version": v["n"]}


def reject(did: str, reason: str | None = None) -> dict:
    from . import workspace
    reason = (reason or "").strip()[:REASON_MAX] or None
    with locked():
        rec = _pending(did)
        rec.update(status="rejected", decided={"at": time.time(), "by": "user", "reason": reason})
        _save_draft(rec)
        trash_id = None
        frozen = _draft_dir(did) / rec["target"]
        if frozen.is_dir():
            dest = workspace.move_to_trash(frozen, label=f"{rec['target']}-draft-{did}")
            side = dest.with_name(dest.name + ".json")
            meta = config.read_json(side, {}) or {}
            meta["original"] = rec.get("source_dir") or str(frozen)
            config.write_json(side, meta)
            trash_id = dest.name
        item = load_item("extension", rec["target"])
        if item is not None:
            _event(item, "reject", draft=did, note=reason)
            _save_item(item)
        _feed_resolve(did)
        touch()
        return {"draft": public_draft(rec, []), "trash_id": trash_id}


def accept(kind: str, iid: str) -> dict:
    """Files changed outside the Atelier become a version approved by the user."""
    if kind not in KINDS:
        raise AtelierError(404, "not_found", f"no kind {kind}")
    if kind != "extension":
        raise AtelierError(422, "not_versioned", f"{kind} creations are not versioned")
    refresh(force=True)
    with locked():
        item = load_item(kind, iid)
        live = extensions.root() / iid
        if item is None or not live.is_dir():
            raise AtelierError(404, "not_found", f"no extension {iid}")
        if not item.get("unreviewed_since"):
            raise AtelierError(409, "nothing_to_accept", "its files are those of the active version")
        files, ok = snapshot(live)
        now = time.time()
        v = _add_version(item, files, ok, dict(UNKNOWN, at=item.get("unreviewed_since")), {"by": "user", "at": now},
                         item.get("active"), note="changed outside the Atelier, accepted")
        _event(item, "accept", version=v["n"])
        _set_live(item, live)
        _save_item(item)
        _accept_permissions(iid)
        touch()
        return {"item": item, "version": v["n"]}


def add_change_request(did: str, message: str, sid: str | None) -> dict:
    with locked():
        rec = _pending(did)
        rec.setdefault("change_requests", []).append({"at": time.time(), "message": message[:MESSAGE_MAX],
                                                      "session": sid})
        _save_draft(rec)
        item = load_item("extension", rec["target"])
        if item is not None:
            _event(item, "request_change", draft=did, note=message[:200])
            _save_item(item)
        touch()
        return rec


def change_prompt(rec: dict, message: str) -> str:
    eid, did = rec["target"], rec["id"]
    folder = rec.get("source_dir") or f"{DRAFT_DIR}/{eid}"
    return (f"[Atelier] The user asked for a change to \"{rec['name']}\" (proposal {did}, extension {eid}):\n\n"
            f"{message.strip()}\n\n"
            f"Make the change in the draft folder {folder} (if it is gone, `pilot ext draft {eid} --from-draft {did}` "
            f"puts this proposal's files back), check it with `pilot ext check {eid} --dir {folder}`, then run "
            f"`pilot ext propose {eid} --summary \"...\"` and show the new proposal block it prints. Nothing is "
            "active until the user approves it.")


# ---- listing ----------------------------------------------------------------------------------------------------------
def _error_info(ext: extensions.Extension | None, errs: dict) -> dict | None:
    if ext is None:
        return None
    if ext.error:
        return {"message": ext.error, "where": "load", "at": None, "count": 1}
    rows = errs.get(ext.id) or []
    if rows:
        e = rows[0]
        return {"message": e.get("message"), "where": e.get("where"), "at": e.get("at"),
                "count": int(e.get("count") or 1)}
    return None


def _state_of(ext: extensions.Extension | None, err: dict | None) -> str:
    if ext is None:
        return "pending"
    if not ext.enabled:
        return "disabled"
    if ext.error and "no longer supported" in ext.error:
        return "review"
    return "error" if err else "active"


def _pending_info(drafts: list[dict]) -> dict | None:
    if not drafts:
        return None
    d = drafts[0]
    return {"draft": d["id"], "at": d.get("created"), "change": d.get("change"), "origin": _live_origin(d.get("origin"))}


def _actions(item: dict) -> list[str]:
    a = []
    if item["pending"]:
        a += ["approve", "reject", "request_change"]
    if item["versions"] > 1:
        a.append("rollback")
    if item["unreviewed"]:
        a.append("accept")
    if item["state"] in ("active", "error", "review"):
        a.append("disable")
    elif item["state"] == "disabled" and not config.load_config().get("restore_hold"):
        a.append("enable")
    return a


def _ext_item(ext: extensions.Extension | None, eid: str, item: dict | None, drafts: list[dict], errs: dict) -> dict:
    err = _error_info(ext, errs)
    act = active_version(item)
    pend = _pending_info(drafts)
    first = drafts[0] if drafts else None
    hist = (item or {}).get("history") or []
    stamps = [hist[0]["at"] if hist else None, (first or {}).get("created"), (item or {}).get("unreviewed_since")]
    updated = max((float(x) for x in stamps if x), default=None)
    out = {"kind": "extension", "id": eid,
           "type": type_of(ext) if ext else (first or {}).get("type") or "widget",
           "name": ext.label() if ext else (first or {}).get("name") or eid,
           "icon": ext.icon if ext else (first or {}).get("icon"),
           "state": _state_of(ext, err),
           "version": act["n"] if act else None,
           "version_label": (ext.version or None) if ext else None,
           "versions": len((item or {}).get("versions") or []),
           "pending": pend,
           "unreviewed": bool(ext and (item or {}).get("unreviewed_since")),
           "unreviewed_since": (item or {}).get("unreviewed_since") if ext else None,
           "origin": _live_origin(act.get("origin")) if act else (pend or {}).get("origin"),
           "approval": act.get("approval") if act else None,
           "error": err, "updated": updated, "href": href_of(ext) if ext else None}
    if out["origin"] and out["origin"].get("agent") == "unknown" and not out["origin"].get("at"):
        out["origin"] = None
    out["actions"] = _actions(out)
    return out


def extension_items() -> list[dict]:
    refresh()
    exts = {e.id: e for e in extensions.all_extensions()}
    try:
        from . import exterrors
        errs = exterrors.all_recent(list(exts.values()))
    except Exception:  # noqa: BLE001
        errs = {}
    pend: dict[str, list[dict]] = {}
    for d in all_drafts():
        if d.get("status") == "pending":
            pend.setdefault(d["target"], []).append(d)
    out = []
    for eid in sorted(set(exts) | set(pend)):
        out.append(_ext_item(exts.get(eid), eid, load_item("extension", eid), pend.get(eid, []), errs))
    return out


def _rank(it: dict) -> int:
    """pending first, then error, review, unreviewed, the rest."""
    if it["state"] == "pending" or it["pending"]:
        return 0
    return {"error": 1, "review": 2}.get(it["state"], 3 if it["unreviewed"] else 4)


def items(kind: str | None = None, state: str | None = None) -> dict:
    every = extension_items()
    try:
        from . import atelier_kinds                       # read-only kinds (themes, skills, customizations, crons)
        every += atelier_kinds.items()
    except ImportError:
        pass
    counts = {"pending": 0, "error": 0, "unreviewed": 0, "review": 0, "disabled": 0, "total": len(every)}
    for it in every:
        if it["state"] in counts:
            counts[it["state"]] += 1
        if it["pending"] and it["state"] != "pending":
            counts["pending"] += 1
        if it["unreviewed"]:
            counts["unreviewed"] += 1
    sel = [it for it in every if (not kind or it["kind"] == kind) and (not state or it["state"] == state)]
    sel.sort(key=lambda it: (_rank(it), -(it["updated"] or 0)))
    return {"items": sel, "counts": counts}


def public_version(v: dict, active: int | None) -> dict:
    return {"n": v["n"], "at": v["at"], "active": v["n"] == active, "origin": _live_origin(v.get("origin")),
            "approval": v.get("approval"), "base": v.get("base"),
            "files": int(v.get("file_count") or len(v.get("files") or {})),
            "size": v.get("size") or 0, "hash": v.get("hash"), "restorable": bool(v.get("restorable")),
            "health": v.get("health") or "unknown", "error": v.get("error"), "note": v.get("note")}


def detail(kind: str, iid: str) -> dict:
    if kind not in KINDS:
        raise AtelierError(404, "not_found", f"no kind {kind}")
    if kind != "extension":
        try:
            from . import atelier_kinds
            return atelier_kinds.detail(kind, iid)
        except ImportError:
            raise AtelierError(404, "not_found", f"no {kind} {iid}") from None
    refresh()
    ext = extensions.get(iid)
    item = load_item("extension", iid)
    drafts = [d for d in all_drafts() if d.get("target") == iid]
    pend = [d for d in drafts if d.get("status") == "pending"]
    if ext is None and not pend and item is None:
        raise AtelierError(404, "not_found", f"no extension {iid}")
    try:
        from . import exterrors
        recent = exterrors.recent(iid, ext.dir) if ext else []
    except Exception:  # noqa: BLE001
        recent = []
    it = _ext_item(ext, iid, item, pend, {iid: recent})
    active = (item or {}).get("active")
    versions = sorted((item or {}).get("versions") or [], key=lambda v: v["n"], reverse=True)
    decided = [d for d in drafts if d.get("status") != "pending"][:20]
    act = active_version(item)
    errors = [{"message": e.get("message"), "where": e.get("where"), "at": e.get("at"),
               "count": int(e.get("count") or 1)} for e in recent[:10]]
    return {"item": it, "versions": [public_version(v, active) for v in versions],
            "history": ((item or {}).get("history") or [])[:100],
            "drafts": [public_draft(d, []) for d in pend + decided],
            "files": [{"path": p, "size": f["size"]} for p, f in sorted(((act or {}).get("files") or {}).items())],
            "permissions": permissions_of(ext) if ext else None,
            "health": {"state": it["state"], "error": it["error"], "errors": errors, "checked_at": time.time()}}


# ---- preview (a user action: runs the draft) --------------------------------------------------------------------------
_preview_mods: dict[str, Any] = {}
_preview_lock = threading.Lock()


def preview_ext(did: str) -> tuple[dict, extensions.Extension]:
    """The pending draft as an Extension with its api.py imported under `mx_draft_<did>` (kept while it is pending)."""
    rec = _pending(did)
    frozen = _draft_dir(did) / rec["target"]
    ext = extensions._load_one(frozen, load_code=False)                           # noqa: SLF001
    if ext.error:
        raise AtelierError(422, "check_failed", ext.error, check=rec.get("check"))
    if (rec.get("check") or {}).get("status") == "error":
        raise AtelierError(422, "check_failed", "the proposal does not pass its check", check=rec.get("check"))
    if ext.has_api:
        with _preview_lock:
            key = (did, stat_sig(frozen))
            mod = _preview_mods.get(did)
            if mod is None or mod[0] != key:
                mod = (key, extensions._import(ext, f"mx_draft_{did}"))       # noqa: SLF001
                _preview_mods[did] = mod
            ext.module = mod[1]
    return rec, ext


def preview_ctx(ext: extensions.Extension, rec: dict) -> dict:
    """The installed extension's ctx, except secret(): only what the draft declares (all when it declares nothing)."""
    ctx = extensions.make_ctx(ext)
    perms = rec.get("permissions") or {}
    if perms.get("declared"):
        allowed = set(perms.get("secrets") or [])
        get = ctx["secret"]
        ctx["secret"] = lambda name: get(name) if name in allowed else None
    return ctx


def forget_preview(did: str) -> None:
    import sys
    with _preview_lock:
        _preview_mods.pop(did, None)
    sys.modules.pop(f"mx_draft_{did}", None)


# ---- versions: rollback, diffs ----------------------------------------------------------------------------------------
def _versioned(kind: str, iid: str) -> dict:
    if kind not in KINDS:
        raise AtelierError(404, "not_found", f"no kind {kind}")
    if kind != "extension":
        raise AtelierError(422, "not_versioned", f"{kind} creations are not versioned")
    item = load_item(kind, iid)
    if item is None:
        raise AtelierError(404, "not_found", f"no extension {iid}")
    return item


def _restorable(v: dict) -> bool:
    return bool(v.get("restorable")) and all(_blob(f["sha256"]).is_file() for f in (v.get("files") or {}).values())


def rollback(kind: str, iid: str, n: Any) -> dict:
    """Make the kept version `n` active again: its files replace the extension's folder in one step (files changed
    outside the Atelier are kept first as a version). No new version: `history` gets a `rollback` event."""
    if not isinstance(n, int) or isinstance(n, bool):
        raise AtelierError(400, "bad_version", "version must be a version number")
    with contextlib.suppress(OSError):
        refresh(force=True)
    with locked():
        item = _versioned(kind, iid)
        v = _version(item, n)
        if v is None:
            raise AtelierError(404, "not_found", f"version {n} of {iid} is not kept")
        live = extensions.root() / iid
        if item.get("active") == n and not item.get("unreviewed_since") and live.is_dir():
            return {"item": item, "version": n}
        if not _restorable(v):
            raise AtelierError(409, "not_restorable", f"the files of version {n} are not kept")
        _keep_direct(item, live)
        v = _version(item, n)

        def write(dest: Path) -> None:
            for rel, f in (v.get("files") or {}).items():
                p = dest / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(_blob(f["sha256"]), p)
                os.chmod(p, int(f.get("mode") or 0o644))
        _install(iid, write)
        prev = item.get("active")
        _close_active(item)
        item["active"] = n
        v["activated_at"] = time.time()
        _event(item, "rollback", version=n, note=f"from v{prev}" if prev else None)
        _set_live(item, live)
        _save_item(item)
        _accept_permissions(iid)
        touch()
        return {"item": item, "version": n}


def version_detail(kind: str, iid: str, n: int, against: str | None = None) -> dict:
    """Version `n` and its diff against `against` (default: the kept version before it; "active"; a number)."""
    item = _versioned(kind, iid)
    v = _version(item, n)
    if v is None:
        raise AtelierError(404, "not_found", f"version {n} of {iid} is not kept")
    if against in (None, ""):
        older = [x for x in item["versions"] if x["n"] < n]
        base = max(older, key=lambda x: x["n"]) if older else None
    elif against == "active":
        base = active_version(item)
    else:
        try:
            base = _version(item, int(against))
        except ValueError:
            raise AtelierError(400, "bad_version", "against is a version number or active") from None
        if base is None:
            raise AtelierError(404, "not_found", f"version {against} of {iid} is not kept")

    def blob(_rel: str, sha: str) -> bytes | None:
        return _read_blob(sha)
    rows = diff_files(v.get("files") or {}, blob, (base or {}).get("files") or {}, blob)
    return {"version": public_version(v, item.get("active")), "against": base["n"] if base else None, "files": rows}


# ---- retention ----------------------------------------------------------------------------------------------------------
PRUNE_EVERY_S = 86400


def prune_due(now: float | None = None) -> bool:
    return (now or time.time()) - float(_state().get("pruned_at") or 0) >= PRUNE_EVERY_S


def prune(now: float | None = None) -> dict:
    """Keep a version while it is younger than keep_days OR among the keep_versions newest of its creation (the active
    one and a pending draft's base always); decided drafts after DECIDED_KEEP_S; then the objects nothing uses."""
    now = now or time.time()
    s = settings()
    cutoff = now - s["keep_days"] * 86400
    dropped_versions = dropped_drafts = dropped_objects = 0
    with locked():
        drafts = all_drafts()
        bases: dict[str, set] = {}
        for d in drafts:
            if d.get("status") == "pending" and d.get("base") is not None:
                bases.setdefault(d["target"], set()).add(d["base"])
        used: set[str] = set()
        items_dir = root() / "items"
        for p in sorted(items_dir.glob("*/*.json")) if items_dir.is_dir() else []:
            item = config.read_json(p, None)
            if not isinstance(item, dict) or not isinstance(item.get("versions"), list):
                continue
            newest = {v["n"] for v in sorted(item["versions"], key=lambda v: v["n"], reverse=True)[:s["keep_versions"]]}
            keep = newest | {item.get("active")} | bases.get(item.get("id"), set())
            kept = [v for v in item["versions"] if v["n"] in keep or float(v.get("at") or 0) >= cutoff]
            if len(kept) != len(item["versions"]):
                dropped_versions += len(item["versions"]) - len(kept)
                item["versions"] = kept
                _save_item(item)
            for v in kept:
                used.update(f["sha256"] for f in (v.get("files") or {}).values())
        for d in drafts:
            at = float((d.get("decided") or {}).get("at") or 0)
            if d.get("status") != "pending" and at and now - at > DECIDED_KEEP_S:
                shutil.rmtree(_drafts() / d["id"], ignore_errors=True)
                dropped_drafts += 1
        if _objects().is_dir():
            for sub in _objects().iterdir():
                for blob in sub.iterdir() if sub.is_dir() else []:
                    if blob.name not in used:
                        with contextlib.suppress(OSError):
                            blob.unlink()
                            dropped_objects += 1
        _write(root() / "state.json", {**_state(), "pruned_at": now})
        if dropped_versions or dropped_drafts:
            touch()
    return {"versions": dropped_versions, "drafts": dropped_drafts, "objects": dropped_objects}


# ---- the GitHub memory backup: provenance without the files -------------------------------------------------------------
def export_meta() -> dict:
    """`_maxxing/atelier.json` of the memory backup: each item's versions and history, without file lists (a few kB)."""
    out: dict[str, dict] = {}
    items_dir = root() / "items"
    for p in sorted(items_dir.glob("*/*.json")) if items_dir.is_dir() else []:
        item = config.read_json(p, None)
        if not isinstance(item, dict) or not isinstance(item.get("versions"), list):
            continue
        out[f"{item['kind']}:{item['id']}"] = {
            "kind": item["kind"], "id": item["id"], "active": item.get("active"), "next": item.get("next"),
            "versions": [{k: v.get(k) for k in ("n", "at", "hash", "base", "origin", "approval", "health", "error",
                                                "note", "size")} | {"file_count": len(v.get("files") or {})
                                                                    or int(v.get("file_count") or 0)}
                         for v in item["versions"]],
            "history": (item.get("history") or [])[:50]}
    return {"version": 1, "items": out} if out else {}


def import_meta(data: Any) -> int:
    """Restore `_maxxing/atelier.json`: an item this server has not approved anything for gets the backup's metadata
    (versions not restorable until their files are seen again). -> items written. Never runs any code."""
    items = (data or {}).get("items") if isinstance(data, dict) else None
    if not isinstance(items, dict):
        return 0
    n = 0
    with locked():
        for key, it in items.items():
            if not isinstance(it, dict) or it.get("kind") not in KINDS or not isinstance(it.get("versions"), list):
                continue
            iid = str(it.get("id") or "")
            if not extensions.ID_RE.match(iid) or key != f"{it['kind']}:{iid}":
                continue
            local = load_item(it["kind"], iid)
            if local and any((v.get("approval") or {}).get("by") in ("user", "auto") for v in local["versions"]):
                continue                               # approved here: this server's own record wins
            versions = []
            for v in it["versions"]:
                if not isinstance(v, dict) or not isinstance(v.get("n"), int):
                    continue
                versions.append({"n": v["n"], "at": float(v.get("at") or 0), "files": {},
                                 "file_count": int(v.get("file_count") or 0), "hash": str(v.get("hash") or ""),
                                 "base": v.get("base"), "origin": v.get("origin") if isinstance(v.get("origin"), dict)
                                 else dict(UNKNOWN), "approval": v.get("approval") if isinstance(v.get("approval"), dict)
                                 else {"by": None, "at": None}, "restorable": False,
                                 "health": v.get("health") or "unknown", "error": v.get("error"), "note": v.get("note"),
                                 "activated_at": None, "size": int(v.get("size") or 0)})
            if not versions:
                continue
            active = it.get("active") if any(v["n"] == it.get("active") for v in versions) else None
            item = {"kind": it["kind"], "id": iid, "active": active,
                    "next": max(int(it.get("next") or 1), max(v["n"] for v in versions) + 1), "versions": versions,
                    "history": [h for h in it.get("history") or [] if isinstance(h, dict)][:200],
                    "live": {"sig": None, "hash": None}, "unreviewed_since": None}
            _event(item, "migrate", version=active, by="system", note="restored from the memory backup")
            _save_item(item)
            n += 1
        if n:
            touch()
    return n
