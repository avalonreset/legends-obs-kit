---
name: legends-obs-kit
description: Inspect, configure, operate, and battle-test OBS Studio on Windows through a guarded CLI. Use for OBS setup, scenes and sources, recording, audio endpoints, encoder/HDR capability checks, settings drift, rollback, and local recording proof.
---

# Legends OBS Kit

Use the bundled CLI as the source of truth. The runtime spine is OBS WebSocket v5; FFprobe and the OBS log provide recording proof.

## Resolve and qualify

Resolve the command in this order:

1. Use `lobs` or `legends-obs-kit` when it is available on `PATH`.
2. If this skill is linked from a repository or extracted release, move two directories up from `SKILL.md` and run `node <root>\dist\index.js`.
3. In a developer checkout without `dist`, run `pnpm dev --` from the repository root.

If none exists, tell the user to install the complete release or repository. Do not invent an OBS control backend. In the examples below, `lobs` means whichever resolved invocation is available.

```powershell
lobs doctor --pretty
lobs manifest --pretty
lobs agent:context --pretty
lobs audit:status --pretty
```

`doctor` hard-gates authenticated local OBS control. Encoder, HDR, FFprobe, recording-path, and microphone checks are capabilities unless the requested operation needs them. If FFprobe is not on `PATH`, set `LEGENDS_OBS_FFPROBE_PATH` to its executable.

If the machine has no ledger, run `audit:capture --reason first-baseline`. If a ledger exists, run `audit:diff --against good`; use `--against latest` until the first passing canary creates a known-good pointer.

## Route by intent

| Intent | Commands |
|---|---|
| Health and live state | `doctor`, `status`, `record:status` |
| Machine, profile, scenes, and sources | `inventory`, `profile:show` |
| Audio endpoint | `audio:status`, `audio:plan`, `audio:bind` |
| Settings history and drift | `audit:status`, `audit:capture`, `audit:show`, `audit:diff`, `audit:verify` |
| Profile change | `profile:plan`, `profile:backup`, `profile:apply`, `profile:refresh`, `profile:rollback` |
| Local recording | `record:start`, `record:stop`, `record:canary` |
| Evidence | `logs:latest`, `receipts:list`, `receipts:verify` |
| Optional panel scene switcher | `vision-switch:*` |

Read `references/command-map.md` for the compact command and safety map.

Default output is privacy-minimized for agent use. `inventory --full`, `audio:status --include-devices`, audit documents, and local receipts can include machine paths, source names, endpoint IDs, window titles, and other workstation facts; keep them local unless the user explicitly asks to share them.

## Mutation rules

1. Read current state and produce a plan first.
2. Verify recording, streaming, replay buffer, and virtual camera are idle.
3. Keep `LEGENDS_OBS_DRY_RUN=true` by default.
4. For one authorized write, set it to `false`, pass `--confirm`, perform one bounded mutation, and restore dry-run in `finally`.
5. Every profile inspection, plan, backup, apply, or refresh and every `record:canary` requires an explicit `--preset <id>`; bundled presets are never selected as a user recommendation.
6. Profile apply snapshots before writing, refreshes only when necessary, and verifies exact readback.
7. Never print or copy the OBS WebSocket password or OBS service credentials.
8. Never call a recording `WORKS` without a passing canary receipt.
9. Treat `latest` as last observed, not proven. Only a passing canary advances `last-known-good`.
10. Use `--require-microphone` only when microphone capture is part of the user's acceptance criteria.

## Hardware decisions

Do not treat any bundled preset as universally correct. Inspect available encoders, current resolution/FPS, color format, display path, storage, audio needs, and target platform. Explain tradeoffs, run `profile:plan`, and let the user's requested outcome select the preset.

The bundled `hdr-4k60-av1-hybrid-mp4` preset is a tested reference for capable NVIDIA hardware: 3840×2160/60, P010, Rec.2100 PQ, limited range, Standard NVENC AV1, Hybrid MP4, CQP20 or better, two-second keyframes, single pass, and no rescale. It is not a default recommendation for other systems.

## Optional Vision Switcher

The deterministic panel-to-scene switcher is disarmed and dry-run by default. Supply panel samples with `--panel A|B|C|D` or set `LEGENDS_OBS_PANEL_SENSOR` to a PowerShell script that emits the documented JSON shape. Live cuts additionally require an armed state, idle outputs, `LEGENDS_OBS_DRY_RUN=false`, and `--confirm`. The cut loop never uses an LLM and never changes Windows display mode.
