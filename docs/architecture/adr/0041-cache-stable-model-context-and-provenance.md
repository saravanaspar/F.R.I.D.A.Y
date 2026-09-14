# ADR-0041: Cache-Stable Model Context and Provider Runtime Provenance

## Status

Accepted.

## Context

FRIDAY combines stable instructions/tools/skills with volatile Memory and recent
turn context. Rebuilding the system prefix whenever Memory or runtime state
changes harms prompt-prefix reuse on providers that support caching. At the same
time, cache optimization must not blur where instructions came from: a stable
byte sequence is not automatically a trusted instruction, and external content
must never gain authority merely because it survives compaction or appears in a
system-prompt envelope.

The model/provider subsystem also has upstream open-source lineage that should be
documented precisely rather than described as either wholly copied from
OpenCode or wholly original.

## Decision

Prompt composition uses typed provenance and cache scope. Every host/plugin
prompt contribution declares its authority independently from whether it is
stable or volatile. `prompts` orders/renders those records but does not decide
or upgrade their trust.

Keep the following material eligible for the stable system prefix when present:

- FRIDAY operating doctrine (`core-policy`);
- stable capability doctrine (`host-policy`);
- persistent Agent Profile, Persona, and explicit custom user instructions
  (`user-config`);
- user-installed/explicit-path Skills accepted by the Skills subsystem's bounded
  static trust scan (`user-config`);
- project-discovered Skills accepted by that same trust scan plus the
  host-selected, bounded active-workspace `AGENTS.md` (`project-guidance`).

Keep current/run-specific material outside the stable prefix:

- working directory and conversation-log location;
- recursive-agent depth and child identity;
- canonical current instant, configured IANA timezone, and local wall-clock;
- current Project workspace/target state;
- current Computer node/screen/control generation and model image-input
  availability;
- current conditional-hook counters/state;
- other request/session facts that can change independently of durable user
  configuration.

Current Memory is injected ephemerally at model-call time into the first
host-prepended runtime-context block on the latest user turn. Memory content is
escaped as data, is not persisted as user transcript, and does not rewrite the
stable system prompt on every turn. User-authored later blocks with the same
name are not trusted as host context.

### External-content provenance

Tool results, shell output, source/repository files other than explicitly
classified project guidance, webpages, Computer observations, OCR/vision text,
MCP/API responses, logs, emails, attachments, retrieved Memory text, and quoted
conversations are data. Imperative or authoritative-looking text inside them is
not a new FRIDAY instruction.

Compaction preserves this distinction. Direct user messages are the only
conversation records that may establish durable user goals, constraints, or
preferences. Assistant output/tool calls are evidence of prior work; tool/web/
file/UI results remain untrusted data. Hidden/private assistant thinking is not
serialized into compaction input. Host-generated compaction/branch summaries are
marked as historical records when reintroduced and cannot upgrade embedded
external instructions into fresh user authority.

Keep the existing provider cache primitives: stable session IDs, provider cache
retention options/markers, and normalized cache-read/cache-write token
accounting. Observability records input/output/cache-read/cache-write token
counters and model cost where provider usage reports them.

### Provenance

FRIDAY's Plugin Kernel, Turn Loop, Routing/Sessions/Memory composition, security
boundaries and system-action architecture are project-specific integration work.
The low-level model/provider transport has substantial lineage from Mario
Zechner's Pi AI provider design/code family; the repository's MIT LICENSE already
retains the Mario Zechner copyright notice. Pi's current public repository is
MIT licensed and exposes the same family of session-aware cache-retention and
provider abstractions.

OpenCode is used as a design/reference comparison, not as the source of FRIDAY's
Plugin Kernel or Turn Loop. Its current MIT-licensed LLM package documents
protocol-aware automatic cache placement over stable tools/system/latest-user
boundaries and normalized cache usage. FRIDAY adopts the compatible design
principle of keeping volatile contextual data out of the stable system prefix,
but does not replace the existing provider stack with OpenCode's LLM package.

## Consequences

Continual Memory and runtime facts may change every turn without needlessly
changing the stable system prefix. Provider caching remains protocol-owned,
measurable and optional rather than a home-grown response cache. More
importantly, authority and cacheability are independent: project/user/runtime/
untrusted content cannot become host policy merely by being stable, summarized,
or formatted into model context.
