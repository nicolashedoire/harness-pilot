"""Named, reusable roles for discussions, stored in the local application state."""
from __future__ import annotations

import threading
import uuid

from .. import config

_lock = threading.Lock()


def list_presets() -> list[dict]:
    data = config.read_json(config.STATE / 'discussion-presets.json', [])
    return data if isinstance(data, list) else []


def save(name: str, claude: str, codex: str) -> dict:
    with _lock:
        presets = list_presets()
        if len(presets) >= 100:
            raise ValueError('A maximum of 100 configurations can be saved.')
        preset = {'id': str(uuid.uuid4()), 'name': name.strip(), 'claude_role': claude.strip(), 'codex_role': codex.strip()}
        presets.append(preset)
        config.write_json(config.STATE / 'discussion-presets.json', presets, mode=0o600)
        return preset


def delete(preset_id: str) -> bool:
    with _lock:
        presets = list_presets()
        remaining = [p for p in presets if p.get('id') != preset_id]
        if len(remaining) == len(presets):
            return False
        config.write_json(config.STATE / 'discussion-presets.json', remaining, mode=0o600)
        return True
