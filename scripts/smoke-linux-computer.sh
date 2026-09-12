#!/bin/sh
set -eu

readiness_attempts="${FRIDAY_COMPUTER_SMOKE_ATTEMPTS:-60}"
case "$readiness_attempts" in
  ''|*[!0-9]*)
    echo "FAIL: FRIDAY_COMPUTER_SMOKE_ATTEMPTS must be a positive integer." >&2
    exit 2
    ;;
esac
if [ "$readiness_attempts" -lt 1 ] || [ "$readiness_attempts" -gt 600 ]; then
  echo "FAIL: FRIDAY_COMPUTER_SMOKE_ATTEMPTS must be between 1 and 600." >&2
  exit 2
fi

manager_environment=""
refresh_manager_environment() {
  manager_environment=""
  if command -v systemctl >/dev/null 2>&1; then
    manager_environment=$(systemctl --user show-environment 2>/dev/null || true)
  fi
}

manager_value() {
  key="$1"
  printf '%s\n' "$manager_environment" | sed -n "s/^${key}=//p" | tail -n 1
}

discover_sway_socket() {
  for preferred in "${FRIDAY_COMPUTER_SWAYSOCK:-}" "${SWAYSOCK:-}"; do
    if [ -n "$preferred" ] && [ -S "$preferred" ]; then
      printf '%s\n' "$preferred"
      return 0
    fi
  done

  refresh_manager_environment
  manager_socket=$(manager_value SWAYSOCK)
  if [ -n "$manager_socket" ] && [ -S "$manager_socket" ]; then
    printf '%s\n' "$manager_socket"
    return 0
  fi

  runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  newest=""
  for candidate in "$runtime_dir"/sway-ipc.*.sock; do
    [ -S "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
      newest="$candidate"
    fi
  done
  if [ -n "$newest" ]; then
    printf '%s\n' "$newest"
    return 0
  fi
  return 1
}

socket=""
outputs=""
attempt=1
while [ "$attempt" -le "$readiness_attempts" ]; do
  socket=$(discover_sway_socket || true)
  if [ -n "$socket" ]; then
    outputs=$(swaymsg -s "$socket" -t get_outputs -r 2>/dev/null || true)
    if printf '%s\n' "$outputs" | grep -q 'HEADLESS-[0-9]'; then
      break
    fi
  fi
  if [ "$attempt" -lt "$readiness_attempts" ]; then
    sleep 0.25
  fi
  attempt=$((attempt + 1))
done

if [ -z "$socket" ] || [ ! -S "$socket" ]; then
  echo "FAIL: no live Sway IPC socket was found after $readiness_attempts readiness attempts." >&2
  echo "For KDE/GNOME/XFCE run: systemctl --user enable --now friday-computer-headless.service" >&2
  exit 1
fi
if ! printf '%s\n' "$outputs" | grep -q 'HEADLESS-[0-9]'; then
  echo "FAIL: Sway is running but no HEADLESS-* Agent output became ready after $readiness_attempts attempts." >&2
  printf '%s\n' "$outputs" >&2
  exit 1
fi

refresh_manager_environment
cdp_url="${FRIDAY_COMPUTER_CDP_URL:-}"
if [ -z "$cdp_url" ]; then
  cdp_url=$(manager_value FRIDAY_COMPUTER_CDP_URL)
fi
cdp_url="${cdp_url:-http://127.0.0.1:9222/}"
case "$cdp_url" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *)
    echo "FAIL: CDP must remain loopback-only: $cdp_url" >&2
    exit 1
    ;;
esac

case "$cdp_url" in
  */) version_url="${cdp_url}json/version" ;;
  *) version_url="$cdp_url/json/version" ;;
esac

attempt=1
cdp_ready=0
while [ "$attempt" -le "$readiness_attempts" ]; do
  if curl --connect-timeout 1 --max-time 2 --fail --silent "$version_url" >/dev/null 2>&1; then
    cdp_ready=1
    break
  fi
  if [ "$attempt" -lt "$readiness_attempts" ]; then
    sleep 0.25
  fi
  attempt=$((attempt + 1))
done

if [ "$cdp_ready" -ne 1 ]; then
  echo "FAIL: Chromium CDP did not become reachable at $version_url after $readiness_attempts readiness attempts." >&2
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user --no-pager --full status friday-computer-browser.service >&2 || true
  fi
  exit 1
fi

printf 'PASS: Sway Agent output and loopback Chromium CDP are healthy.\n'
printf 'SWAYSOCK=%s\n' "$socket"
printf 'CDP=%s\n' "$version_url"
