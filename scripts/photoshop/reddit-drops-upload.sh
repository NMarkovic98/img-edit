#!/bin/zsh
set -euo pipefail

file="$1"
base="$(basename "$file")"

scp "$file" "nmarkovic@192.168.0.26:~/reddit_drops/$base"
