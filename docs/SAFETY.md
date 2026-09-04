# Safety contract

- **Default dry-run:** only literal `LEGENDS_OBS_DRY_RUN=false` enables live mutations.
- **Fresh confirmation:** every mutation also requires `--confirm`.
- **Output guard:** profile and audio changes refuse while recording, streaming, replay buffer, or virtual camera is active.
- **Snapshot first:** apply writes a redacted profile snapshot before its first setting change.
- **Flight recorder:** profile apply, refresh, and rollback write immutable redacted audits before and after the change.
- **Qualified good state:** observations advance `latest`; only a passing canary advances `last-known-good`.
- **Readback:** apply fails if the preset does not read back exactly; failed apply attempts automatic rollback.
- **No credential copies:** WebSocket password and OBS service tokens stay in OBS's config only.
- **No stream canary:** canaries use local recording, never streaming.
- **Bounded duration:** canaries accept only 3–30 seconds.
- **Optional primary microphone gate:** audio health is always reported. `record:start` and `record:canary` require a healthy Mic/Aux only with `--require-microphone` or `LEGENDS_OBS_REQUIRE_PRIMARY_MICROPHONE=true`.
- **Start readback:** recording start waits through encoder initialization before deciding whether OBS is actually active.
- **Evidence:** `WORKS` requires a healthy primary microphone endpoint, codec/dimensions/fps/bit-depth/color tags, clean fresh log, and bounded frame deltas.
- **Local state:** snapshots, audits, pointers, and receipts live under gitignored `.legends-obs-kit/`.
- **Deliberate exclusions:** never inventory stream-service credentials, stream keys, or plugin-private settings.
