#!/bin/zsh
set -euo pipefail

LABEL="com.fixtral.photoshop-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_DIR="/Users/nikolamarkovic/Desktop/private/photo-edit/fixtral"
NODE_BIN="/Users/nikolamarkovic/.nvm/versions/node/v22.13.1/bin/node"
SCRIPT="$REPO_DIR/scripts/photoshop/local-helper.mjs"
LOG_DIR="$HOME/Library/Logs/fixtral"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SCRIPT</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/photoshop-helper.out.log</string>

  <key>StandardErrorPath</key>
  <string>$LOG_DIR/photoshop-helper.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PHOTOSHOP_HELPER_PORT</key>
    <string>3999</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed and started $LABEL"
echo "Health check: curl http://127.0.0.1:3999/health"
echo "Logs:"
echo "  $LOG_DIR/photoshop-helper.out.log"
echo "  $LOG_DIR/photoshop-helper.err.log"
