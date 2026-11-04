"""The Codex models offered by the model pickers (new session, discussion, mixed team, scheduled prompt).
See docs/dev/API.md#system and INTERNALS.md `maxxing.codex_models`.

The list comes from the Codex CLI that sessions use: `codex debug models` prints its model catalog as JSON (codex-cli
0.150.1: `{"models": [{slug, display_name, description, visibility, priority, ...}]}`, refreshed for the signed-in
account, the shipped one otherwise), `--bundled` only the catalog shipped with the binary. The pickers get the models
the CLI shows in its own picker (`visibility` "list"), in its order (`priority`). When the CLI cannot give it (not
installed, a version without `debug models`, unreadable output), KNOWN_MODELS below. A picker always keeps "Other…"
for any model id, and the empty default (the CLI's own choice).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time

from .sessions import codex

# What codex-cli 0.150.1 shows in its own picker (`codex debug models --bundled`, `visibility` "list", by `priority`):
# used only when the CLI cannot list its models. Update it when a Codex release changes them.
KNOWN_MODELS = (
    ("gpt-5.6-sol", "GPT-5.6-Sol", "Latest frontier agentic coding model."),
    ("gpt-5.6-terra", "GPT-5.6-Terra", "Balanced agentic coding model for everyday work."),
    ("gpt-5.6-luna", "GPT-5.6-Luna", "Fast and affordable agentic coding model."),
    ("gpt-5.5", "GPT-5.5", "Frontier model for complex coding, research, and real-world work."),
    ("gpt-5.2", "GPT-5.2", "Optimized for professional work and long-running agents."),
)
TTL_S = 600                  # the list is read again after 10 min, or when the binary changes
TIMEOUT_S = 15               # `debug models` may refresh the catalog over the network first
MODEL_ID_RE = re.compile(r"[A-Za-z0-9._:@/\[\]][A-Za-z0-9._:@/\[\]-]{0,99}")   # = sessions.service._MODEL_ID

_cache: tuple[float, str, dict] | None = None


def _binary() -> str | None:
    return os.environ.get("MAXXING_CODEX_BIN") or shutil.which("codex")


def parse(text: str) -> list[dict]:
    """`codex debug models` JSON -> [{id, label, description}] of the models its own picker shows, in its order. Ids
    a session would refuse (`_MODEL_ID`) and repeats are left out."""
    try:
        data = json.loads(text)
    except ValueError:
        return []
    rows = data.get("models") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    listed = [m for m in rows if isinstance(m, dict) and m.get("visibility", "list") == "list"]
    listed.sort(key=lambda m: m["priority"] if isinstance(m.get("priority"), int) else 10_000)
    out, seen = [], set()
    for m in listed:
        slug = m.get("slug")
        if not isinstance(slug, str) or not MODEL_ID_RE.fullmatch(slug) or slug in seen:
            continue
        seen.add(slug)
        name = m.get("display_name")
        desc = m.get("description")
        out.append({"id": slug, "label": name.strip()[:80] if isinstance(name, str) and name.strip() else slug,
                    "description": desc.strip()[:200] if isinstance(desc, str) else ""})
    return out


def _ask(path: str, *args: str) -> list[dict]:
    try:
        r = subprocess.run([path, *codex.privacy_args(), "debug", "models", *args], stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, errors="replace", timeout=TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return parse(r.stdout) if r.returncode == 0 else []


def models() -> dict:
    """{models: [{id, label, description}], source: "cli" | "bundled" | "builtin"}: `codex debug models`, else
    `codex debug models --bundled`, else KNOWN_MODELS. Cached TTL_S per binary (path and modification time)."""
    global _cache
    path = _binary()
    try:
        key = f"{path}:{os.stat(path).st_mtime}" if path else ""
    except OSError:
        key = str(path)
    if _cache and _cache[1] == key and time.time() - _cache[0] < TTL_S:
        return _cache[2]
    result = None
    if path:
        for args, source in (((), "cli"), (("--bundled",), "bundled")):
            if listed := _ask(path, *args):
                result = {"models": listed, "source": source}
                break
    if result is None:
        result = {"models": [{"id": i, "label": name, "description": d} for i, name, d in KNOWN_MODELS],
                  "source": "builtin"}
    _cache = (time.time(), key, result)
    return result


def invalidate() -> None:
    global _cache
    _cache = None
