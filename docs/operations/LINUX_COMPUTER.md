# Linux native desktop Computer provider

The built-in Linux visible Computer mode uses the user's **real X11 virtual desktops**. It does not require a second compositor, `HEADLESS-*` outputs, WayVNC, TigerVNC, or temporary KWin scripts.

```text
KDE/GNOME/Xfce/etc. X11 session
  Desktop 1: Human
  Desktop 2: FRIDAY
    Brave/Chrome window directly on that desktop
```

The provider reuses the existing hardened Computer/CDP engine for semantic browser inspection, stable observation refs, bounded visual probes, protected-input refusal, media status, and browser target reuse. Only the desktop discovery/presentation layer is native X11.

## Supported desktop sessions

| Host session | Status | Notes |
| --- | --- | --- |
| KDE Plasma X11 | **Full** | Tested architecture: EWMH virtual desktops with `wmctrl`; no KWin scripting. |
| GNOME Xorg/X11 | **Conditional** | Works only when the current WM accepts EWMH desktop-count/switch operations. |
| Xfce, Cinnamon, MATE, LXQt, i3 and other EWMH X11 WMs | **Conditional** | Runtime-smoked through `wmctrl`. |
| KDE Plasma Wayland | **Unsupported** | Needs a future KDE/Wayland-native provider. |
| GNOME Wayland | **Unsupported** | Needs a future GNOME-native provider. |
| Other Wayland compositors | **Unsupported by this provider** | FRIDAY does not silently fall back to Sway/VNC. |

If the session is unsupported, setup fails clearly instead of pretending that a hidden screen is a visible desktop.

## Browser state

FRIDAY launches the user's chosen Chromium-family browser (Brave, Chrome, or Chromium) with one **dedicated persistent FRIDAY browser profile**. The profile is shared by every FRIDAY virtual desktop and survives FRIDAY/browser restarts.

You sign into this FRIDAY browser profile **once**. You do not sign in again when an Agent opens another desktop or starts another task.

The profile is deliberately separate from an already-running Human Chrome/Brave user-data directory. Chromium-family browsers lock an active profile and opening the same live profile from a second CDP-controlled process risks corruption. The setup helper prefers the OS default browser; set `FRIDAY_COMPUTER_BROWSER_BIN` to override it, for example:

```bash
FRIDAY_COMPUTER_BROWSER_BIN=google-chrome-stable scripts/setup-linux-computer.sh native
```

or:

```bash
FRIDAY_COMPUTER_BROWSER_BIN=brave-browser-stable scripts/setup-linux-computer.sh native
```

The default profile directory is:

```text
${FRIDAY_HOME:-$HOME/.friday}/computer/browser-profile
```

## Install

Run setup from the real Human X11 desktop session:

```bash
sudo apt install wmctrl curl
scripts/setup-linux-computer.sh native
scripts/smoke-linux-computer.sh
```

The helper:

- requires `XDG_SESSION_TYPE=x11` and a live `DISPLAY`;
- creates/reuses the configured number of real host virtual desktops;
- writes `FRIDAY_COMPUTER_PROVIDER=linux-x11` and the Agent desktop indexes;
- prefers the default Brave/Chrome/Chromium launcher and creates one persistent FRIDAY profile;
- installs/restarts only `friday-computer-browser.service`;
- disables/removes the old `friday-computer-headless.service` deployment;
- stops old `friday-computer-share-*` VNC viewer units;
- removes previously installed FRIDAY hidden-compositor configuration files from older releases.

The setup never broad-kills the user's normal browser, KDE, or unrelated applications.

Set the number of FRIDAY desktops before setup if more than one concurrent Agent desktop is desired:

```bash
FRIDAY_COMPUTER_AGENT_SCREENS=2 scripts/setup-linux-computer.sh native
```

All of those desktops still share the same persistent FRIDAY browser profile.

## Approval/retry behavior

A routine visible Computer task requests one `computer.task.control` approval. That grant is scoped to the principal, the stable admitted turn or durable Session Job, the Computer node, and the target desktop. If Telegram durable delivery retries the **same** admitted message, a new Agent run/screen lease does not generate another routine control approval.

High-impact browser actions and protected credentials remain separately gated.

Managed process cleanup uses Execution's run-scoped `closeRun(runId)` API, which remains valid after the Agent's async-local execution context has unwound. A successful browser action must not be converted into a failed channel delivery merely because post-run process cleanup happens after the Agent context closes.

## Browser target lifecycle

Normal navigation reuses one FRIDAY-owned browser target per Agent desktop. A new tab/window is created only when explicitly requested or when no healthy FRIDAY target exists. Stale FRIDAY-owned pages are pruned without killing the shared browser supervisor/profile.

Media observations preserve bounded audio/video state such as `playing`, `paused`, `currentTime`, `muted`, and `volume`, so a status question can distinguish a YouTube search page from actual playback.

## Security boundary

Run FRIDAY and the browser as the ordinary user, never root. CDP remains loopback-only. Provider observations redact secrets, passwords, OTPs, tokens, PINs, CAPTCHA/challenge content, sensitive URL parameters, and protected input values before model exposure. Protected input continues to require Human takeover.

The native provider does not inject KWin JavaScript. On X11 it uses standard EWMH operations (`wmctrl`) to discover/create/switch virtual desktops. To reduce KWin instability, FRIDAY creates a new browser window while the Agent desktop is active rather than moving an already-created window across Plasma desktops; it then restores the Human's previous desktop.

## Smoke and diagnostics

A healthy smoke result is:

```text
PASS: native X11 virtual desktops and loopback browser CDP are healthy.
AGENT_DESKTOPS=1
PRESENTATION=native-x11
```

Useful checks:

```bash
wmctrl -d
systemctl --user status friday-computer-browser.service
systemctl --user show-environment | grep -E '^(FRIDAY_COMPUTER_|DISPLAY|XAUTHORITY|XDG_SESSION_TYPE)='
curl --fail --silent http://127.0.0.1:9222/json/version
```

Retired compatibility services from older releases should be absent/inactive after setup:

```bash
systemctl --user status friday-computer-headless.service || true
systemctl --user list-units 'friday-computer-share-*' --all --no-pager
```

## Browser login bootstrap

On the first native FRIDAY browser task, switch to the FRIDAY virtual desktop and sign into the sites you want the Agent to use. That login persists in the FRIDAY profile for later tasks and for every FRIDAY virtual desktop. This is a one-time profile setup, not a per-desktop login requirement.
