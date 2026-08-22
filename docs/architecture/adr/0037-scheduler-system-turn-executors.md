# ADR-0037: Scheduler and System Turn Executors

## Status

Accepted. References to Command Handler are historical; ADR-0038 removes it.

## Context

ADR-0036 introduced `turn.executor` so Turn Loop could dispatch execution
profiles without learning Scheduler or System policy. The initial Turn Loop
shipped only the persistent Agent/transient Utility executor. Routing could
therefore select the host-owned `scheduler/scheduler` and `system/system`
destinations, but those decisions failed closed because no concrete executor
owned either profile.

Putting either branch into Turn Loop would recreate a central application
coordinator. Making Scheduler import Channels would also violate Scheduler's
ownership rule: Scheduler owns WHEN work runs, not transport delivery. A System
executor that directly imports every control/status owner would similarly grow
into a god plugin.

## Decision

### Scheduler executor

The existing `scheduler` plugin contributes the `scheduler` `turn.executor`.
It uses a bounded, tool-free model call to translate natural language into one
of five host-validated operations: create, list, history, cancel, or remove.
Model output may select only an installed scheduled-action id or an existing
task id supplied by the host.

Scheduler defines the multi-provider `scheduler.action` contribution. A
scheduled action declares a stable id, description, JSON input shape, a
`prepare` function, optional host-owned permission metadata, and an execution
function. Scheduler persists every conversational scheduled action as the same
`friday.scheduled-action` task type containing only a versioned action id plus
the contributor-prepared JSON payload. When the task fires, Scheduler resolves
the action contribution dynamically and executes it under the trusted
`system:scheduler` principal.

Security-sensitive durable fields are bound by the contributor rather than by
model output. The first action is `channels.reminder`: Channels accepts only the
reminder text from the planner and binds channel/account/conversation/thread
from the originating trusted Turn. The model cannot invent a recipient.
Scheduler authorizes both the future contributed side effect and the Scheduler
state mutation before persisting a new task. Cancel/remove operations are also
`system-write` permission actions.

Scheduler still owns no channel transport. Channels owns delivery through its
trusted send service. Future plugins can contribute other delayed/recurring
work through `scheduler.action` without editing Scheduler or Turn Loop.

This ADR originally kept the Scheduler worker manually started. ADR-0038
supersedes that lifecycle detail: the default Scheduler plugin now starts its
worker through the Kernel graph-ready lifecycle after the complete graph is
active and registers reversible shutdown cleanup. Scheduler still owns the
worker; host bootstrap remains unaware of it.

### System executor

Add an ordinary declarative `system` plugin that contributes the `system`
`turn.executor`. It is an action selector/dispatcher, not a central subsystem
owner. A bounded, tool-free model call chooses only from host-supplied
`system.action` contributions and their declared input shapes. Unknown or
duplicate action ids fail closed.

Action owners retain implementation and permission metadata. The System
executor invokes `Permissions` before any action that declares a permission
request. The Permissions plugin contributes exact trusted-identity list/trust/
revoke actions; identity mutation continues through the existing trusted
Permissions API and therefore keeps Audit as the authoritative mutation ledger.

System-wide read status is also contribution-based. Plugins publish
`system.status` snapshots and the System plugin exposes two built-in actions:
`system.status`, which aggregates installed snapshots, and `system.actions`,
which lists the currently installed control surface. Audit, Observability,
Sandbox, Channels, Scheduler, Permissions, and Turn Loop publish bounded status
snapshots without System importing those implementations. Audit additionally
contributes ledger verification.

A configured plugin may therefore be contribution-only; it does not need to
provide a singleton service capability when its complete public role is a typed
multi-provider extension.

## Consequences

Routing selections for `scheduler` and `system` now have concrete executors
without changing Turn Loop. Turn Loop still contains no Scheduler/System branch.

Adding a new scheduled behavior requires contributing `scheduler.action`.
Adding a new FRIDAY control/configuration action requires contributing
`system.action`. Adding status requires contributing `system.status`. The owner
keeps validation, authorization metadata, secrets, transport, and side-effect
policy.

The first conversational scheduled action is a reminder to the originating
conversation. More advanced scheduled work, such as a future autonomous Agent
mission, can be added by its owning plugin as another scheduled action without
changing Scheduler.

System mutation is intentionally limited to installed explicit actions. The
System executor cannot invoke arbitrary CLI commands, Command Handler internals,
or arbitrary plugin methods.

## Alternatives rejected

### Hard-code scheduler/system branches in Turn Loop

Rejected because execution profiles are independently replaceable and ADR-0036
explicitly established `turn.executor` for this extension.

### Let Scheduler call Channels directly

Rejected because it couples time policy to transport and makes every future
scheduled action require Scheduler edits.

### Let System dispatch Command Handler commands

Rejected because command handlers are terminal-oriented, may print directly,
and would expose an overly broad stringly-typed control surface. System actions
must be typed, explicitly installed, and permission-aware.

### Make System import every plugin it controls

Rejected because that recreates a central application/god plugin. Owners
contribute actions/status instead.
