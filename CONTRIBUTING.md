# Contributing to F.R.I.D.A.Y

Thanks for helping improve F.R.I.D.A.Y.

This project is a stateful personal-agent runtime with trusted channels, credentials, code execution, background work, and self-replacement. Changes that look small can cross important durability or security boundaries, so contributions should optimize for correctness and explicit behavior rather than convenience.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For security vulnerabilities, do **not** open a public issue. Follow `SECURITY.md`.
- For large architectural changes, open an issue first and describe the problem, desired behavior, and affected plugin boundaries.

## Development setup

Requirements:

- Node.js 22.22.2 (see `.node-version`)
- npm
- Git
- `uv` for the private execution-Python environment used by kernel tests
- Podman only for sandbox integration tests or sandbox usage

```bash
git clone https://github.com/saravanaspar/F.R.I.D.A.Y.git
cd F.R.I.D.A.Y
npm ci
npm run setup:execution-python
npm run verify
```

## Repository architecture

F.R.I.D.A.Y is intentionally plugin-first. Keep ownership local to the subsystem that owns the behavior and communicate through typed capabilities/contributions rather than direct sibling implementation imports.

Before changing architecture, read:

- `docs/architecture/ARCHITECTURE_CONTRACT.md`
- relevant ADRs under `docs/architecture/adr/`
- `scripts/check-plugin-boundaries.mjs`
- `docs/PLUGIN_DEVELOPMENT.md` for the minimal plugin-authoring workflow

Important expectations:

1. Model-facing code must not gain trusted secret/lifecycle authority by convenience.
2. Durable state transitions should be persistence-first when replay or restart can cause side effects.
3. External writes should be permission-gated and idempotent where the external provider supports it.
4. Channel ingress must not acknowledge work before durable admission.
5. Restart/self-improvement changes must preserve authenticated handoff and rollback behavior.
6. New plugin dependencies should be explicit in the plugin manifest; config order must not become orchestration.
7. Security-sensitive filesystem code should fail closed on malformed permissions, unsafe symlinks, or unexpected identities.

## Making a change

Use a focused, short-lived branch for each change and merge it into protected `main` through a pull request after CI passes. Name the branch for the work, for example `fix/sea-node-runtime`, `feat/github-integration`, `chore/repository-maintenance`, or `docs/...`. Delete the local and remote branch after merge. External contributors should use the same focused-branch approach from their fork.

Keep commits reviewable and write commit messages that explain the behavior changed, not only the file edited.

Add or update tests for behavior changes. Fault/restart-sensitive code should include failure-path tests where practical.

## Verification

Run the full gate before opening a pull request:

```bash
npm run verify
```

Targeted commands are useful while iterating:

```bash
npm run typecheck
npm test
npm run test:workspaces
npm run check:architecture
npm run check:packaging
npm run check:silent-failures
npm run check:models
```

If sandbox integration tests are skipped because Podman is unavailable, say so in the PR.

## Pull requests

A good pull request includes:

- the problem being solved;
- the user-visible behavior before and after;
- important architecture/security/durability implications;
- tests added or changed;
- exact verification commands run;
- any manual setup, migration, or compatibility considerations.

Avoid mixing unrelated refactors with a behavior fix unless the refactor is necessary for the fix.

## Documentation

Update documentation when a change affects:

- setup or installation;
- user-visible commands/behavior;
- persisted state or migration;
- plugin boundaries;
- security assumptions;
- release packaging;
- restart/recovery semantics.

Architectural decisions that constrain future changes belong in an ADR.

## Licensing and upstream code

Do not copy code from another project without checking its license and preserving required notices. If a contribution adapts non-trivial implementation logic from another open-source project, document the provenance in `ACKNOWLEDGEMENTS.md` and/or an ADR and retain the required copyright/license notices.

By contributing, you agree that your contribution may be distributed under this repository's MIT License.
