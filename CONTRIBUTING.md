# Contributing

Contributions are welcome through issues and pull requests.

Before opening a pull request, run:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm pack:check
corepack pnpm release:check
```

Do not commit OBS configuration, credentials, recordings, logs, machine audits, receipts, or `.legends-obs-kit/` state. Live OBS tests must use a disposable profile or a reviewed backup and must leave all outputs stopped.
