# F.R.I.D.A.Y Doctor

`friday doctor` is the local diagnostic surface for a F.R.I.D.A.Y installation. It is designed to answer three questions quickly:

1. **Can F.R.I.D.A.Y run safely right now?**
2. **Which optional capabilities are ready?**
3. **If something is wrong, what is the shortest safe next action?**

## Behavior

The default command is **read-only and non-interactive**:

```bash
friday doctor
```

It performs local checks only. It does not make outbound network requests and it does not read plaintext Vault secret values. It warns when the sandbox uses the non-default `FRIDAY_SANDBOX_NETWORK_MODE=unrestricted`; the secure default is `requested`, where egress remains off unless an action explicitly requests network and receives approval.

Deployment checks use the persisted effective workspace rather than the caller's current directory. Doctor fails health if the workspace overlaps `FRIDAY_HOME`, if a required model/Voice credential is not durable for unattended restarts, or if an enabled WhatsApp channel lacks its stable sidecar tooling/host Node runtime.

For automation:

```bash
friday doctor --json
```

For explicitly requested guided repair:

```bash
friday doctor --fix
```

`--fix` requires an interactive terminal. F.R.I.D.A.Y asks before each repair and only offers deterministic repairs it already knows how to perform safely, such as first-run setup, private home permissions, execution-Python provisioning, or building a missing sandbox image. It never silently installs system packages, changes credentials, opens channel access, changes the user's permission policy, deletes data, or repairs Vault state by guessing.

## Report sections

| Section | Examples |
| --- | --- |
| Installation | platform support, runtime mode, FRIDAY_HOME existence/privacy |
| Configuration | model/runtime settings, durable model credential, optional Voice credentials, ingress channels, canonical self-improvement checkout |
| Security | dedicated workspace/state isolation, permission mode, channel exposure, Vault metadata/key boundary, sandbox network policy |
| Tooling | Git, npm, source Node pin, stable execution-Python tooling, WhatsApp sidecar readiness, configured sandbox provider |
| Recovery | encrypted state backups, fatal crash records, free disk space |

Each check has one of four levels:

- `✓` healthy and ready;
- `·` informational/optional capability not required for core operation;
- `!` warning that deserves attention but does not block the core runtime;
- `✗` blocking condition that makes the installation unhealthy.

Every actionable non-healthy result includes a single-line `→` repair guide. The exit code is non-zero only when at least one blocking (`✗`) condition exists, so warnings and optional capabilities do not make service health probes fail.

## Repair policy

Doctor should prefer a precise existing F.R.I.D.A.Y command over prose, for example:

```text
✗ Ingress channels       none enabled
    → friday setup

· Execution Python       not provisioned
    → friday setup execution-python

! Permission mode        full
    → friday setup --permission ask

! State backups          none found
    → friday backup create --encrypt
```

When no safe universal command exists, Doctor gives one short operator action rather than trying to mutate the machine itself.

## Trusted-channel Doctor and diagnostics

After the mandatory local bootstrap has paired at least one trusted operator channel, v1.0.3 exposes the same canonical Doctor and failure review through typed System actions:

- `diagnostics.doctor` receives the exact read-only check set used by local `friday doctor` through the narrow host-owned `doctor.host` port, including installation, configuration, security, tooling, Voice/channel/Vault/sandbox, backup/recovery, crash and disk checks;
- CLI and trusted-channel Doctor format that one result differently, but neither surface has a reduced or misleading check set;
- `diagnostics.review` starts with the same Doctor result and adds bounded redacted FRIDAY-owned evidence from Observability, failed spans, fatal crash records, setup/provisioning outcomes, onboarding/runtime state, and public plugin status;
- follow-up repair requests route to the owning typed action (for example `execution.python.setup`, `sandbox.setup`, or `voice.setup`) rather than giving Diagnostics a generic shell;
- an explicit “diagnose and fix/evolve FRIDAY” request may use `self-improvement.repair-from-diagnostics`, but only when a main reasoning model is configured and the trusted operator separately approves source mutation.

The channel-facing Diagnostics plugin itself has no process-spawn, arbitrary terminal, repair, or sudo authority; it receives typed Doctor results from the host-owned read-only port. The channel surface does **not** expose an arbitrary terminal or sudo shell. Guided `friday doctor --fix` remains local/TTY-oriented, while remote repairs go through the same owning typed actions and permission/host-privilege boundaries. Channel diagnostics never read arbitrary `/var/log`, unrestricted `journalctl`, or Vault plaintext.
