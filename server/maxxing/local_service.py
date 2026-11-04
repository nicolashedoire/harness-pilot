"""The optional macOS background service of a local installation (`scripts/macos-service.sh`), read-only.

Settings -> System shows whether this checkout's launchd agent is installed, whether this very server runs as it and
since when, where its plist and its logs are, and the exact commands that install, restart or remove it (run in a
terminal: the agent records that terminal's PATH). Nothing here loads, unloads or writes a LaunchAgent and launchctl
is never called: the plist is read with plistlib, and launchd names the job of the processes it starts in
`XPC_SERVICE_NAME` (inherited by dev-local.sh, uv and this server). See docs/dev/API.md "System".
"""
from __future__ import annotations

import os
import plistlib
import re
import shlex
import sys
import time
from pathlib import Path

from . import config

DEFAULT_LABEL = "local.harness-pilot"   # scripts/macos-service.sh, HARNESS_PILOT_SERVICE_LABEL
DEFAULT_PORT = 8787                     # scripts/dev-local.sh, HARNESS_PILOT_PORT
ACTIONS = ("install", "status", "restart", "uninstall")
_LABEL = re.compile(r"^[A-Za-z0-9._-]{1,200}$")    # what macos-service.sh accepts
_MAX_PLIST = 64 * 1024
STARTED = time.time()                   # this server process: imported at start-up with the API routers


def agents_dir() -> Path:
    """~/Library/LaunchAgents (`MAXXING_LAUNCH_AGENTS_DIR` in tests: they never read the real one)."""
    d = os.environ.get("MAXXING_LAUNCH_AGENTS_DIR")
    return Path(d) if d else Path.home() / "Library" / "LaunchAgents"


def is_mac() -> bool:
    return sys.platform == "darwin"


def _script() -> Path:
    return config.CODE / "scripts" / "dev-local.sh"


def _local_dir() -> Path:
    """dev-local.sh: MAXXING_STATE=<local dir>/state; the service also gets HARNESS_PILOT_LOCAL_DIR."""
    d = os.environ.get("HARNESS_PILOT_LOCAL_DIR")
    return Path(d) if d else config.STATE.parent


def _port() -> int:
    try:
        return int(config.load_config().get("port") or DEFAULT_PORT)
    except (TypeError, ValueError):
        return DEFAULT_PORT


def _same(a: object, b: Path) -> bool:
    try:
        return isinstance(a, str) and bool(a) and Path(a).expanduser().resolve() == b.resolve()
    except (OSError, RuntimeError, ValueError):
        return False


def _read(path: Path) -> dict | None:
    try:
        if not path.is_file() or path.stat().st_size > _MAX_PLIST:
            return None
        with path.open("rb") as f:
            data = plistlib.load(f)
    except Exception:  # noqa: BLE001 - a broken or foreign file is simply not this service
        return None
    return data if isinstance(data, dict) else None


def _ours(data: dict) -> bool:
    """The agent runs this checkout's dev-local.sh for this local dir (another clone or instance is not ours)."""
    args = data.get("ProgramArguments")
    if not isinstance(args, list) or not any(_same(a, _script()) for a in args):
        return False
    env = data.get("EnvironmentVariables")
    local = env.get("HARNESS_PILOT_LOCAL_DIR") if isinstance(env, dict) else None
    return local is None or _same(local, _local_dir())


def _labels() -> list[str]:
    out: list[str] = []
    for v in (os.environ.get("XPC_SERVICE_NAME"), os.environ.get("HARNESS_PILOT_SERVICE_LABEL"), DEFAULT_LABEL):
        if v and _LABEL.match(v) and v not in out:
            out.append(v)
    return out


def commands(label: str, port: int, local: Path) -> dict[str, str]:
    """The exact commands, from any folder: the settings that are not the defaults go first, as dev-local.sh reads them."""
    env = []
    if label != DEFAULT_LABEL:
        env.append(f"HARNESS_PILOT_SERVICE_LABEL={shlex.quote(label)}")
    if port != DEFAULT_PORT:
        env.append(f"HARNESS_PILOT_PORT={port}")
    if not _same(str(local), config.CODE / ".harness-pilot-local"):
        env.append(f"HARNESS_PILOT_LOCAL_DIR={shlex.quote(str(local))}")
    base = " ".join([*env, "bash", shlex.quote(str(_script())), "service"])
    out = {a: f"{base} {a}" for a in ACTIONS}
    out["update"] = f"git -C {shlex.quote(str(config.CODE))} pull"
    return out


def status() -> dict:
    """GET /api/system/local-service."""
    if os.environ.get("HARNESS_PILOT_LOCAL_MODE") != "1" or not is_mac():
        return {"supported": False}
    found_label, found = None, None
    for label in _labels():
        data = _read(agents_dir() / f"{label}.plist")
        if data is not None and _ours(data):
            found_label, found = label, data
            break
    custom = os.environ.get("HARNESS_PILOT_SERVICE_LABEL") or ""
    label = found_label or (custom if _LABEL.match(custom) else DEFAULT_LABEL)
    running = found is not None and os.environ.get("XPC_SERVICE_NAME") == label
    local, port = _local_dir(), _port()
    err = found.get("StandardErrorPath") if found else None
    logs = Path(err).parent if isinstance(err, str) and err else local / "logs"
    return {
        "supported": True,
        "installed": found is not None,
        "label": label,
        "plist": str(agents_dir() / f"{label}.plist"),
        "running": running,
        "since": STARTED if running else None,
        "logs": str(logs),
        "url": f"http://127.0.0.1:{port}",
        "commands": commands(label, port, local),
    }
