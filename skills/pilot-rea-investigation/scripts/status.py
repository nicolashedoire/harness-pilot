#!/usr/bin/env python3
"""Read-only discovery of an optional external REA CLI; never installs or configures it."""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


def resolve(binary=None):
    """Resolve an explicit CLI, an environment override, or external user configuration."""
    requested = binary or os.environ.get('REA_BIN')
    if not requested:
        root = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
        connection = Path(os.environ.get('REA_CONNECTION_FILE') or root / 'harness-pilot' / 'rea.json')
        try:
            value = json.loads(connection.read_text()) if connection.exists() else {}
            requested = value.get('executable')
            if not isinstance(value, dict) or (requested is not None and
                    (not isinstance(requested, str) or not requested or not Path(requested).is_absolute())):
                return None, 'invalid_connection'
        except (OSError, ValueError, AttributeError):
            return None, 'invalid_connection'
    path = shutil.which(requested or 'rea')
    return path, None if path else 'not_installed'


def command(argv):
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
        return p.stdout.decode('utf-8', 'replace').strip()[:4096] if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def status(binary=None):
    path, reason = resolve(binary)
    report = command([path, '--version', '--json']) if path else None
    try:
        details = json.loads(report) if report else {}
    except ValueError:
        details = {}
    version = details.get('version')
    return {'installed': bool(path), 'executable': path, 'version': version,
            'node_version': details.get('runtime', {}).get('version'),
            'supported_runtime': details.get('supported_runtime'),
            'reason': reason or (None if version else 'probe_failed'), 'providers_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rea')
    print(json.dumps(status(parser.parse_args().rea)))
