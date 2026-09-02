# ADR 0048: Isolate the deployment workspace and keep mutable tooling outside immutable SEA bundles

## Status

Accepted.

## Context

FRIDAY stores protected global state under `FRIDAY_HOME` while model/tool execution needs a writable workspace. A service that starts with the user's home directory as its effective workspace can accidentally place Vault/Audit state inside the model-visible filesystem boundary and exposes unrelated user files. Single-executable builds also extract immutable runtime assets into build-specific bundle directories; installing mutable Python environments or WhatsApp dependencies inside those directories makes upgrades lose provisioning and causes rebuildable data to accumulate in backups.

## Decision

- `friday setup` persists a bounded non-secret `FRIDAY_WORKSPACE`. The default is the dedicated sibling directory `~/FRIDAY-workspace` when `FRIDAY_HOME=~/.friday`.
- The host runtime loads persisted non-secret settings and enters the validated workspace **before** acquiring runtime resources or activating plugins. `FRIDAY_WORKSPACE` and `FRIDAY_HOME` must not contain one another.
- Vault and Audit retain their strict state/workspace non-overlap checks; deployment must adapt to that invariant rather than weakening it.
- Mutable host tooling lives under stable `FRIDAY_HOME/tooling`, not under SEA extraction bundles. Execution Python is checked against its pinned dependency versions. WhatsApp setup copies the current bridge manifests/assets into stable tooling and the channel refuses stale tooling after a build changes those assets.
- SEA extraction directories remain immutable/rebuildable. The current bundle plus at most two previous bundles are retained; older bundles are garbage-collected.
- State backup excludes top-level `.runtime` and `tooling` directories because they are reproducible provisioning artifacts rather than durable user state.
- Doctor validates the effective persisted workspace, durable model/Voice credential metadata, stable optional tooling, and host prerequisites without reading secret plaintext or contacting providers.
- Linux release CI must start the packaged SEA from an unsafe bootstrap directory, require full runtime readiness, and verify clean termination.

## Consequences

FRIDAY no longer treats the process launch directory as authority for the model workspace. systemd, interactive launches, and self-improvement successors converge on the same persisted workspace. Binary upgrades preserve expensive mutable tooling when compatible and fail with a precise setup command when tooling becomes stale. Backups remain focused on durable state, and packaged-runtime failures that source-mode tests cannot reproduce become release-gated.
