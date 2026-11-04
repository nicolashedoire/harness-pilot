#!/usr/bin/env bash
# A local, unprivileged development instance. No system installer or crontab is used.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="${HARNESS_PILOT_LOCAL_DIR:-$ROOT/.harness-pilot-local}"
export MAXXING_STATE="$LOCAL_DIR/state"
export MAXXING_SPAWN=direct
export MAXXING_CRONTAB_FILE="$LOCAL_DIR/crontab"
export MAXXING_SYSTEM_TZ=0
export MAXXING_LICENSE_PING=0
export MAXXING_CLAUDE_UPDATE=0
export MAXXING_AUTH_CHECK=0
export MAXXING_SHORT_TITLES=0
export HARNESS_PILOT_WORKSPACE="$LOCAL_DIR/workspace"
mkdir -p "$MAXXING_STATE" "$HARNESS_PILOT_WORKSPACE"
chmod 700 "$LOCAL_DIR" "$MAXXING_STATE"
cd "$ROOT/server"
uv sync --locked --quiet
uv run --locked python - <<'PY'
import os
from pathlib import Path
from maxxing import config, cmd_core

ws = Path(os.environ['HARNESS_PILOT_WORKSPACE']).resolve()
if not config.config_path().exists():
    config.save_config({'workspace': str(ws), 'files_root': str(ws), 'bind': '127.0.0.1',
                        'port': 8787, 'language': 'fr', 'system_clock': 'keep',
                        'permission_mode': 'default', 'claude_auto_update': False,
                        'auto_update': False})
cmd_core.copy_templates(ws)
PY
if [ "${1:-}" = "link" ]; then
  exec uv run --locked maxxing setup-link
fi
exec uv run --locked maxxing serve --host 127.0.0.1 --port 8787
