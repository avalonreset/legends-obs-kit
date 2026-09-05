# Hardware-specific settings ledger

OBS options are not universal. They change with the GPU, driver, OBS build, loaded plugins, source kinds, output modules, and display path. legends-obs-kit therefore treats a current machine audit as operational evidence, not optional documentation.

## What is recorded

Each immutable audit includes:

- host, OS, CPU, RAM, GPU model/VRAM/driver, Node, OBS, and WebSocket versions;
- OBS-published request capabilities and installed input/filter/transition kinds plus defaults;
- modules and video/audio encoders loaded by the active OBS process;
- current profile names, video settings, relevant profile parameters, encoder JSON, and full redacted `basic.ini`/`global.ini` settings;
- scene collections, scenes, items, groups, sources, source settings, filters, audio routing, outputs, transitions, hotkeys, and canvases;
- monitor and Windows HDR facts plus media color probes for local media sources;
- stable hardware, capability, and decision-surface hashes.

The ledger deliberately excludes stream-service settings, service credentials, stream keys, plugin-private settings, and UI-only dropdown enumerations that OBS does not expose. This is decision-complete for kit-controlled recording work, not a claim that OBS WebSocket publishes every widget in every plugin dialog.

## Pointer semantics

The immutable records live at:

```text
.legends-obs-kit\audits\<machine-key>\snapshots\<timestamp>-<reason>.json
```

Two small pointers make fast decisions safe:

- `latest.json` — the newest observed audit, including manual captures and pre/post mutation captures;
- `last-known-good.json` — the exact settings that produced a passing FFprobe/log/frame-qualified local canary.

An observed capture never overwrites the good pointer. A failed canary also leaves it untouched.

## Commands

```powershell
node .\dist\index.js audit:status --pretty
node .\dist\index.js audit:capture --reason before-adjustment --pretty
node .\dist\index.js audit:show --which good --pretty
node .\dist\index.js audit:diff --against latest --pretty
node .\dist\index.js audit:diff --against good --pretty
node .\dist\index.js audit:verify --pretty
```

`audit:status` and `audit:show` work offline. If more than one machine exists, pass `--machine <machine-key>` to `audit:show`. Capture and diff authenticate to live OBS but do not mutate it. Drift output contains exact JSON paths and before/after values, capped at 250 displayed differences while reporting the full count.

`audit:verify` works offline and validates every audit schema, secret scan, settings/capability/hardware hash, pointer target, and verified-good classification.

## Automatic capture points

- `profile:backup` records the current machine state.
- `profile:apply`, `profile:refresh`, and `profile:rollback` record before and after state.
- `record:canary` records current state after the proof run.
- Only a passing `record:canary` marks that audit `verified-good` and advances `last-known-good`.

The machine key is derived from stable host and hardware facts, excluding driver version and active encoder-session count. Driver, OBS, plugin, and capability changes therefore appear as drift within the same machine history instead of silently creating a new identity.
