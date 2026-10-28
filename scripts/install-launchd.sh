#!/usr/bin/env bash
# Install (or reinstall) Thunder Vision as a per-user launchd agent: starts at
# login, restarts on crash.
#
#   ./scripts/install-launchd.sh [dev]  live reload: Next HMR for the UI, and
#                                       tsx watch restarts on server-code edits
#   ./scripts/install-launchd.sh prod   stable: serves the last `pnpm build`
#
# Settings live in .env (see .env.example); the server reads it on start.
# Rerun after changing TV_LAUNCHD_LABEL or switching modes.
set -euo pipefail

MODE="${1:-dev}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$DIR/.env"
  set +a
fi
LABEL="${TV_LAUNCHD_LABEL:-local.thunder-vision}"
PORT="${PORT:-7700}"
NODE="$(command -v node)"
TMUX_BIN="$(command -v tmux)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/thunder-vision.log"
DOMAIN="gui/$(id -u)"

case "$MODE" in
  dev)
    NODE_ENV=development
    # tsx only watches what server.ts imports; next.config.ts is loaded by Next.
    ARGS=("$DIR/node_modules/tsx/dist/cli.mjs" watch --clear-screen=false
      --include next.config.ts --include .env server.ts)
    ;;
  prod)
    NODE_ENV=production
    [[ -f "$DIR/.next/BUILD_ID" ]] || { echo "Run pnpm build first." >&2; exit 1; }
    ARGS=(--import tsx server.ts)
    ;;
  *)
    echo "usage: $0 [dev|prod]" >&2
    exit 2
    ;;
esac

PROGRAM="    <string>$NODE</string>"
for arg in "${ARGS[@]}"; do
  PROGRAM+=$'\n'"    <string>$arg</string>"
done

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$PROGRAM
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>$NODE_ENV</string>
    <key>LANG</key>
    <string>${LANG:-en_US.UTF-8}</string>
    <key>TMUX_BIN</key>
    <string>$TMUX_BIN</string>
    <key>PATH</key>
    <string>$(dirname "$NODE"):$(dirname "$TMUX_BIN"):/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF

# bootout returns before the old instance is gone; bootstrap fails until it is.
if launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; then
  for _ in $(seq 50); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.1
  done
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL ($MODE) → http://127.0.0.1:$PORT (logs: $LOG)"
echo "Restart: launchctl kickstart -k $DOMAIN/$LABEL"
echo "Remove:  launchctl bootout $DOMAIN/$LABEL && rm $PLIST"
