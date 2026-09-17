#!/bin/sh
set -eu

# Developer compatibility wrapper only. Release users should never need this
# repository script; Computer provisioning is owned by the installed binary.
mode="${1:-shared}"
screens="${2:-}"
[ "$#" -le 2 ] || { echo "usage: scripts/setup-linux-computer.sh [shared|managed-cdp] [1-8]" >&2; exit 2; }
case "$mode" in
  native|native-x11|shared) mode=shared ;;
  managed-cdp) ;;
  *)
    echo "usage: scripts/setup-linux-computer.sh [shared|managed-cdp] [1-8]" >&2
    exit 2
    ;;
esac
case "$screens" in
  ""|[1-8]) ;;
  *) echo "usage: scripts/setup-linux-computer.sh [shared|managed-cdp] [1-8]" >&2; exit 2 ;;
esac

if command -v friday >/dev/null 2>&1; then
  if [ -n "$screens" ]; then exec friday setup computer "$mode" "$screens"; fi
  exec friday setup computer "$mode"
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_root"
if [ -n "$screens" ]; then exec npm run --silent friday -- setup computer "$mode" "$screens"; fi
exec npm run --silent friday -- setup computer "$mode"
