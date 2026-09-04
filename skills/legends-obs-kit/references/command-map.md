# Command map

Run `doctor`, `manifest`, and `agent:context` first.

| Lane | Read | Write |
|------|------|-------|
| Health | `doctor`, `status`, `logs:latest` | — |
| Inventory | `inventory`, `profile:show` | — |
| Audio | `audio:status`, `audio:plan` | `audio:bind` |
| Settings ledger | `audit:status`, `audit:capture`, `audit:show`, `audit:diff`, `audit:verify` | local evidence only |
| Profile | `profile:plan`, `profile:backup` | `profile:apply`, `profile:refresh`, `profile:rollback` |
| Recording | `record:status` | `record:start`, `record:stop`, `record:canary` |
| Evidence | `receipts:list`, `receipts:verify` | — |
| Optional scene switching | `vision-switch:status`, `vision-switch:plan`, `vision-switch:scene-plan` | `vision-switch:tick`, `vision-switch:daemon`, `vision-switch:scene-apply` |

OBS writes require `LEGENDS_OBS_DRY_RUN=false` and `--confirm`. `audit:capture` changes no OBS state; it writes redacted, gitignored evidence. Profile and audio writes require all outputs idle. Canaries are local-only and 3–30 seconds; only a passing canary advances last-known-good.
