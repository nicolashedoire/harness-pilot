#!/usr/bin/env python3
"""Optional Codex launcher: expose external REA only to resident reverse-engineering runs."""
import json
import os
from pathlib import Path
import shutil
import sys

from status import resolve


def reverse_run(state, cwd):
    if not state:
        return False
    state = Path(state).resolve()
    cwd = Path(cwd).resolve()
    if cwd.name != 'repo' or cwd.parent.parent != state / 'companions' / 'runs':
        return False
    for path in (state / 'sessions').glob('*.json'):
        try:
            companion = json.loads(path.read_text()).get('companion') or {}
            if companion.get('id') == 'reverse-engineer' and companion.get('run_id') == cwd.parent.name:
                return True
        except (OSError, ValueError, AttributeError):
            continue
    return False


def arguments(args, executable, enabled):
    if not enabled or not executable or not args or args[0] != 'exec':
        return args
    settings = {
        'mcp_servers.rea.command': executable,
        'mcp_servers.rea.args': ['mcp'],
        'mcp_servers.rea.enabled_tools': ['analyze_javascript_application', 'inspect_analysis_view'],
        'mcp_servers.rea.tools.analyze_javascript_application.approval_mode': 'approve',
        'mcp_servers.rea.tools.inspect_analysis_view.approval_mode': 'approve',
        'mcp_servers.rea.startup_timeout_sec': 60,
        'mcp_servers.rea.tool_timeout_sec': 300,
        'mcp_optional_startup_grace_ms': 60000,
    }
    overrides = [item for key, value in settings.items() for item in ('-c', f'{key}={json.dumps(value)}')]
    return [args[0], *overrides, *args[1:]]


def main():
    binary = os.environ.get('PILOT_REA_CODEX_BIN') or shutil.which('codex')
    if not binary or Path(binary).resolve() == Path(__file__).resolve():
        print('Set PILOT_REA_CODEX_BIN to the real Codex executable.', file=sys.stderr)
        return 127
    executable, _ = resolve()
    enabled = reverse_run(os.environ.get('PILOT_REA_STATE'), Path.cwd())
    args = arguments(sys.argv[1:], executable, enabled)
    try:
        os.execv(binary, [binary, *args])
    except OSError as error:
        print(f'Codex launch failed: {error.strerror}', file=sys.stderr)
        return 126


if __name__ == '__main__':
    sys.exit(main())
