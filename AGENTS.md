# Legends OBS Kit — agent instructions

1. Read `LEGENDS.md` and `skills/legends-obs-kit/SKILL.md`.
2. Resolve the CLI as documented in the skill, then run `doctor --pretty`, `manifest --pretty`, and `agent:context --pretty`. In a cloned or extracted release, the universal invocation is `node .\dist\index.js <command>`; a global install also provides `lobs`.
3. Use the TypeScript CLI as the source of truth. Do not bypass it with raw OBS config edits or ambient MCP.
4. Read before write: `audit:status`, `audit:diff --against good`, `status` or `inventory`, then `profile:plan --preset <id>` only after choosing a hardware-appropriate preset. If no ledger exists, capture a baseline first.
5. Writes require `LEGENDS_OBS_DRY_RUN=false` and `--confirm`; restore dry-run immediately afterward.
6. Never print, copy, log, or commit the OBS WebSocket password or OBS service tokens.
7. Profile writes must be idle, snapshot first, refresh the active video pipeline, and verify readback.
8. A recording is `WORKS` only after `record:canary` verifies FFprobe metadata, dropped frames, and the fresh OBS log.
9. Latest means last observed. Only a passing canary advances last-known-good; profile mutations require before/after ledger captures.
10. Keep machine audits and receipts in gitignored `.legends-obs-kit/`; never commit user runtime evidence.
