#!/bin/sh
set -eu

attempts="${FRIDAY_COMPUTER_SMOKE_ATTEMPTS:-60}"
case "$attempts" in
  ''|*[!0-9]*) echo "FAIL: FRIDAY_COMPUTER_SMOKE_ATTEMPTS must be a positive integer." >&2; exit 2 ;;
esac
if [ "$attempts" -lt 1 ] || [ "$attempts" -gt 600 ]; then
  echo "FAIL: FRIDAY_COMPUTER_SMOKE_ATTEMPTS must be between 1 and 600." >&2
  exit 2
fi

manager_environment=""
if command -v systemctl >/dev/null 2>&1; then manager_environment=$(systemctl --user show-environment 2>/dev/null || true); fi
manager_value() { printf '%s\n' "$manager_environment" | sed -n "s/^$1=//p" | tail -n 1; }

session_type="${XDG_SESSION_TYPE:-$(manager_value XDG_SESSION_TYPE)}"
provider="${FRIDAY_COMPUTER_PROVIDER:-$(manager_value FRIDAY_COMPUTER_PROVIDER)}"
desktop_indexes="${FRIDAY_COMPUTER_X11_AGENT_DESKTOPS:-$(manager_value FRIDAY_COMPUTER_X11_AGENT_DESKTOPS)}"
if [ "$provider" != "linux-x11" ]; then echo "FAIL: FRIDAY_COMPUTER_PROVIDER must be linux-x11; got ${provider:-unset}." >&2; exit 1; fi
if [ "$session_type" != "x11" ]; then echo "FAIL: native Computer requires X11; got ${session_type:-unknown}. No alternate compositor/viewer fallback is enabled." >&2; exit 1; fi
command -v wmctrl >/dev/null 2>&1 || { echo "FAIL: wmctrl is required." >&2; exit 1; }
[ -n "$desktop_indexes" ] || { echo "FAIL: FRIDAY_COMPUTER_X11_AGENT_DESKTOPS is not configured." >&2; exit 1; }

desktops=$(wmctrl -d)
old_ifs=$IFS
IFS=,
for index in $desktop_indexes; do
  printf '%s\n' "$desktops" | awk -v i="$index" '$1 == i {found=1} END {exit found ? 0 : 1}' || {
    echo "FAIL: configured FRIDAY virtual desktop index $index does not exist." >&2
    exit 1
  }
done
IFS=$old_ifs

cdp_url="${FRIDAY_COMPUTER_CDP_URL:-$(manager_value FRIDAY_COMPUTER_CDP_URL)}"
cdp_url="${cdp_url:-http://127.0.0.1:9222/}"
case "$cdp_url" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) echo "FAIL: CDP must remain loopback-only: $cdp_url" >&2; exit 1 ;;
esac
case "$cdp_url" in */) version_url="${cdp_url}json/version" ;; *) version_url="$cdp_url/json/version" ;; esac

n=1
ready=0
while [ "$n" -le "$attempts" ]; do
  if curl --connect-timeout 1 --max-time 2 --fail --silent "$version_url" >/dev/null 2>&1; then ready=1; break; fi
  [ "$n" -lt "$attempts" ] && sleep 0.25
  n=$((n + 1))
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: FRIDAY browser CDP did not become reachable at $version_url after $attempts attempts." >&2
  systemctl --user --no-pager --full status friday-computer-browser.service >&2 2>/dev/null || true
  exit 1
fi

printf 'PASS: native X11 virtual desktops and loopback browser CDP are healthy.\n'
printf 'AGENT_DESKTOPS=%s\n' "$desktop_indexes"
printf 'CDP=%s\n' "$version_url"
printf 'PRESENTATION=native-x11\n'
