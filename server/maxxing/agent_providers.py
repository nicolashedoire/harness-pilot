"""Agent provider contracts. Optional local executables stay in removable extensions.

This module is stdlib-only: detached session runners use the same manifest validation.
External adapters are trusted installed programs, not an OS security boundary.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil

from . import config

PROTOCOL = 'pilot-jsonl-v1'
CAPABILITIES = {'text', 'source-edit', 'plan', 'attachments'}
_ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,47}$')
BUILTINS = [
    {'id': 'claude', 'name': 'Claude Code', 'capabilities': ['text', 'source-edit', 'plan', 'attachments'], 'builtin': True},
    {'id': 'codex', 'name': 'Codex', 'capabilities': ['text', 'source-edit', 'plan', 'attachments'], 'builtin': True},
]


def parse(data: dict, directory: Path) -> dict:
    raw = data.get('agent')
    if not isinstance(raw, dict) or raw.get('protocol') != PROTOCOL:
        raise ValueError(f'agent.protocol must be {PROTOCOL}')
    command = raw.get('command')
    if (not isinstance(command, list) or not 1 <= len(command) <= 32
            or any(not isinstance(arg, str) or not arg or len(arg) > 4096 or '\x00' in arg for arg in command)):
        raise ValueError('agent.command must be a nonempty argument list, never a shell string')
    # A relative executable resolves inside its own extension, never inside a session checkout.
    binary = Path(command[0]).expanduser()
    if '/' in command[0] and not binary.is_absolute():
        binary = (directory / binary).resolve()
    resolved = str(binary) if binary.is_absolute() else shutil.which(command[0])
    if not resolved or not Path(resolved).is_file() or not os.access(resolved, os.X_OK):
        raise ValueError('agent.command executable is unavailable')
    capabilities = raw.get('capabilities', ['text'])
    if (not isinstance(capabilities, list) or not all(isinstance(c, str) and c in CAPABILITIES for c in capabilities)
            or 'text' not in capabilities):
        raise ValueError('agent.capabilities must include text and use supported capability names')
    return {'command': [resolved, *command[1:]], 'protocol': PROTOCOL,
            'capabilities': sorted(set(capabilities))}


def available() -> list[dict]:
    result = [dict(p) for p in BUILTINS]
    # Do not import api.py or any provider code when discovering an agent. A broken plugin is isolated.
    folder = config.workspace() / 'extensions'
    disabled = (config.load_config().get('extensions') or {}).get('disabled') or []
    for directory in sorted(folder.glob('*')):
        if not directory.is_dir() or not _ID.fullmatch(directory.name) or directory.name in disabled:
            continue
        try:
            manifest = json.loads((directory / 'manifest.json').read_text())
            if manifest.get('type') != 'agent' or manifest.get('id', directory.name) != directory.name:
                continue
            if manifest.get('api', 1) != 1:
                continue
            agent = parse(manifest, directory)
            name = manifest.get('name') or directory.name
            if isinstance(name, dict):
                name = name.get(config.load_config().get('language') or 'en') or name.get('en') or directory.name
            result.append({'id': 'plugin:' + directory.name, 'name': str(name)[:80], 'builtin': False, **agent})
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return result


def get(ident: str) -> dict | None:
    return next((p for p in available() if p['id'] == ident), None)


def public() -> list[dict]:
    return [{k: v for k, v in p.items() if k != 'command'} for p in available()]


def events(event: object) -> list[dict]:
    """Bounded presentation events; plugins cannot inject server control or auth events."""
    if not isinstance(event, dict):
        return []
    if event.get('type') == 'message' and isinstance(event.get('text'), str):
        return [{'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': event['text'][:300000]}]}}]
    if event.get('type') != 'result':
        return []
    usage = event.get('usage') if isinstance(event.get('usage'), dict) else {}
    # An out-of-range integer (too large for float) is clamped to the 10**12 cap, not fed to isfinite,
    # which only guards the inf/nan floats a plugin might emit.
    counts = {k: min(10**12, max(0, int(v))) for k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens',
              'cache_creation_input_tokens')
              if isinstance(v := usage.get(k), (float, int)) and (isinstance(v, int) or math.isfinite(v))}
    failed = event.get('ok') is not True
    return [{'type': 'result', 'subtype': 'error' if failed else 'success', 'is_error': failed,
             'usage': counts, **({'errors': [str(event.get('error') or 'Agent plugin failed')[:1000]]} if failed else {})}]


def history(path: Path) -> list[dict]:
    """Bound the shared text context; native provider conversation state remains adapter-owned."""
    if not path.exists():
        return []
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - 256 * 1024))
        lines = stream.read().decode('utf-8', 'replace').splitlines()
    messages = []
    for line in lines:
        try:
            event = json.loads(line)
            if event.get('type') == 'mx_user':
                messages.append({'role': 'user', 'text': str(event.get('text') or '')[:16000]})
            elif event.get('type') == 'assistant':
                text = '\n'.join(b['text'] for b in (event.get('message') or {}).get('content', [])
                                 if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str))
                if text:
                    messages.append({'role': 'assistant', 'text': text[:16000]})
        except (ValueError, TypeError, AttributeError):
            continue
    # The current prompt is already appended by the runner; it is passed separately.
    if messages and messages[-1]['role'] == 'user':
        messages.pop()
    return messages[-8:]
