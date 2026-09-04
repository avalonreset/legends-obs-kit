# First run

1. Install Node.js 22+ and activate pnpm 10 with `corepack enable` plus `corepack prepare pnpm@10.33.0 --activate`. Install FFprobe only if you want canary recording proof. Confirm it with `where.exe ffprobe`, or set `LEGENDS_OBS_FFPROBE_PATH` to the full `ffprobe.exe` path.
2. In OBS, open **Tools → WebSocket Server Settings**. Enable the server, keep authentication enabled, and preserve the generated password. The kit reads that local config in-process and never prints it.
3. Clone the repository, run `pnpm install --frozen-lockfile` and `pnpm build`, then run `node .\dist\index.js doctor --pretty`. The same command works from an extracted release; a global install may use `lobs doctor --pretty`.
4. Run `status` and `inventory` to inspect the actual profile, outputs, encoders, sources, and hardware. `inventory` is summarized by default; reserve `inventory --full` for local diagnostics.
5. Run `audit:status`. If the machine has no ledger, run `audit:capture --reason first-baseline`.
6. Choose a preset only after comparing it with the current machine. Run `profile:plan --preset <id>` and review every diff.
7. Use the guarded apply/canary recipe in `RECIPES.md`. A passing canary creates the first `last-known-good` pointer.

Doctor hard-gates only Node, local WebSocket configuration, authenticated control, and compatible RPC access. Recording-path, FFprobe, encoder, HDR, performance, and microphone results are capability reports unless the requested command needs them.
