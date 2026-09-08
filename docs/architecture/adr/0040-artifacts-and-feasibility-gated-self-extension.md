# ADR-0040: Safe Artifact Intake and Feasibility-Gated Self-Extension

## Status

Accepted.

## Context

Users may provide skill ZIPs, package URLs, GitHub MCP repositories or future
attachments through chat channels. FRIDAY must be able to install already
supported packages and, when a required software capability is genuinely
missing, use its existing Self-Improvement/Generations/Lifecycle machinery to
add that capability without losing the original request.

Raw channel downloads, archive extraction and repository inspection are too
security-sensitive to duplicate independently in Skills and MCP. Likewise,
"unsupported" must not automatically mean "start coding"; feasibility must be
established before FRIDAY tells the user it can build a missing feature.

## Decision

Add an `artifacts` plugin as the safe package-intake boundary. It stores channel
attachments by opaque reference with size/hash metadata and private files. It
stages HTTPS/GitHub package sources only inside the approved Sandbox, bounds
archive/repository size/file counts, rejects traversal/symlinks/non-regular
files and returns a temporary verified directory plus an explicit disposer.
Artifact bytes are never embedded directly in durable turn/session metadata.

Skills consumes Artifacts to inspect a package with the existing Skills parser,
shows the concrete install plan, obtains a separate install authorization and
atomically installs validated skills under the private user Skills root. URL
inspection that performs a network read is authorized before download. Agent
session caches observe a Skills revision and rebuild when the installed skill
set changes.

MCP accepts user-provided remote HTTPS endpoints directly through its existing
Streamable HTTP transport after plan/authorization/verification. A GitHub MCP
repository is inspected as intentional user-supplied provenance. If the current
generation lacks the required local/stdio package transport, MCP does not fake
support: it invokes the Self-Improvement capability-gap path.

For capability gaps that look like external/tool integrations, Self-Improvement
also performs MCP-first discovery before proposing domain integration code. It
checks configured live MCP catalogs, searches the official MCP Registry through
the MCP capability, and treats all Registry descriptions/tool metadata as
untrusted data. Registry metadata is only candidate-discovery evidence: a remote
is accepted only after FRIDAY temporarily registers it, retrieves its live tools,
and a bounded verifier confirms that one concrete tool description/input schema
supports the exact requested operation. Same-category branding is insufficient.
Failed probes are rolled back; rollback failure is fatal. Package-only Registry
candidates are not accepted from metadata alone when FRIDAY cannot live-verify
their tool catalog.

Self-Improvement exposes a feasibility operation with this mandatory order:

1. verify an implementation model is available and run a bounded, tool-free
   placement analysis over installed public capability contracts;
2. for an external/tool integration, complete MCP-first discovery and exact
   live tool/schema verification; if discovery itself cannot be completed,
   fail closed instead of generating integration code;
3. if no exact MCP match exists and code is required, verify the sandbox and a
   clean primary repository baseline;
4. only if code placement remains feasible, tell the user that the feature is unavailable but can be
   built now;
5. obtain typed authorization;
6. create/edit/evaluate/promote the candidate;
7. restart and verify the successor; and
8. re-emit the original exact channel turn (including durable artifact refs) so
   the request resumes without user repetition.

Infeasible requests never reach the "I can build it" message, authorization or
worktree stage. Denied authorization never starts self-improvement. A same-
principal protected cancellation watcher can abort an active build before the
message would otherwise enter Turn Loop serialization.

## Consequences

Package acquisition is reusable without making Channels, Skills or MCP own a
generic downloader. User-provided links are treated as intentional requests,
while actual network/mutation authority remains explicit. Self-extension is a
continuation protocol rather than a one-way source-code mutation.

The first generation still does not execute arbitrary repository code merely to
inspect a package. Installation/runtime support must be implemented behind an
owning plugin and its Permissions/Sandbox boundary.
