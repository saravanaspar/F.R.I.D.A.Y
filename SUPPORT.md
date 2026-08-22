# Support

## Bugs

Use a GitHub bug report when F.R.I.D.A.Y behaves incorrectly and you can provide a reproducible description.

Before filing:

```bash
friday --version
node --version
npm --version
```

For source checkouts, also run the narrowest relevant test or `npm run verify` when practical.

Please include:

- F.R.I.D.A.Y version/tag/commit;
- operating system and architecture;
- installation method;
- affected channel/provider/plugin;
- expected behavior;
- actual behavior;
- sanitized logs or stack traces;
- minimal reproduction steps.

Never paste API keys, passwords, OAuth refresh tokens, Vault recovery material, or private conversation content that is not necessary to reproduce the issue.

## Questions and setup help

For setup/configuration questions, open an issue only after checking the README and existing issues. If GitHub Discussions is enabled for the repository, prefer Discussions for open-ended usage questions and ideas.

## Feature requests

Use the feature-request template and describe the user problem before proposing an implementation. For cross-plugin architecture changes, include which capabilities or trust boundaries would change.

## Security

Do not use public support channels for vulnerabilities. Follow `SECURITY.md`.

## Unsupported environments

The maintainer may ask you to reproduce problems on a supported/current Node.js version, an unmodified release, or a clean source checkout before debugging custom forks or heavily modified runtime environments.
