#!/bin/zsh
set -euo pipefail

LABEL="com.fixtral.photoshop-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "Uninstalled $LABEL"
