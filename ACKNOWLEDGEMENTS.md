# Acknowledgements and Upstream Provenance

F.R.I.D.A.Y is an independent project, but parts of its implementation and design were informed by, adapted from, or retain lineage from other open-source agent projects.

This file is a human-readable provenance summary. The root `LICENSE` contains the retained MIT copyright notices used by this repository, and architecture ADRs record more detailed implementation decisions.

## Hermes Agent

Project: https://github.com/NousResearch/hermes-agent  
License: MIT  
Copyright: Nous Research

F.R.I.D.A.Y adapted selected Hermes Agent ideas/patterns rather than vendoring the complete project. Documented areas include:

- gateway/channel patterns such as normalized platform events and allowlist-first ingress;
- platform-adapter approaches for Email, Teams, Google Chat, Signal, SMS/Twilio, and WhatsApp separation;
- stable prompt-prefix / prompt-caching ideas;
- Hermes-style reusable skill layout/ingestion concepts.

F.R.I.D.A.Y reimplements these ideas inside its own TypeScript plugin/capability architecture and trust boundaries.

Relevant project documentation includes `docs/architecture/adr/0027-channels-plugin.md` and `docs/architecture/adr/0043-donor-model-runtime-cache-and-telemetry.md`.

## Prime Agent and Pi lineage

Projects:

- https://github.com/PrimeIntellect-ai/prime-agent
- https://github.com/badlogic/pi-mono - Pi provider/agent lineage acknowledged by Prime Agent and retained through the provider implementation family

License: MIT

F.R.I.D.A.Y's low-level model/provider transport has substantial lineage from the provider design/code family used by Prime Agent/Pi. F.R.I.D.A.Y retains that provider breadth and adapts it to its own Plugin Kernel, permissions, session affinity, cache semantics, telemetry, and runtime contracts.

The root MIT license retains the Mario Zechner and Prime Intellect copyright notices associated with this lineage.

Relevant documentation: `docs/architecture/adr/0041-cache-stable-model-context-and-provenance.md` and `docs/architecture/adr/0043-donor-model-runtime-cache-and-telemetry.md`.

## OpenCode

Project: https://github.com/anomalyco/opencode  
License: MIT  
Copyright: opencode

F.R.I.D.A.Y reviewed and adapted selected OpenCode implementation ideas, including:

- provider/cache-policy design comparisons;
- request-local prompt cache placement concepts;
- model request retry classification;
- `Retry-After` handling and bounded exponential/jittered backoff behavior.

The retry behavior is integrated at F.R.I.D.A.Y's model-request boundary so successfully completed mutating tools are not blindly replayed.

Relevant documentation: `docs/architecture/adr/0043-donor-model-runtime-cache-and-telemetry.md` and `docs/architecture/adr/0044-detached-session-jobs-and-model-retry.md`.

## Other donor/reference projects

Some architecture research also compared behavior with projects such as Goose and Codex where documented in ADR-0043. Those references were used selectively for design comparison and telemetry/cache semantics; the ADR records whether a behavior was kept, adapted, or only compared.

## Independence and trademarks

F.R.I.D.A.Y is not affiliated with, sponsored by, or endorsed by Nous Research, Prime Intellect, the OpenCode team, or their respective contributors. Project and product names belong to their respective owners.

If you find upstream-derived code whose provenance or notice is missing or inaccurate, please open an issue (or a private report when security-sensitive) so it can be corrected.
