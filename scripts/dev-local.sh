#!/usr/bin/env bash
# A local, unprivileged development instance. No system installer or crontab is used.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="${HARNESS_PILOT_LOCAL_DIR:-$ROOT/.harness-pilot-local}"
export MAXXING_STATE="$LOCAL_DIR/state"
export MAXXING_SPAWN=direct
export HARNESS_PILOT_LOCAL_MODE=1
export MAXXING_CRONTAB_FILE="$LOCAL_DIR/crontab"
export MAXXING_SYSTEM_TZ=0
export MAXXING_LICENSE_PING=0
export MAXXING_CLAUDE_UPDATE=0
export MAXXING_AUTH_CHECK=0
export MAXXING_SHORT_TITLES=0
export HARNESS_PILOT_WORKSPACE="$LOCAL_DIR/workspace"
# Product skills (pilot-theme for "Create with harness-pilot"...) go next to the workspace, not into ~/.claude/skills:
# Claude Code reads .claude/skills from a session's folder and its parents, so only this workspace's sessions see
# them and the personal skills of this computer are never replaced (a personal skill of the same name wins).
export MAXXING_SKILLS_DIR="$LOCAL_DIR/.claude/skills"
# The same for Codex: it reads .agents/skills from a session's folder and its parents up to the Git root (the default
# local dir is inside this checkout), so ~/.agents/skills is never written.
export MAXXING_CODEX_SKILLS_DIR="$LOCAL_DIR/.agents/skills"
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
try:
    cmd_core.install_skills()                   # like `pilot init`, into MAXXING_SKILLS_DIR and MAXXING_CODEX_SKILLS_DIR
except Exception as e:                          # never keeps the server from starting
    print(f"product skills not installed: {e}", flush=True)
PY
if [ "${1:-}" = "link" ]; then
  exec uv run --locked pilot setup-link
fi
exec uv run --locked pilot serve --host 127.0.0.1 --port 8787   # `maxxing` = the same command
