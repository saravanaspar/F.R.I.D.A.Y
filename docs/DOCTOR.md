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

It performs local checks only. It does not make outbound network requests and it does not read plaintext Vault secret values.

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
| Tooling | Git, npm, source Node pin, stable execution-Python tooling, WhatsApp sidecar readiness, rootless Podman sandbox |
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
