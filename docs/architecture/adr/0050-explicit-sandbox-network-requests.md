# ADR 0050: Sandbox network access requires an explicit request and approval

## Status

Accepted. Supersedes the network-availability decision in ADR-0045, amends the
`full`-mode prompt wording in ADR-0032, and restores/extends the explicit network
gating recorded in ADR-0023.

## Context

Network access is a distinct authority from workspace read/write access. Giving
model-generated shell work ambient egress makes an action's declared authority
misleading, lets deterministic/offline work reach the network unnecessarily,
and gives long-lived kernels more authority than they need. FRIDAY also needs a
single rule that applies consistently across `ask`, `auto`, and `full` permission
modes.

## Decision

- `FRIDAY_SANDBOX_NETWORK_MODE` defaults to `requested`.
- A sandbox request that does not explicitly request network is translated by the
  selected provider into that provider's network-isolated mode.
- A request that needs network must declare that need. Permissions treats a
  network-bearing action as approval-requiring **before** considering the normal
  permission mode, so network access requires explicit approval even in `full`.
- Persistent IPython does not request network and is therefore network-off under
  the default policy. Networked fetch/install work uses an explicitly
  network-requesting permission-gated tool path.
- `FRIDAY_SANDBOX_NETWORK_MODE=unrestricted` remains an explicit host override
  that makes egress technically available to sandbox launches, but the action is
  still represented as network-bearing and remains subject to Permissions
  approval. Doctor warns when this non-default override is configured.
- FRIDAY does not currently impose a destination allowlist. The security boundary
  is explicit request + approval, the selected provider's declared isolation class, narrow
  mounts, and
  credential controls rather than silent destination inference.
- Tool schemas and model-facing guidance must not silently use network. They must
  request it only when the operation needs it.

## Consequences

- Offline/local work gets a deterministic network-off sandbox by default.
- `full` means prompt-free non-network workspace authority, not unconditional
  internet authority.
- Unattended tasks that require network must carry an explicit network request and
  an approval path; this is intentional friction for a high-impact capability.
- Persistent kernels have a smaller ambient authority surface.
- Operators can deliberately choose the unrestricted host override for special
  deployments, but Doctor makes that deviation visible.
