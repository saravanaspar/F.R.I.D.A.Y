# Always-on FRIDAY

FRIDAY itself remains a foreground process. Host supervision belongs to the host
process manager so the runtime does not grow a second daemon/control plane.

## Linux: systemd user service (recommended)

FRIDAY's self-improvement lifecycle can briefly run a verified predecessor and
successor at the same time. The included unit requires **systemd 250 or newer**
and uses `ExitType=cgroup`: the service stays active while any FRIDAY process in
the unit cgroup is alive, so a successful handoff does not look like a stopped
service when the predecessor exits. `KillMode=control-group` keeps explicit
service stop bounded to the whole FRIDAY process family.

Install the standalone `friday` binary somewhere on the user's PATH, normally
`~/.local/bin/friday`, complete `friday setup`, then install the example unit:

```bash
systemd --version
mkdir -p ~/.config/systemd/user
cp deploy/systemd/friday.service ~/.config/systemd/user/friday.service
systemctl --user daemon-reload
systemctl --user enable --now friday
```

The example uses the user's home directory as its working directory. If FRIDAY
should work primarily in another workspace, create an override:

```bash
systemctl --user edit friday
```

```ini
[Service]
WorkingDirectory=/absolute/path/to/workspace
```

Then reload/restart:

```bash
systemctl --user daemon-reload
systemctl --user restart friday
journalctl --user -u friday -f
```

A user manager normally follows the user's login lifetime. On a headless machine
where FRIDAY should start at boot before login, an administrator can enable user
lingering once:

```bash
loginctl enable-linger "$USER"
```

FRIDAY receives SIGTERM on service stop and uses its normal bounded quiesce and
resource-cleanup path. `Restart=on-failure` restarts FRIDAY only after the entire
service cgroup is empty. `StartLimitIntervalSec=300` with `StartLimitBurst=10`
bounds a crash loop after ten starts in five minutes. Inspect `crashes.ndjson` and
the user journal before running `systemctl --user reset-failed friday` and starting
the service again. `systemctl stop` remains an explicit stop and is not restarted.

Fatal failures that reach FRIDAY's process-level handlers are also appended to
`~/.friday/logs/crashes.ndjson` with private permissions and secret redaction. A
hard SIGKILL or an OS failure that gives the process no execution opportunity may
only appear in the systemd journal, so use both the application crash log and
`journalctl --user -u friday` when diagnosing a restart.

Before a verified self-improvement/settings handoff, FRIDAY checks for other
active background session jobs and requires explicit approval to pause them. The
successor reloads the last durable transcripts and persisted original requests
and publishes resume turns after takeover. Recorded transcript/tool output is
preserved; model-internal thinking that had not been recorded is not recoverable.

## PM2

Do not run `pm2 start friday` with autorestart yet. FRIDAY intentionally spawns a
detached verified successor during self-improvement. PM2 tracks the original main
process and may start another copy when the predecessor exits, racing the
successor that FRIDAY already launched.

A future PM2 adapter should stay alive as the PM2-owned process and follow the
FRIDAY runtime-lease/handoff protocol. Until that adapter exists, systemd's
cgroup-aware service mode is the supported always-on Linux path.

## Containers

A container image is not the default FRIDAY deployment boundary. FRIDAY already
uses rootless Podman as the isolation boundary for model-generated shell work.
Putting the whole host inside another container introduces nested-container,
mount, networking, credential, and lifecycle complexity and can weaken the clear
ownership boundary between FRIDAY and its sandboxes.

A container deployment can be added for a specific platform later, but it should
be designed explicitly around either a host Podman socket or a different sandbox
backend rather than casually running privileged Docker-in-Docker.
