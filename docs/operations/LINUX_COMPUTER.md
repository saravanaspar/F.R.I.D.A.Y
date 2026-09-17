# Linux native desktop Computer provider

The built-in Linux visible Computer mode uses the user's **real X11 virtual desktops**. It does not require a second compositor, `HEADLESS-*` outputs, WayVNC, TigerVNC, or temporary KWin scripts.

```text
KDE/GNOME/Xfce/etc. X11 session
  Desktop 1: Human
    existing Brave/Chrome windows stay open
  Desktop 2: FRIDAY
    a separate FRIDAY-owned window in the same normal browser profile
```

The installed `friday` binary owns provisioning. A release user does not need the source checkout or `scripts/*.sh` to configure Computer.

## Supported desktop sessions

| Host session | Status | Notes |
| --- | --- | --- |
| KDE Plasma X11 | **Full architecture** | EWMH virtual desktops with `wmctrl`; no KWin scripting. Real-host verification remains required for each release candidate. |
| GNOME Xorg/X11 | **Conditional** | Works only when the current WM accepts EWMH desktop-count/switch operations. |
| Xfce, Cinnamon, MATE, LXQt, i3 and other EWMH X11 WMs | **Conditional** | Runtime-smoked through `wmctrl`. |
| KDE Plasma Wayland | **Unsupported** | Needs a future KDE/Wayland-native provider. |
| GNOME Wayland | **Unsupported** | Needs a future GNOME-native provider. |
| Other Wayland compositors | **Unsupported by this provider** | FRIDAY does not silently fall back to Sway/VNC. |

If the session is unsupported, setup fails clearly instead of pretending that a hidden screen is a visible desktop.

## Browser state: shared normal profile by default

The default mode is `shared`. FRIDAY detects Brave, Chrome, or Chromium and invokes the normal browser launcher with `--new-window`. Chromium-family browsers route that request to the existing browser process when the same normal profile is already running. The result is equivalent to the user choosing **New Window**:

- existing Human browser windows remain open;
- the FRIDAY-created window uses the same current normal profile;
- cookies and already-authenticated website sessions are therefore available immediately;
- FRIDAY marks only the window it created with an X11 ownership property;
- restart/cleanup closes only windows carrying FRIDAY's exact ownership marker;
- FRIDAY never broad-kills the user's browser to obtain control.

Shared mode uses AT-SPI accessibility for structure/semantic actions plus bounded X11 window/input operations. It deliberately does **not** expose a remote CDP endpoint or capture general screenshots. Protected/password/OTP/CAPTCHA controls are omitted/refused and require Human takeover.

Because shared mode intentionally uses the person's normal browser profile, a Computer task can act with the same already-authenticated website sessions as that person. This is powerful and should remain behind FRIDAY's Computer approvals and protected-input boundary.

### Explicit isolated fallback

`managed-cdp` is an opt-in fallback for sites/workflows that require FRIDAY's isolated CDP engine:

```bash
friday setup computer managed-cdp
```

That mode uses a separate FRIDAY-managed browser profile and loopback-only CDP. It does **not** copy or pretend to synchronize the Human profile. Logins in that isolated fallback are independent by design.

Return to the normal shared-profile behavior with:

```bash
friday setup computer shared
```

## Binary-owned setup

From the real Human X11 desktop session, after normal `friday setup`:

```bash
friday setup computer
friday doctor
```

The binary-owned setup:

- requires `XDG_SESSION_TYPE=x11` and a live `DISPLAY`;
- detects the system/default Brave, Chrome, or Chromium launcher, including supported Flatpak installations;
- checks `wmctrl`, `xdotool`, `xprop`, Python and AT-SPI prerequisites;
- when the operator selected FRIDAY's restricted privilege broker, installs only the fixed approved Computer dependency set if it is missing;
- creates/reuses the configured number of real host virtual desktops;
- persists Computer provider, browser launcher/mode, and Agent desktop indexes in FRIDAY's private runtime settings;
- removes retired Sway/headless/viewer artifacts from older releases;
- disables the managed browser systemd unit in normal shared mode;
- installs the bundled managed-browser unit only when `managed-cdp` was explicitly selected.

No source-tree `.sh` command is part of the release-user setup flow. `scripts/setup-linux-computer.sh` remains only as a developer compatibility wrapper that delegates straight back to `friday setup computer`.

To request more than one Agent desktop through the binary-owned setup flow:

```bash
friday setup computer shared 2
```

Browser detection is automatic. Setup intentionally does not inherit retired
`FRIDAY_COMPUTER_BROWSER_*` shell/systemd overrides from the old installer; those values
are removed during migration so an upgrade cannot stay pinned to a stale browser or
managed profile. Persisted Computer settings are authoritative at runtime.

## FRIDAY-owned window lifecycle

For each leased Agent desktop FRIDAY keeps at most one owned normal-profile browser window. The provider:

1. records the Human's current virtual desktop;
2. switches temporarily to the target Agent desktop;
3. asks the normal browser to create a new window;
4. identifies the newly created Chromium-family X11 window;
5. marks that exact window with `_FRIDAY_SCREEN_ID`;
6. restores the Human's previous desktop;
7. uses the marker for crash/restart recovery and safe cleanup.

A pre-existing Human window never receives that marker. Cleanup verifies the marker again immediately before closing a window; a stale or unowned window is dropped from FRIDAY state rather than closed.

## Approval/retry behavior

A routine visible Computer task requests one `computer.task.control` approval. That grant is scoped to the principal, the stable admitted turn or durable Session Job, the Computer node, and the target desktop. A durable retry of the **same** admitted Telegram message must not generate another routine control approval.

High-impact browser actions and protected credentials remain separately gated. Managed process cleanup uses Execution's run-scoped cleanup path so post-run cleanup cannot turn an otherwise successful Computer result into a failed channel delivery merely because the Agent async context has already unwound.

## Security boundary

Run FRIDAY and the browser as the ordinary desktop user, never root. Shared mode does not create CDP. The explicit `managed-cdp` fallback binds CDP to loopback only. Provider observations redact/omit protected values, OTPs, secrets, CAPTCHA/challenge content and sensitive URL parameters before model exposure. Protected input continues to require Human takeover.

The native provider does not inject KWin JavaScript. On X11 it uses standard EWMH/X11 operations to discover/create/switch virtual desktops and to own only the browser windows it created.

## Diagnostics

Normal release-user verification is binary-owned:

```bash
friday doctor
wmctrl -d
```

In normal shared mode, `friday-computer-browser.service` should be absent/inactive because the Human browser process owns the shared profile. In explicit managed-CDP mode only:

```bash
systemctl --user status friday-computer-browser.service
curl --fail --silent http://127.0.0.1:9222/json/version
```

Retired compatibility services from older releases should be absent/inactive after setup:

```bash
systemctl --user status friday-computer-headless.service || true
systemctl --user list-units 'friday-computer-share-*' --all --no-pager
```

For the release-candidate real-world acceptance order, use [`../REAL_WORLD_VERIFICATION_STATUS.md`](../REAL_WORLD_VERIFICATION_STATUS.md).
