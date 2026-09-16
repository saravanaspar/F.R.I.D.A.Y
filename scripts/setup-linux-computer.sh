#!/bin/sh
set -eu
umask 077

mode="${1:-native}"
case "$mode" in
  native|native-x11) ;;
  *)
    echo "usage: scripts/setup-linux-computer.sh [native]" >&2
    echo "FRIDAY Linux Computer only supports native X11 virtual desktops in this build; retired hidden-compositor/viewer modes are not installed." >&2
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
for command in systemctl wmctrl curl xdg-settings pgrep; do
  if ! need_command "$command"; then missing=1; fi
done
if [ "$missing" -ne 0 ]; then
  echo "Install the missing host dependencies, then rerun this script." >&2
  echo "On Ubuntu/Kubuntu: sudo apt install wmctrl curl" >&2
  exit 1
fi

session_type="${XDG_SESSION_TYPE:-}"
if [ "$session_type" != "x11" ]; then
  echo "Native FRIDAY desktop control currently requires an X11 session; detected: ${session_type:-unknown}." >&2
  echo "No hidden-compositor/viewer fallback will be installed." >&2
  echo "KDE Plasma X11, GNOME Xorg, Xfce, Cinnamon, MATE and other EWMH/X11 desktops can be supported." >&2
  echo "KDE/GNOME Wayland need a future compositor-native provider." >&2
  exit 1
fi
if [ -z "${DISPLAY:-}" ]; then
  echo "Native FRIDAY desktop control requires DISPLAY in the active X11 session." >&2
  exit 1
fi

browser_bin="${FRIDAY_COMPUTER_BROWSER_BIN:-${FRIDAY_CHROMIUM_BIN:-}}"
if [ -n "$browser_bin" ]; then
  if ! command -v "$browser_bin" >/dev/null 2>&1; then
    echo "FRIDAY_COMPUTER_BROWSER_BIN is not executable: $browser_bin" >&2
    exit 1
  fi
else
  default_browser=$(xdg-settings get default-web-browser 2>/dev/null || true)
  candidates=""
  case "$default_browser" in
    *[Bb]rave*) candidates="brave-browser-stable brave-browser google-chrome-stable google-chrome chromium chromium-browser" ;;
    *[Cc]hrome*) candidates="google-chrome-stable google-chrome brave-browser-stable brave-browser chromium chromium-browser" ;;
    *[Cc]hromium*) candidates="chromium chromium-browser brave-browser-stable brave-browser google-chrome-stable google-chrome" ;;
    *) candidates="brave-browser-stable brave-browser google-chrome-stable google-chrome chromium chromium-browser" ;;
  esac
  for candidate in $candidates; do
    if command -v "$candidate" >/dev/null 2>&1; then
      browser_bin="$candidate"
      break
    fi
  done
fi
if [ -z "$browser_bin" ]; then
  echo "No supported Chromium-family browser was found (Brave, Chrome, or Chromium)." >&2
  exit 1
fi

friday_home="${FRIDAY_HOME:-$HOME/.friday}"
profile_dir="${FRIDAY_COMPUTER_BROWSER_PROFILE_DIR:-$friday_home/computer/browser-profile}"

browser_profile_source="${FRIDAY_COMPUTER_BROWSER_PROFILE_SOURCE_DIR:-}"
if [ -z "$browser_profile_source" ]; then
  browser_name=$(basename "$browser_bin")
  case "$browser_name" in
    brave*)
      for candidate in \
        "$HOME/.config/BraveSoftware/Brave-Browser" \
        "$HOME/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser" \
        "$HOME/snap/brave/current/.config/BraveSoftware/Brave-Browser"; do
        if [ -f "$candidate/Local State" ]; then browser_profile_source="$candidate"; break; fi
      done
      ;;
    google-chrome*|chrome*)
      if [ -f "$HOME/.config/google-chrome/Local State" ]; then
        browser_profile_source="$HOME/.config/google-chrome"
      fi
      ;;
    chromium*)
      for candidate in "$HOME/.config/chromium" "$HOME/snap/chromium/current/.config/chromium"; do
        if [ -f "$candidate/Local State" ]; then browser_profile_source="$candidate"; break; fi
      done
      ;;
  esac
fi

profile_seeded=0
if [ "$browser_profile_source" != "none" ] \
  && [ -n "$browser_profile_source" ] \
  && [ "$browser_profile_source" != "$profile_dir" ] \
  && [ -f "$browser_profile_source/Local State" ] \
  && [ ! -f "$profile_dir/Local State" ]; then
  # An earlier setup may already have the managed browser running. Stop that
  # writer before deciding whether the Human source profile itself is idle.
  systemctl --user stop friday-computer-browser.service >/dev/null 2>&1 || true
  source_profile_in_use=0
  case "$(basename "$browser_bin")" in
    brave*)
      for process in brave brave-browser brave-browser-stable; do
        if pgrep -x "$process" >/dev/null 2>&1; then source_profile_in_use=1; break; fi
      done
      ;;
    google-chrome*|chrome*)
      for process in chrome google-chrome google-chrome-stable; do
        if pgrep -x "$process" >/dev/null 2>&1; then source_profile_in_use=1; break; fi
      done
      ;;
    chromium*)
      for process in chromium chromium-browser; do
        if pgrep -x "$process" >/dev/null 2>&1; then source_profile_in_use=1; break; fi
      done
      ;;
  esac
  if [ "$source_profile_in_use" -eq 1 ]; then
    echo "The existing browser profile is active; it was not copied while the browser is writing to it." >&2
    echo "Close the Human browser and rerun setup to seed the dedicated FRIDAY profile safely." >&2
  else
  # The destination remains FRIDAY-owned and independent. Seeding copies the
  # user's existing state once; FRIDAY never launches a second writer against
  # the live Human profile. Singleton artifacts are deliberately not retained.
    mkdir -p "$profile_dir"
    chmod 700 "$profile_dir"
    cp -a "$browser_profile_source/." "$profile_dir/"
    rm -f "$profile_dir"/SingletonCookie "$profile_dir"/SingletonLock "$profile_dir"/SingletonSocket
    profile_seeded=1
  fi
fi

agent_screens="${FRIDAY_COMPUTER_AGENT_SCREENS:-1}"
case "$agent_screens" in
  ''|*[!0-9]*) echo "FRIDAY_COMPUTER_AGENT_SCREENS must be a positive integer" >&2; exit 1 ;;
esac
if [ "$agent_screens" -lt 1 ] || [ "$agent_screens" -gt 8 ]; then
  echo "FRIDAY_COMPUTER_AGENT_SCREENS must be between 1 and 8" >&2
  exit 1
fi

# Reuse the indexes from the existing native setup before falling back to
# names from older viewer-mode deployments. KDE commonly reports generic
# names such as "Desktop 1", so relying on the visible name alone would add
# two more desktops every time this script is rerun.
desktops=$(wmctrl -d)
current_count=$(printf '%s\n' "$desktops" | awk 'NF {n += 1} END {print n + 0}')
if [ "$current_count" -lt 1 ]; then
  echo "wmctrl did not report any X11 virtual desktops." >&2
  exit 1
fi

configured_indexes="${FRIDAY_COMPUTER_X11_AGENT_DESKTOPS:-}"
if [ -z "$configured_indexes" ] && command -v systemctl >/dev/null 2>&1; then
  configured_indexes=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^FRIDAY_COMPUTER_X11_AGENT_DESKTOPS=//p' | tail -n 1)
fi

agent_indexes=""
if [ -n "$configured_indexes" ]; then
  valid_configured=1
  configured_count=0
  old_ifs=$IFS
  IFS=,
  for index in $configured_indexes; do
    case "$index" in
      ''|*[!0-9]*) valid_configured=0; break ;;
    esac
    if ! printf '%s\n' "$desktops" | awk -v i="$index" '$1 == i {found=1} END {exit found ? 0 : 1}'; then
      valid_configured=0
      break
    fi
    configured_count=$((configured_count + 1))
  done
  IFS=$old_ifs
  if [ "$valid_configured" -eq 1 ] && [ "$configured_count" -eq "$agent_screens" ]; then
    agent_indexes="$configured_indexes"
  fi
fi

if [ -z "$agent_indexes" ]; then
  agent_indexes=$(printf '%s\n' "$desktops" | awk 'BEGIN{IGNORECASE=1} /FRIDAY/ {printf "%s%s", sep, $1; sep=","}' | cut -d, -f1-"$agent_screens")
fi
agent_found=0
if [ -n "$agent_indexes" ]; then
  agent_found=$(printf '%s' "$agent_indexes" | awk -F, '{print NF}')
fi
if [ "$agent_found" -lt "$agent_screens" ]; then
  needed=$((agent_screens - agent_found))
  new_count=$((current_count + needed))
  if ! wmctrl -n "$new_count"; then
    echo "The current X11 window manager refused to create FRIDAY virtual desktops." >&2
    exit 1
  fi
  # Wait for the EWMH desktop count to settle.
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    current_count=$(wmctrl -d | awk 'NF {n += 1} END {print n + 0}')
    [ "$current_count" -ge "$new_count" ] && break
    sleep 0.05
    attempts=$((attempts + 1))
  done
  if [ "$current_count" -lt "$new_count" ]; then
    echo "Virtual desktop creation did not settle to $new_count desktops." >&2
    exit 1
  fi
  next=$((new_count - needed))
  while [ "$next" -lt "$new_count" ]; do
    if [ -z "$agent_indexes" ]; then agent_indexes="$next"; else agent_indexes="$agent_indexes,$next"; fi
    next=$((next + 1))
  done
fi

systemd_dir="$HOME/.config/systemd/user"
friday_config_dir="$HOME/.config/friday"
environment_dir="$HOME/.config/environment.d"
environment_file="$environment_dir/60-friday-computer.conf"
mkdir -p "$systemd_dir" "$friday_config_dir" "$environment_dir" "$profile_dir"
chmod 700 "$friday_config_dir" "$profile_dir"

# Purge retired hidden-compositor/viewer deployment artifacts from older installs.
systemctl --user disable --now friday-computer-headless.service >/dev/null 2>&1 || true
systemctl --user stop 'friday-computer-share-*.service' >/dev/null 2>&1 || true
rm -f "$systemd_dir/friday-computer-headless.service"
rm -f "$friday_config_dir/sway.conf" "$friday_config_dir/sway-headless.conf"
cp "$repo_root/deploy/systemd/friday-computer-browser.service" "$systemd_dir/"

cat > "$environment_file" <<ENV
FRIDAY_COMPUTER_PROVIDER=linux-x11
FRIDAY_COMPUTER_SESSION_MODE=native-x11
FRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/
FRIDAY_COMPUTER_CDP_PORT=9222
FRIDAY_COMPUTER_AGENT_SCREENS=$agent_screens
FRIDAY_COMPUTER_X11_AGENT_DESKTOPS=$agent_indexes
FRIDAY_COMPUTER_BROWSER_BIN=$browser_bin
FRIDAY_COMPUTER_BROWSER_PROFILE_DIR=$profile_dir
DISPLAY=${DISPLAY:-}
XAUTHORITY=${XAUTHORITY:-}
XDG_SESSION_TYPE=x11
XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-unknown}
ENV
chmod 600 "$environment_file"

systemctl --user daemon-reload
systemctl --user set-environment \
  FRIDAY_COMPUTER_PROVIDER=linux-x11 \
  FRIDAY_COMPUTER_SESSION_MODE=native-x11 \
  FRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/ \
  FRIDAY_COMPUTER_CDP_PORT=9222 \
  "FRIDAY_COMPUTER_AGENT_SCREENS=$agent_screens" \
  "FRIDAY_COMPUTER_X11_AGENT_DESKTOPS=$agent_indexes" \
  "FRIDAY_COMPUTER_BROWSER_BIN=$browser_bin" \
  "FRIDAY_COMPUTER_BROWSER_PROFILE_DIR=$profile_dir" \
  "DISPLAY=${DISPLAY:-}" \
  "XAUTHORITY=${XAUTHORITY:-}" \
  XDG_SESSION_TYPE=x11 \
  "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-unknown}"

systemctl --user enable --now friday-computer-browser.service >/dev/null
systemctl --user restart friday-computer-browser.service

echo "Native X11 Computer is installed and started."
echo "Provider: linux-x11"
echo "Browser: $browser_bin"
echo "Persistent FRIDAY browser profile: $profile_dir"
if [ "$profile_seeded" -eq 1 ]; then
  echo "Seeded the FRIDAY browser profile from: $browser_profile_source"
fi
echo "FRIDAY virtual desktop indexes (zero-based): $agent_indexes"
echo "Retired hidden-compositor/viewer services and configs were removed; this installation uses native X11 desktops only."
echo "The dedicated FRIDAY profile persists across tasks and restarts; imported or newly saved logins, cookies, cache, extensions, and browser storage are reused."
echo "Run: scripts/smoke-linux-computer.sh"
