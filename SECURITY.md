# Security Policy

F.R.I.D.A.Y handles powerful capabilities: model-driven code execution, filesystem access, external integrations, persistent sessions, messaging channels, scheduling, and encrypted credentials. Security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for a vulnerability that could expose secrets, bypass permissions, execute unintended code, impersonate a trusted principal, corrupt durable state, or compromise a host.

Preferred reporting path:

1. Open this repository's **Security** tab.
2. Use GitHub **Private vulnerability reporting** / **Report a vulnerability** when available.
3. Include enough information to reproduce and assess the issue without publishing live credentials or unrelated personal data.

If private vulnerability reporting is unavailable, contact the repository maintainer through the GitHub profile and ask for a private reporting channel before sharing exploit details.

## What to include

A useful report contains:

- affected commit/tag/version;
- affected platform and runtime configuration;
- threat model / required attacker access;
- clear reproduction steps or a minimal proof of concept;
- expected vs actual security boundary;
- potential impact;
- whether credentials, channel identity, filesystem access, sandbox escape, or remote code execution are involved;
- any suggested mitigation, if known.

Please redact real API keys, tokens, passwords, private message contents, and other secrets.

## High-priority areas

Reports are especially valuable for:

- Vault encryption, secret disclosure, or credential-capture bypass;
- trusted channel principal spoofing or approval bypass;
- permissions bypass for external/system/credential writes;
- sandbox escape or unsafe host mounts;
- path traversal, symlink races, or unsafe file replacement;
- duplicate/replayed external side effects across retry/restart boundaries;
- unauthenticated runtime overlap or lifecycle-handoff bypass;
- arbitrary code execution outside an explicitly authorized execution boundary;
- tampering with Audit, Sessions, Events, Scheduler, Jobs, or generation state in a way that fails open.

## Supported versions

Until the project publishes a stable support policy, security fixes target the current `main` branch and the latest published release. Older development tags may not receive backports.

## Disclosure

Please allow reasonable time for triage, patching, verification, and release before public disclosure. The maintainer may request additional reproduction details or coordinate a disclosure date for significant issues.

## Security model limitations

F.R.I.D.A.Y is local automation software with intentionally powerful capabilities. Permissions and sandboxing reduce risk but cannot make arbitrary model-generated code intrinsically safe. Operators remain responsible for host isolation, channel access, enabled integrations, provider credentials, and the privileges granted to the runtime process.

## Backup confidentiality

Full-state backups can contain transcripts, memory, schedules, channel metadata, and other operational state. Use `friday backup create --encrypt` for backups stored off-host or on shared/removable media. Encrypted backups authenticate the manifest and encrypt each stored file with AES-256-GCM using keys derived from the backup passphrase with scrypt. Passphrases are never accepted as command-line arguments.

## Supported release platforms

Hardened release binaries are currently published for Linux and macOS on x64/arm64. On Windows hosts, the supported release path is the PowerShell installer wrapper, which installs and runs the Linux release inside WSL2 so F.R.I.D.A.Y retains its POSIX private-file guarantees. Native Windows release binaries are intentionally disabled until the private-state permission model has native Windows ACL enforcement and platform-specific security tests. Partial native source compatibility on Windows must not be interpreted as a supported hardened release boundary.
