# Linux / Raspberry Pi Computer provider (Phase 5)

Phase 5 extends the existing `computer` authority; it does not add another Agent, tool executor, scheduler, or durable state owner. The built-in `linux-sway` adapter under `plugins/computer/providers` discovers Sway outputs, treats the physical output as the Human screen and `HEADLESS-*` outputs as Agent screens, reports host resource pressure, owns one loopback-CDP Chromium profile, creates a separate Chromium window/target per Agent screen, and executes browser actions through the Phase 4 generation/lease checks.

The provider is capability-honest: CDP is the required browser baseline, while Playwright/AT-SPI and PipeWire/WebRTC integrations may be supplied by a host adapter when available. Host shell/edit/process/IPython operations delegate through the existing FRIDAY tool/execution authorities, and managed lifecycle actions are restricted to FRIDAY-owned services and browser state. No fallback silently pretends an unavailable accelerator exists.

## Security boundary

Run FRIDAY, Sway, and Chromium as the ordinary user, never root. CDP is restricted to loopback HTTP; the provider rejects a non-loopback `FRIDAY_COMPUTER_CDP_URL`. Chromium uses a dedicated shared FRIDAY profile, so Human and Agent windows share the FRIDAY browser login state without locking the person's unrelated Chrome/Chromium profile.

The provider does not return raw screenshot bytes and does not record human keystrokes. DOM observation removes all input values and protected/captcha-shaped nodes before it is returned. A second provider-side redaction pass removes password/OTP/token/PIN/CAPTCHA assignments and sensitive URL parameters/titles before the provider sets the mandatory observation-safety attestation. Typing into password/OTP/CAPTCHA/token-shaped targets is rejected, protected click targets are rejected, and key presses are blocked while a protected field owns focus; those interactions must use Phase 4 human takeover.

CDP actions use browser input primitives rather than page-script `element.click()` shortcuts: click and focus are driven with `Input.dispatchMouseEvent`, text uses `Input.insertText`, named keys carry their CDP key/code/virtual-key metadata, and navigation waits for a live document state before the provider re-observes the page. `FRIDAY_COMPUTER_BROWSER_ACTION_TIMEOUT_MS` can raise the default five-second settle timeout up to 60 seconds for unusually slow local/browser environments.

## Host packages

On Debian-family Linux or Raspberry Pi OS, install Sway and Chromium before enabling the provider. Package names vary by distribution.

Ubuntu/Kubuntu 26.04 uses the `chromium-browser` transitional package, which launches the Chromium Snap:

```bash
sudo apt update
sudo apt install sway chromium-browser pipewire wireplumber
```

On Debian/Raspberry Pi OS, the browser package is commonly `chromium`:

```bash
sudo apt update
sudo apt install sway chromium pipewire wireplumber
```

The setup helper auto-detects `chromium`, `chromium-browser`, `google-chrome-stable`, or `google-chrome`. When Ubuntu's Chromium Snap is detected, the default FRIDAY browser profile is placed under `~/snap/chromium/common/friday-computer-profile`, because strict Snap confinement does not grant arbitrary access to hidden directories such as `~/.friday`.

## Kubuntu/KDE compatibility mode

Kubuntu normally keeps Plasma/KWin as the Human desktop and runs a separate headless Sway compositor for Agent screens. From the FRIDAY repository run:

```bash
scripts/setup-linux-computer.sh compatibility
```

The helper is user-scoped and does not invoke `sudo`. It:

- installs the checked-in systemd/Sway files beneath `~/.config`;
- writes `~/.config/environment.d/60-friday-computer.conf`;
- publishes the same environment to the current systemd user manager;
- chooses a Chromium launcher/profile compatible with Ubuntu Snap packaging;
- enables and starts `friday-computer-headless.service`.

If it reports a missing host package, install that package manually and rerun the helper.

The compatibility compositor intentionally has no Human output inside Sway; the person's normal KDE desktop remains separate. Human takeover of the same physical managed Sway screen therefore remains a managed-session feature.

## Managed Sway session

Managed mode is the target for exact Human + Agent shared-screen behavior. Install the deployment files without replacing the current desktop automatically:

```bash
scripts/setup-linux-computer.sh managed
```

Then start Sway as the person's desktop compositor:

```bash
sway -c ~/.config/friday/sway.conf
```

The config keeps the physical output as Human, creates two headless outputs by default, imports `SWAYSOCK`/`WAYLAND_DISPLAY` into the user manager, and restarts the shared Chromium supervisor. Set `FRIDAY_COMPUTER_AGENT_SCREENS` before running setup to change the count. `FRIDAY_COMPUTER_HUMAN_OUTPUT` can pin a physical output name; `FRIDAY_COMPUTER_AGENT_OUTPUTS` can explicitly classify additional Sway output names as Agent outputs.

## Manual deployment

If you do not want to use the helper, copy the files yourself:

```bash
mkdir -p ~/.config/systemd/user ~/.config/friday ~/.config/environment.d
cp deploy/systemd/friday-computer-browser.service ~/.config/systemd/user/
cp deploy/systemd/friday-computer-headless.service ~/.config/systemd/user/
cp deploy/sway/friday.conf ~/.config/friday/sway.conf
cp deploy/sway/friday-headless.conf ~/.config/friday/sway-headless.conf
systemctl --user daemon-reload
```

At minimum the systemd user manager must receive `FRIDAY_COMPUTER_PROVIDER=linux-sway`, `FRIDAY_COMPUTER_SESSION_MODE=compatibility` (for KDE/GNOME/XFCE compatibility mode), and the loopback CDP URL before FRIDAY starts. `scripts/setup-linux-computer.sh` is preferred because it makes those values persistent and handles Chromium launcher/profile differences.

## Real-host smoke check

Run the focused smoke check after setup:

```bash
scripts/smoke-linux-computer.sh
```

A healthy result is:

```text
PASS: Sway Agent output and loopback Chromium CDP are healthy.
```

The script deliberately does **not** rely on `SWAYSOCK` being present in the interactive shell. In compatibility mode, the headless Sway process publishes its socket to the systemd user manager; the smoke helper reads it there and falls back to discovering the newest live Sway IPC socket under `XDG_RUNTIME_DIR`. Startup is readiness-based rather than process-state-based: after a compositor/browser restart it retries the Sway output probe and Chromium `json/version` endpoint for up to 60 quarter-second attempts by default, so a newly `active` systemd service is not mistaken for a ready browser. Set `FRIDAY_COMPUTER_SMOKE_ATTEMPTS` (1-600) only when a slower host needs a larger or smaller bounded window.

For manual inspection use:

```bash
systemctl --user status friday-computer-headless.service
systemctl --user status friday-computer-browser.service
systemctl --user show-environment | grep -E '^(SWAYSOCK|WAYLAND_DISPLAY|FRIDAY_COMPUTER_)='
curl --fail --silent http://127.0.0.1:9222/json/version
```

A bare `swaymsg -t get_outputs -r` from an existing KDE terminal can fail with `Unable to retrieve socket path` even when compatibility-mode Sway is healthy, because environment changes made inside the headless compositor cannot be injected back into an already-running shell. Use `scripts/smoke-linux-computer.sh` or pass the socket explicitly with `swaymsg -s /path/to/sway-ipc.sock ...`.

## Real Chromium action conformance

After the host smoke passes, run the provider against the real shared Chromium instance:

```bash
npx tsx scripts/conformance-linux-computer.ts
```

The conformance runner imports only the Computer-related variables published by the systemd user manager, starts a loopback-only synthetic page, and drives the real provider through navigation, CDP mouse click, non-secret text input, an Enter key press, click navigation, provider observation redaction, and DOM-discovered password-field refusal. It never submits a real credential or reaches an external website.

A healthy result ends with:

```text
PASS: real Chromium CDP navigate/click/type/press and provider safety conformance are healthy.
```

If this fails while `scripts/smoke-linux-computer.sh` passes, inspect the error as a browser-action/provider problem rather than a deployment/socket problem.

The canonical Doctor surface remains useful after the host smoke passes:

```bash
FRIDAY_COMPUTER_PROVIDER=linux-sway npm run friday -- doctor
```

When running Doctor manually from a shell that predates setup, remember that the shell may not contain the new `FRIDAY_COMPUTER_*` variables yet. A new login session will receive `~/.config/environment.d/60-friday-computer.conf`; the long-running `friday` user service receives the variables directly from the user manager without requiring a logout.

## Troubleshooting

If the smoke check fails, inspect the user journal before changing provider code:

```bash
journalctl --user -u friday-computer-headless.service -n 100 --no-pager
journalctl --user -u friday-computer-browser.service -n 100 --no-pager
```

`Chromium CDP browser supervisor is unavailable on loopback` means the browser process is not listening on the configured loopback port. On Ubuntu/Kubuntu, first verify `command -v chromium-browser` and `snap list chromium`. The checked-in browser unit no longer hard-codes a `chromium` executable; it auto-detects supported launchers and uses a Snap-writable profile when necessary.

`Sway session is unavailable: ... Unable to retrieve socket path` means either the headless service is not running or the caller did not know its socket. `scripts/smoke-linux-computer.sh` distinguishes those cases by checking the user-manager environment and runtime sockets directly.

If compatibility-mode journals show an Xwayland `/tmp/.X11-unix/X0` collision with KDE or `swaybg` warnings for `HEADLESS-*`, rerun `scripts/setup-linux-computer.sh compatibility` so the current checked-in headless config disables Xwayland and applies an explicit synthetic-output background. The browser unit also avoids shell parameter-expansion syntax that systemd can misinterpret as an environment-variable name.

## Raspberry Pi 4

Use Raspberry Pi OS 64-bit or another Debian-family 64-bit image, run all components directly on the host, and do not create a VM/container per Agent. A USB SSD is recommended for the browser profile and model workspace. The adapter is architecture-neutral TypeScript/Node code; tune Pi-specific resource thresholds and optional media accelerators to the hardware during deployment validation.

## Current Phase 5 boundary

Implemented so far:

- built-in opt-in `linux-sway` Computer adapter;
- Sway physical/headless output discovery and per-screen Chromium CDP target allocation;
- shared persistent FRIDAY Chromium profile;
- CPU/RAM/renderer admission telemetry;
- provider-side observation redaction and protected-input refusal;
- real CDP mouse/key browser input with action settle/readiness checks;
- provider-specific Computer Doctor details plus canonical `friday doctor` integration;
- managed-session and KDE/GNOME/XFCE compatibility deployment;
- idempotent user-scoped setup plus a real-host smoke command that discovers compatibility-mode Sway sockets;
- Ubuntu/Kubuntu Chromium Snap-aware launcher/profile handling.
- real-host Chromium action/safety conformance against a loopback-only synthetic page.

Phase 5 implementation is complete in the repository. Remaining work is host validation rather than a new core authority: run the smoke and real-Chromium conformance commands on the target Raspberry Pi 4, and enable optional Playwright/AT-SPI/PipeWire/WebRTC adapters when those host packages are installed. The mandatory CDP, redaction, lease/generation, execution delegation, run-scoped cleanup, deployment, and lifecycle paths are covered by the checked-in tests and scripts.
