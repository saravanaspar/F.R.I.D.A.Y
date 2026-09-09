# Remote-first onboarding and diagnostics

F.R.I.D.A.Y v1.0.3 keeps the complete local setup surface while making the first local session deliberately small enough to establish a trusted remote administration path.

## Quick versus Custom

`friday setup` offers two first-run modes.

**Quick setup** performs only the mandatory local block:

1. configure and verify the routing/system model;
2. configure at least one ingress channel and explicitly pair one exact sender as operator; and
3. select the host privilege policy: `broker` or `none`.

It then stops. Start F.R.I.D.A.Y and send `continue setup` from the paired channel.

**Custom setup** performs the same mandatory block first, then offers the existing terminal configuration areas as optional steps. Skipping an optional step does not disable the local command; it can be configured later locally or through the trusted channel.

Persistent progress lives in private `FRIDAY_HOME/onboarding/state.json`. Mandatory steps cannot be marked skipped. Optional steps may be `pending`, `complete`, or `skipped`; successful owning setup actions record `complete`, while the generic remote state action may only skip a step or reset it to pending.

## Router-only bootstrap

The routing model is mandatory; the main reasoning model is not. In router-only mode F.R.I.D.A.Y can route deterministic control-plane requests to typed actions such as onboarding status, Doctor, runtime settings, Voice, sandbox, MCP and Skills, and can parse bounded concrete schedules. Routing is classified by ownership rather than difficulty: System operates F.R.I.D.A.Y itself, Scheduler manages concrete schedules, and every other user objective goes to an Agent/main-model destination even when it is short or simple. `transient:utility` is still a main-model Agent path, not permission for the router to answer the user. Requests that require ordinary Agent work therefore receive an explicit message to configure the main model instead of silently using the router as a full reasoning model.

Legacy v1.0.2 installations that stored only a main model remain valid. v1.0.3 derives the routing model from that main model until a dedicated router is selected.

## System result presentation

A typed System action result may be returned directly. When a control-plane result
needs a friendlier channel rendering, F.R.I.D.A.Y may call the same configured
System/routing model again with a separate bounded presenter prompt that forbids
new reasoning, tool use and invented findings. When the operator asks for causal
analysis or non-obvious interpretation of the returned evidence, presentation is
upgraded to the main reasoning model instead. This keeps router reuse efficient
without turning it into an Agent substitute.

## Host privilege boundary

Host privilege is independent from Agent permission mode.

- `none`: F.R.I.D.A.Y never invokes sudo. If a feature requires a root-owned host dependency, it returns the exact manual command to run on the host.
- `broker`: the local bootstrap installs the existing root-owned `/usr/local/libexec/friday-privileged` helper and exact sudoers rule. Runtime/channel operations may use only an allowlisted helper operation through `sudo -n`.

There is no remote sudo-password prompt, arbitrary `sudo <generated command>`, root shell, or `NOPASSWD: ALL`. The privilege policy itself is **local-only**: the mandatory first-run bootstrap requires the choice, and it can later be changed only from the host terminal with `friday setup privileges broker` or `friday setup privileges none`.

## Trusted-channel administration

After bootstrap, system actions can manage non-secret runtime settings, additional channel configuration, protected channel credentials, Voice, execution Python and the existing sandbox/MCP/Skills/self-repository surfaces. `onboarding.main-model.setup` provides a conversational main-model flow: provider/model selection uses trusted-channel prompts, and authentication can use protected API-key capture or a supported OAuth/device-code flow before runtime settings are updated. Successful Voice, execution-Python, sandbox, MCP and Skills actions automatically advance their onboarding step.

Additional channel configuration does not trust a sender automatically. Credentials are captured in a protected channel interaction and written directly to canonical Vault references. Trusting/revoking an identity remains a separate Permissions operation.

Voice supports hosted and local providers remotely. Hosted API keys use protected capture; local Chatterbox asks CPU versus NVIDIA GPU explicitly and never auto-selects CUDA. When host privilege mode is `none`, missing local dependencies are reported with a manual host command instead of invoking sudo.

## Doctor and diagnostic review

Trusted-channel `diagnostics.doctor` and local `friday doctor` use the same canonical read-only Doctor collector. They run the same installation, configuration, security, tooling, Voice/channel/Vault/sandbox, backup/recovery, crash and disk checks; only the formatter differs. Diagnostic review starts with that same Doctor result and adds a bounded set of F.R.I.D.A.Y-owned evidence:

- plugin/system status;
- persistent onboarding and non-secret runtime state;
- recent secret-redacted warn/error observability records;
- recent failed spans;
- private crash records; and
- private setup/provisioning outcome records from `FRIDAY_HOME/logs/setup.ndjson`.

It does not scrape arbitrary files, `/var/log`, unrestricted `journalctl`, or Vault secret values.

## Permission-gated self-repair

A router-only installation may review diagnostics but may not edit its own source. Diagnostic self-repair requires:

1. a configured main reasoning model;
2. an originating trusted operator channel;
3. bounded diagnostic evidence;
4. a second explicit operator approval for source mutation;
5. the configured canonical F.R.I.D.A.Y source checkout;
6. the existing isolated worktree and deterministic evaluation/security gates; and
7. verified promotion/handoff before the originating request is resumed.

A failed candidate is discarded and the active generation remains unchanged. The self-repair path does not bypass Permissions, sandboxing, evaluation, or lifecycle takeover safeguards.
