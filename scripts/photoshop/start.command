#!/bin/zsh
# Double-click in Finder to launch the Photoshop helper on demand.
# Closing the Terminal window stops the helper.
set -e

cd "$(dirname "$0")/../.."

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

exec node scripts/photoshop/local-helper.mjs
