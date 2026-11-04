#!/usr/bin/env python3
"""Launch the independently installed REA CLI without a shell or core dependency."""
import os
import sys

from status import resolve


def main():
    executable, reason = resolve()
    if not executable:
        print(f'REA unavailable: {reason}. Run scripts/status.py to check the connection.', file=sys.stderr)
        return 127
    try:
        os.execv(executable, [executable, *sys.argv[1:]])
    except OSError as error:
        print(f'REA launch failed: {error.strerror}', file=sys.stderr)
        return 126


if __name__ == '__main__':
    sys.exit(main())
