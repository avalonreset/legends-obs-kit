# Packaging

The full repository is the distribution unit: it contains the CLI, presets, documentation, and the linked agent skill. A standalone copy of only `SKILL.md` is not the control runtime.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm pack:check
corepack pnpm release:check
npm pack --dry-run --json
```

`pack:check` scans public source and the exact npm file list for private workstation markers. `release:check` creates a tarball in an operating-system temporary directory, extracts it, smoke-runs the packaged CLI, and installs the bundled skill twice into an isolated temporary user profile to prove idempotency without relying on `src`, a lockfile, or a source build.

The package must exclude `node_modules`, `.legends-obs-kit`, `.codex-tmp`, `.env*`, OBS configurations, recordings, logs, snapshots, receipts, and local one-off repair scripts. Release metadata must identify the MIT license and the public repository. The packaged skill must resolve the installed CLI or `dist/index.js`; it must not require a source checkout.
