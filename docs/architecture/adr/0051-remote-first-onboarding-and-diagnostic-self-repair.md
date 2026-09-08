# ADR 0051: Remote-first onboarding and diagnostic self-repair

## Status

Accepted for v1.0.3.

## Context

FRIDAY already has a local onboarding CLI, trusted communication channels, a cheap routing model, typed System actions, protected credential capture, Observability, Doctor, and an isolated verified self-improvement pipeline. Requiring a full main reasoning model and every optional local feature before the runtime can start makes remote/headless administration unnecessarily difficult. Conversely, exposing a generic remote shell or unrestricted sudo in order to finish setup would collapse important security boundaries.

The desired operator experience is:

1. perform a small mandatory bootstrap locally;
2. pair at least one exact trusted operator channel;
3. choose whether FRIDAY may use a narrowly approved privilege broker or no privileged operations;
4. continue optional onboarding and routine administration from the trusted channel; and
5. when FRIDAY itself fails, allow the operator to ask for bounded diagnosis and, separately, approve a verified self-repair.

## Decision

### Local onboarding is retained

The existing terminal onboarding remains a supported surface. First-run `friday setup` adds two modes:

- **Quick** performs only the mandatory local block and then hands optional onboarding to the paired trusted channel.
- **Custom** performs the same mandatory block first, then offers the existing terminal setup areas as optional/skippable steps.

The mandatory block is never remote-skippable: routing model/credential, at least one paired trusted operator channel, and host privilege policy.

### Router-only bootstrap is a first-class runtime state

Runtime Settings may omit the main reasoning model but must always resolve a routing model pair. Legacy main-only v1.0.2 settings remain valid by deriving routing from the main pair. System administration uses the System model when explicitly configured, otherwise the routing model, otherwise the main model. Scheduler parsing similarly falls back to the routing model. The boundary is ownership-based rather than difficulty-based: System may operate F.R.I.D.A.Y itself, Scheduler may manage bounded concrete schedules, and every ordinary user objective (including one-off `transient:utility` work) remains Agent-owned and requires the main reasoning model. Refinement, Autonomy and self-improvement reasoning also require the main model.

A System action result has three presentation modes. `raw` returns the validated typed result directly. `present` may call the System/routing model again under a separate no-new-reasoning presenter prompt to make bounded control-plane output readable. `analyze` is reserved for substantive causal/diagnostic interpretation and therefore requires the main reasoning model.

### Host privilege is independent and fail-closed

Agent permission (`ask|auto|full`) and host privilege (`broker|none`) are separate settings. Host privilege is selected only from the local host: first-run onboarding requires an explicit choice, and later changes use the local `friday setup privileges [broker|none]` command. `none` forbids FRIDAY from invoking sudo. `broker` permits only fixed root-owned operations exposed by the restricted helper; the capability re-checks the policy before `sudo -n`. No remote flow captures a sudo password, exposes an arbitrary root shell, or installs `NOPASSWD: ALL`.

### Remote onboarding reuses owning plugin actions

Remote onboarding is persistent state, not a parallel command framework. `onboarding.continue` reports pending steps and routes the operator to typed actions owned by Runtime Settings, Channels, Voice, Execution, Sandbox, MCP and Skills, with Host Privileges used only for narrowly allowlisted sudo operations. Main-model setup has a conversational typed action that prompts for provider/model and uses protected API-key capture or supported OAuth/device-code flows when required. Successful optional setup actions advance onboarding state themselves. Channel credentials use protected capture directly into Vault. Adding a configured channel does not automatically trust a new sender; trust remains a separate Permissions operation.

### Doctor is one canonical collector; diagnostics add bounded FRIDAY-owned evidence

Local `friday doctor` and trusted-channel `diagnostics.doctor` call the same canonical read-only collector, so the channel is not a reduced health surface. The collector covers host installation, configuration, security, tooling and recovery checks as well as Voice, channels, Vault metadata, sandbox, backups, crashes and disk; only CLI/channel formatting differs. `diagnostics.review` composes that Doctor result with public plugin status plus bounded redacted Observability logs, failed spans, private setup/provisioning outcomes and crash records. It does not crawl arbitrary host logs or expose Vault plaintext. Provisioning subprocesses retain only a bounded recent failure tail so actionable resolver/build errors survive after the terminal command exits.

### Self-repair has a second authorization boundary

Router-only mode may run Doctor and diagnostic review. Source repair requires a configured main reasoning model. `self-improvement.repair-from-diagnostics` first gathers read-only evidence and reports its scope, then requires a separate explicit trusted-channel approval for source mutation even if normal agent permission mode is `full`. It reuses the existing isolated worktree/evaluation/promotion/handoff pipeline; failed candidates are not promoted, and the originating channel request is durably resumed only on a verified successor.

## Consequences

- A minimal install can become remotely manageable without pretending that the router is a full reasoning model.
- Existing local setup remains available and no optional feature becomes mandatory.
- Routine administration becomes channel-native while secrets and privilege remain behind dedicated boundaries.
- Diagnostic self-repair gets useful evidence without granting unrestricted filesystem/log access.
- Some conversational work intentionally remains unavailable in router-only mode until a main model is configured.
- Operations requiring new local sudo authentication still require access to the FRIDAY host terminal.
