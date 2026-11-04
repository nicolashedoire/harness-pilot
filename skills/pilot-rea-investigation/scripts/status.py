#!/usr/bin/env python3
"""Read-only discovery of an optional external REA CLI; never installs or configures it."""
import argparse
import json
import os
import shutil
import subprocess


def command(argv):
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
        return p.stdout.decode('utf-8', 'replace').strip()[:4096] if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def status(binary=None):
    requested = binary or os.environ.get('REA_BIN') or 'rea'
    path = shutil.which(requested)
    return {'installed': bool(path), 'executable': path, 'version': command([path, '--version']) if path else None,
            'node_version': command(['node', '--version']) if shutil.which('node') else None,
            'reason': None if path else 'not_installed', 'providers_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--rea')
    print(json.dumps(status(parser.parse_args().rea)))
