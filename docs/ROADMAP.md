# F.R.I.D.A.Y Roadmap

This roadmap communicates direction, not guaranteed dates. F.R.I.D.A.Y is developed in small, reviewable releases; individual items can move as security, durability, compatibility, and contributor feedback change priorities.

## Current release

### v1.0.3 — discoverability, remote administration, and safer self-improvement boundaries

v1.0.3 strengthens the plugin-first architecture and the reuse-before-build path. Typed capability/contribution/hook surfaces and concrete contribution registrations are machine-discoverable, Doctor is shared across local/trusted-channel administration, onboarding can continue remotely after the mandatory local trust bootstrap, and Voice/self-improvement/runtime boundaries are more explicit.

See [`CHANGELOG.md`](../CHANGELOG.md) for the released behavior.

## Next focus: v1.0.4

The next release is expected to focus on Memory correctness/retrieval quality and contributor ecosystem improvements rather than another broad architecture expansion.

### Memory quality and correctness

Candidate work includes:

- make relation correction atomic instead of compensating with a whole-state restore;
- make `memory.correct` behave like a true patch operation when fields are omitted;
- separate embedding maintenance/backfill from read-only recall so hybrid retrieval can be used safely in more paths;
- review relation identity vs. provenance/context semantics;
- strengthen the Memory-owned storage boundary against accidental credential-like persistence;
- harden project-document ingestion against filesystem replacement races and unnecessary absolute-path exposure.

These are design targets, not promises that every item will ship in the same patch release.

### Contributor and plugin ecosystem

We want F.R.I.D.A.Y to be easier to extend without requiring contributors to understand the whole runtime.

Good areas to help:

- plugin cookbook and small complete examples;
- a plugin scaffold command that generates a contract, implementation, and test skeleton;
- more channel adapters and provider integrations behind existing typed boundaries;
- additional sandbox providers;
- documentation, diagrams, demos, and setup troubleshooting;
- focused platform testing, especially WSL2/Linux/macOS combinations.

Browse [`good first issue`](https://github.com/saravanaspar/F.R.I.D.A.Y/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) and [`help wanted`](https://github.com/saravanaspar/F.R.I.D.A.Y/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22) issues for current scoped tasks.

## Research / later hardening

These are important but need deliberate design rather than opportunistic patches:

- build-time provenance that can prove the exact running binary generation matches the configured self-improvement source checkout;
- richer capability-quality/evaluation signals for reuse and self-improvement decisions;
- plugin ecosystem/registry UX without weakening typed ownership or trust boundaries;
- broader platform hardening before native Windows execution is treated as a supported security boundary.

## How roadmap items become work

1. Discuss the user problem first; avoid starting with a new plugin when an existing owner can solve it.
2. Search `npm run inspect:plugins` and existing issues before proposing new authority or surface IDs.
3. Use a focused issue/PR with explicit security, durability, persistence, and compatibility impact.
4. Keep changes inside the owning plugin where possible and communicate through typed contracts.
5. Run the repository verification gates before merge.

For contribution rules, see [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`docs/PLUGIN_DEVELOPMENT.md`](PLUGIN_DEVELOPMENT.md).
