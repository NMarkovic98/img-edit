#!/bin/zsh
set -euo pipefail

REMOTE_USER="nmarkovic"
REMOTE_HOST="192.168.0.26"
REMOTE_DIR="reddit_drops"
LOG_FILE="$HOME/Library/Logs/fixtral/reddit-drops-scp.log"

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

log() {
  print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  log "ERROR: Missing file argument."
  exit 64
fi

file="$1"

if [[ ! -f "$file" ]]; then
  log "ERROR: File does not exist: $file"
  exit 66
fi

base="$(basename "$file")"
target="${REMOTE_USER}@${REMOTE_HOST}:~/${REMOTE_DIR}/${base}"

log "Starting upload: $file -> $target"

ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=2 \
  "${REMOTE_USER}@${REMOTE_HOST}" \
  "mkdir -p ~/${REMOTE_DIR}"

scp \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=2 \
  "$file" \
  "$target"

log "Upload complete: $base"
