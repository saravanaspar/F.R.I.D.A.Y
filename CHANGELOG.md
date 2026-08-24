# Changelog

Notable user-facing changes to F.R.I.D.A.Y are tracked here.

The project is in active development. GitHub Releases contain the authoritative published release artifacts and generated release notes.

## Unreleased

F.R.I.D.A.Y is preparing for its first public release.

The initial release includes the self-hosted assistant runtime, durable sessions and background work, memory, scheduling, multi-channel communication, tools and sandboxed execution, encrypted secrets, recovery, self-improvement, release packaging, security hardening, and cross-platform Linux/macOS binaries.

- Removed the conversational CLI channel and its trusted local-ingress API. The
  command line remains for setup/onboarding compatibility, doctor, and bounded
  stopped-runtime maintenance.
- Added exact first-run operator pairing, native approval buttons for Telegram,
  Discord, Slack, Teams, and Google Chat, private replay-resistant protected
  interaction state, and strict text fallbacks for every transport.
- Hardened Discord admission/session checkpoints, Email UIDVALIDITY checkpoints,
  Teams signed-route persistence, unsupported attachment handling, and
  Events/Scheduler cooperative shutdown behavior.
- Removed unreferenced model-runtime code, redundant direct dependencies, a
  duplicate script alias, and an unused upscaled brand asset.
