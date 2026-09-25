# Packaging

The full repository is the distribution unit: it contains the CLI, presets, documentation, and the vendored `cto-legends` router skill copy. A standalone copy of only `SKILL.md` is not the control runtime.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm pack:check
corepack pnpm release:check
npm pack --dry-run --json
```

`pack:check` scans public source and the exact npm file list for private workstation markers. `release:check` creates a tarball in an operating-system temporary directory, extracts it, and smoke-runs the packaged CLI without relying on `src`, a lockfile, or a source build.

The package must exclude `node_modules`, `.legends-obs-kit`, `.codex-tmp`, `.env*`, OBS configurations, recordings, logs, snapshots, receipts, and local one-off repair scripts. Release metadata must identify the MIT license and the public repository. The vendored router skill copy ships with the package; the kit CLI itself resolves the installed CLI or `dist/index.js` and must not require a source checkout.
