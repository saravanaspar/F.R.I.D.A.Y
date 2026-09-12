#!/bin/sh
set -eu
umask 077

mode="${1:-compatibility}"
case "$mode" in
  compatibility|managed) ;;
  *)
    echo "usage: scripts/setup-linux-computer.sh [compatibility|managed]" >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    return 1
  fi
}

missing=0
for command in systemctl sway swaymsg curl; do
  if ! need_command "$command"; then
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "Install the missing host dependencies, then rerun this script." >&2
  exit 1
fi

browser_bin="${FRIDAY_CHROMIUM_BIN:-}"
if [ -n "$browser_bin" ]; then
  if ! command -v "$browser_bin" >/dev/null 2>&1; then
    echo "FRIDAY_CHROMIUM_BIN is not executable: $browser_bin" >&2
    exit 1
  fi
else
  for candidate in chromium chromium-browser google-chrome-stable google-chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      browser_bin="$candidate"
      break
    fi
  done
fi
if [ -z "$browser_bin" ]; then
  echo "Chromium/Chrome is not installed." >&2
  echo "On Ubuntu/Kubuntu install the supported Chromium launcher with: sudo apt install chromium-browser" >&2
  exit 1
fi

friday_home="${FRIDAY_HOME:-$HOME/.friday}"
profile_dir="${FRIDAY_COMPUTER_BROWSER_PROFILE_DIR:-}"
if [ -z "$profile_dir" ]; then
  browser_path=$(command -v "$browser_bin")
  if command -v snap >/dev/null 2>&1 \
    && snap list chromium >/dev/null 2>&1 \
    && { [ "$browser_bin" = "chromium" ] || [ "$browser_bin" = "chromium-browser" ] || [ "${browser_path#/snap/bin/}" != "$browser_path" ]; }; then
    profile_dir="$HOME/snap/chromium/common/friday-computer-profile"
  else
    profile_dir="$friday_home/computer/chromium-profile"
  fi
fi

agent_screens="${FRIDAY_COMPUTER_AGENT_SCREENS:-2}"
case "$agent_screens" in
  ''|*[!0-9]*)
    echo "FRIDAY_COMPUTER_AGENT_SCREENS must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "$agent_screens" -lt 1 ] || [ "$agent_screens" -gt 16 ]; then
  echo "FRIDAY_COMPUTER_AGENT_SCREENS must be between 1 and 16" >&2
  exit 1
fi

systemd_dir="$HOME/.config/systemd/user"
friday_config_dir="$HOME/.config/friday"
environment_dir="$HOME/.config/environment.d"
environment_file="$environment_dir/60-friday-computer.conf"

mkdir -p "$systemd_dir" "$friday_config_dir" "$environment_dir" "$profile_dir"
chmod 700 "$friday_config_dir" "$profile_dir"
cp "$repo_root/deploy/systemd/friday-computer-browser.service" "$systemd_dir/"
cp "$repo_root/deploy/systemd/friday-computer-headless.service" "$systemd_dir/"
cp "$repo_root/deploy/sway/friday.conf" "$friday_config_dir/sway.conf"
cp "$repo_root/deploy/sway/friday-headless.conf" "$friday_config_dir/sway-headless.conf"

cat > "$environment_file" <<ENV
FRIDAY_COMPUTER_PROVIDER=linux-sway
FRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/
FRIDAY_COMPUTER_CDP_PORT=9222
FRIDAY_COMPUTER_AGENT_SCREENS=$agent_screens
FRIDAY_COMPUTER_SESSION_MODE=$mode
FRIDAY_CHROMIUM_BIN=$browser_bin
FRIDAY_COMPUTER_BROWSER_PROFILE_DIR=$profile_dir
ENV
chmod 600 "$environment_file"

systemctl --user daemon-reload
systemctl --user set-environment \
  FRIDAY_COMPUTER_PROVIDER=linux-sway \
  FRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/ \
  FRIDAY_COMPUTER_CDP_PORT=9222 \
  "FRIDAY_COMPUTER_AGENT_SCREENS=$agent_screens" \
  "FRIDAY_COMPUTER_SESSION_MODE=$mode" \
  "FRIDAY_CHROMIUM_BIN=$browser_bin" \
  "FRIDAY_COMPUTER_BROWSER_PROFILE_DIR=$profile_dir"

if [ "$mode" = "compatibility" ]; then
  systemctl --user enable --now friday-computer-headless.service
  echo "Linux Computer compatibility mode is installed and started."
  echo "Run: scripts/smoke-linux-computer.sh"
else
  systemctl --user disable --now friday-computer-headless.service >/dev/null 2>&1 || true
  echo "Linux Computer managed-session files are installed."
  echo "Start Sway as your desktop compositor with: sway -c $friday_config_dir/sway.conf"
  echo "Then run: scripts/smoke-linux-computer.sh"
fi
