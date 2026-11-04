#!/usr/bin/env bash
# The local app as an optional background service of the logged-in user on macOS (a launchd agent), so that scheduled
# jobs, backups, resident missions and Telegram keep running once the terminal is closed. Nothing is installed until
# `install` is run. Called by scripts/dev-local.sh, which passes its settings:
#   bash scripts/dev-local.sh service install     write ~/Library/LaunchAgents/<label>.plist and start it
#   bash scripts/dev-local.sh service status      state, PID, URL, plist, logs and the PATH it runs with
#   bash scripts/dev-local.sh service restart     restart it (after a `git pull`)
#   bash scripts/dev-local.sh service uninstall   stop it and remove the plist (state, workspace and logs are kept)
# The agent runs `/bin/bash scripts/dev-local.sh`: the same environment as in a terminal, by construction.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="${HARNESS_PILOT_LOCAL_DIR:?run it through scripts/dev-local.sh service ...}"
PORT="${HARNESS_PILOT_PORT:-8787}"
LABEL="${HARNESS_PILOT_SERVICE_LABEL:-local.harness-pilot}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$LOCAL_DIR/logs"
DOMAIN="gui/$(id -u)"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
listener() { { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR == 2 {print $1 " (PID " $2 ")"}'; }
answers() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/auth/state" 2>/dev/null; }
size() { if [ -f "$1" ]; then du -h "$1" | awk '{print $1}'; else echo "none yet"; fi; }

[ "$(uname -s)" = Darwin ] || fail "the background service uses launchd, which exists on macOS only"
case "$LABEL" in *[!A-Za-z0-9._-]*|"") fail "HARNESS_PILOT_SERVICE_LABEL: letters, digits, '.', '_' and '-' only";; esac
case "$PORT" in *[!0-9]*|"") fail "HARNESS_PILOT_PORT must be a number";; esac

install() {
  if loaded || [ -f "$PLIST" ]; then
    fail "already installed ($PLIST). See: bash scripts/dev-local.sh service status (to change it: uninstall, then install)"
  fi
  local who
  who="$(listener)"
  [ -z "$who" ] || fail "port $PORT is already in use by $who - stop that app first (Ctrl+C in its terminal), or choose another port with HARNESS_PILOT_PORT"
  command -v uv >/dev/null || fail "uv is not on the PATH of this terminal: the service would not find it"
  mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
  chmod 700 "$LOCAL_DIR"
  # launchd starts agents with PATH=/usr/bin:/bin:/usr/sbin:/sbin: uv, claude, codex, ffmpeg... live elsewhere, so the
  # PATH of the terminal running `install` is recorded (install again after installing a tool in a new place)
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml "$ROOT/scripts/dev-local.sh")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$PATH")</string>
    <key>HARNESS_PILOT_LOCAL_DIR</key><string>$(xml "$LOCAL_DIR")</string>
    <key>HARNESS_PILOT_PORT</key><string>$PORT</string>
    <key>LANG</key><string>$(xml "${LANG:-en_US.UTF-8}")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/server.err.log")</string>
</dict>
</plist>
EOF
  plutil -lint -s "$PLIST" || { rm -f "$PLIST"; fail "the service file could not be written correctly"; }
  local seen=0 i
  [ -f "$LOG_DIR/server.err.log" ] && seen=$(wc -c < "$LOG_DIR/server.err.log")
  launchctl bootstrap "$DOMAIN" "$PLIST" || { rm -f "$PLIST"; fail "launchctl refused the service (see above)"; }
  say "starting $LABEL on http://127.0.0.1:$PORT ..."
  for i in $(seq 1 60); do
    if answers; then say "installed and running: http://127.0.0.1:$PORT (it also starts at every login)"; status_lines; return 0; fi
    # macOS keeps background services out of Desktop, Documents, Downloads, iCloud Drive and external disks
    if tail -c +"$((seen + 1))" "$LOG_DIR/server.err.log" 2>/dev/null | grep -q "Operation not permitted"; then
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"
      fail "macOS does not let a background service read $ROOT or $LOCAL_DIR (privacy protection of Desktop, Documents, Downloads, iCloud Drive and external disks). The service was removed again. Clone the repository in another folder (for example ~/harness-pilot) and install from there; details in $LOG_DIR/server.err.log"
    fi
    sleep 1
  done
  say "installed, but not answering yet on http://127.0.0.1:$PORT: read $LOG_DIR/server.err.log"
  status_lines
}

status_lines() {
  say "plist:  $PLIST"
  say "logs:   $LOG_DIR/server.log ($(size "$LOG_DIR/server.log")), $LOG_DIR/server.err.log ($(size "$LOG_DIR/server.err.log"))"
  say "        (open them in Console.app, or: tail -f \"$LOG_DIR/server.err.log\")"
  if [ -f "$PLIST" ]; then
    say "PATH:   $(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PATH' "$PLIST" 2>/dev/null || echo '?')"
  fi
}

status() {
  if ! [ -f "$PLIST" ] && ! loaded; then
    say "not installed (bash scripts/dev-local.sh service install)"
    return 3
  fi
  local info state pid code
  info="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null || true)"
  state="$(printf '%s\n' "$info" | awk -F' = ' '/^\tstate = /{print $2; exit}')"
  pid="$(printf '%s\n' "$info" | awk -F' = ' '/^\tpid = /{print $2; exit}')"
  code="$(printf '%s\n' "$info" | awk -F' = ' '/^\tlast exit code = /{print $2; exit}')"
  say "service: $LABEL - ${state:-not loaded}${pid:+, PID $pid}${code:+, last exit: $code}"
  if answers; then say "url:    http://127.0.0.1:$PORT (answering)"; else say "url:    http://127.0.0.1:$PORT (not answering)"; fi
  status_lines
  [ "${state:-}" = running ] && answers
}

restart() {
  loaded || fail "not running as a service (bash scripts/dev-local.sh service install)"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  say "restarted: $LABEL"
}

uninstall() {
  if ! loaded && ! [ -f "$PLIST" ]; then say "not installed"; return 0; fi
  if loaded; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl bootout "$DOMAIN" "$PLIST" || true; fi
  rm -f "$PLIST"
  say "uninstalled: $LABEL (state, workspace and logs kept in $LOCAL_DIR)"
}

case "${1:-}" in
  install) install ;;
  status) status ;;
  restart) restart ;;
  uninstall) uninstall ;;
  *) fail "usage: bash scripts/dev-local.sh service install|status|restart|uninstall" ;;
esac
