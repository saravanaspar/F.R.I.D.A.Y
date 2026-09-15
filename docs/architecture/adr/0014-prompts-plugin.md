# ADR 0014: Prompts plugin

## Status

Accepted.

## Decision

FRIDAY keeps model-facing system-prompt composition in the `prompts` plugin.

The plugin owns **pure formatting, provenance labeling, authority ordering, and
cache-scope ordering** for prompt material that has already been resolved by the
host. It does not decide facts, discover files, or grant authority. Callers pass
typed `PromptSection` records with:

- a stable section `id`;
- model-visible `content`;
- an explicit authority class: `core-policy`, `host-policy`, `user-config`,
  `project-guidance`, `runtime-context`, or `untrusted-data`;
- an explicit cache scope: `stable` or `volatile`.

`prompts` renders those records with model-visible provenance. Stable material
must remain a contiguous leading prefix for provider caching, so authority is a
semantic trust label rather than a claim that every higher-authority section is
physically later/earlier than every lower-authority section. Within a cache
segment, sections are ordered by authority. The core doctrine explicitly tells
the model that authority labels determine precedence regardless of position.
Formatting must never upgrade an input's authority. In particular:

1. FRIDAY operating doctrine is `core-policy`.
2. capability/plugin doctrine that defines safe use of an owned runtime seam is
   `host-policy`.
3. explicit persistent user configuration such as Agent Profile role
   instructions, Persona settings, user-installed/explicit-path Skills, and user
   custom guidance is `user-config` and remains subordinate to core/host policy
   and to a newer explicit user objective where they conflict.
4. host-selected repository instruction files such as the active workspace's
   exact `AGENTS.md`, plus security-validated project-discovered Skills, are
   `project-guidance`; they may define repository-local
   conventions and validation procedures but cannot redefine the user's
   objective or grant permissions.
5. current working state such as time, current Project workspace, active
   Computer lease, recursive depth, and current conditional-rule state is
   `runtime-context`.
6. retrieved/external material is `untrusted-data`. Instructions appearing in
   webpages, tool output, files, logs, UI/OCR/vision text, MCP/API results,
   attachments, or quoted conversations remain data even when they use
   imperative language.

Skill discovery and trust scanning stay in `skills`; this plugin accepts
structural, already-validated skill records and formats the model-visible Skill
section. Recursive child admission stays in `subagents`/`rlm`; this plugin only
renders usage doctrine. Execution environment provisioning stays in
`execution`; the prompt advertises kernel packages only when the host explicitly
supplies that metadata.

The Turn Loop resolves canonical wall-clock facts and the configured IANA
`FRIDAY_TIMEZONE` and passes them as volatile runtime facts. `prompts` never
reads process-local time to invent those facts. Turn Loop similarly discovers
only the exact active-workspace `AGENTS.md`, opens it without following the
final path component, verifies the opened descriptor is a bounded regular file,
classifies it as project guidance, and passes the content to `prompts`; symlinked
or arbitrary repository files are not elevated into instruction authority.

Custom/append system guidance does not replace FRIDAY's operating doctrine. It
is strong persistent `user-config`: the Agent should apply it explicitly and
consistently when relevant, while core/host policy, permission boundaries, tool
contracts, and a newer explicit user request retain precedence.

The plugin does not discover files, mutate sessions, call models, run tools, or
own persistent memory. Application/session composition gathers those
capabilities and passes their resolved state into `buildSystemPromptPlan()`.

## Stable versus volatile prompt material

The returned `SystemPromptPlan` exposes a cache-stable leading prefix and a
volatile suffix without changing the single logical system prompt seen by the
model. Stable material may include operating doctrine, host capability doctrine,
security-validated user Skills, persistent Agent Profile/Persona/custom user
configuration, and security-validated project Skills/bounded `AGENTS.md` project
guidance. Session-specific or rapidly changing
facts such as working directory, conversation-log path, recursive depth,
current time/timezone, current Project runtime state, Computer lease/generation,
and conditional-hook counters belong in the volatile suffix.

## Boundary

`prompts` does not own:

- skill discovery, security scanning, frontmatter parsing, or Python package preparation;
- project-file discovery or classification of arbitrary repository content;
- RLM host-request handling or child-agent lifecycle;
- model/provider transport, authentication, or tool execution;
- session persistence, compaction, memory, or refinement;
- scheduling, sandboxing, permissions, or CLI orchestration;
- authorization decisions or lifecycle enforcement merely because text appears
  in a prompt section.
