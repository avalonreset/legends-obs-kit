# OBS intent to Legends CLI

There is no runtime MCP dependency. The CLI uses the native OBS WebSocket v5 protocol.

| Human intent | CLI route |
|---|---|
| Is OBS controllable? | `doctor`, `status` |
| What machine/profile/scenes/sources are active? | `inventory`, `profile:show` |
| What would a chosen setup change? | `profile:plan --preset <id>` |
| Preserve current setup | `profile:backup` |
| Apply an explicitly chosen preset | `profile:apply --preset <id>` |
| Rebuild the active video pipeline | `profile:refresh --preset <id>` |
| Undo a setup change | `profile:rollback --snapshot <path>` |
| Check/start/stop local recording | `record:status`, `record:start`, `record:stop` |
| Prove an actual file | `record:canary --preset <id>` |
| Inspect evidence | `logs:latest`, `receipts:list`, `receipts:verify` |
