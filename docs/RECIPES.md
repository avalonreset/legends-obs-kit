# Intent-first recipes

Run `doctor` first. Keep dry-run enabled except for one explicitly authorized command.

The examples use `node .\dist\index.js`, which works in both a built source checkout and an extracted release. A global installation may use `lobs` instead.

## Understand current OBS

```powershell
node .\dist\index.js doctor --pretty
node .\dist\index.js status --pretty
node .\dist\index.js inventory --pretty
node .\dist\index.js profile:show --preset hdr-4k60-av1-hybrid-mp4 --pretty
```

An optional warning is not a core-control failure. Interpret FFprobe, microphone, NVENC, HDR, performance, and recording-path results against the user's requested outcome.

## Record and compare this machine

```powershell
node .\dist\index.js audit:status --pretty
node .\dist\index.js audit:capture --reason manual-baseline --pretty
node .\dist\index.js audit:show --which latest --pretty
node .\dist\index.js audit:diff --against latest --pretty
node .\dist\index.js audit:verify --pretty
```

After a passing canary, use `audit:diff --against good` to compare with the last proven recording state.

## Plan a preset without changing anything

```powershell
node .\dist\index.js profile:plan --preset hdr-4k60-av1-hybrid-mp4 --pretty
node .\dist\index.js profile:backup --preset hdr-4k60-av1-hybrid-mp4 --pretty
```

The bundled HDR preset is only an example for compatible NVIDIA hardware. Do not infer that it is right for a user's GPU, display, storage, or delivery target.

## Apply and prove an explicitly selected preset

```powershell
try {
  $env:LEGENDS_OBS_DRY_RUN = "false"
  node .\dist\index.js profile:apply --preset hdr-4k60-av1-hybrid-mp4 --confirm --pretty
  node .\dist\index.js record:canary --preset hdr-4k60-av1-hybrid-mp4 --seconds 8 --confirm --pretty
}
finally {
  $env:LEGENDS_OBS_DRY_RUN = "true"
}

node .\dist\index.js doctor --pretty
node .\dist\index.js receipts:verify --pretty
node .\dist\index.js audit:diff --against good --pretty
```

Add `--require-microphone` to the canary when microphone capture is an acceptance requirement. Profile changes automatically capture before/after audits; only a passing canary advances `last-known-good`.

## Roll back an exact snapshot

```powershell
try {
  $env:LEGENDS_OBS_DRY_RUN = "false"
  node .\dist\index.js profile:rollback --snapshot ".legends-obs-kit\snapshots\<file>.json" --confirm --pretty
}
finally {
  $env:LEGENDS_OBS_DRY_RUN = "true"
}
```

## Record manually

```powershell
try {
  $env:LEGENDS_OBS_DRY_RUN = "false"
  node .\dist\index.js record:start --confirm --pretty
  # Work while recording.
  node .\dist\index.js record:stop --confirm --pretty
}
finally {
  $env:LEGENDS_OBS_DRY_RUN = "true"
}
```

Use `--require-microphone` on `record:start` when a healthy primary Mic/Aux is mandatory.

## Optional Vision Switcher

The switcher maps panel pairs `A/B` and `C/D` to OBS scenes `panel-ab` and `panel-cd`. It is deterministic, disarmed by default, and refuses cuts while any output is active.

```powershell
# Offline plan with an explicit panel sample.
node .\dist\index.js vision-switch:plan --panel C --current-scene panel-ab --pretty

# Configure an optional PowerShell sensor that emits panel JSON.
$env:LEGENDS_OBS_PANEL_SENSOR = "C:\path\to\Get-ActivePanel.ps1"
node .\dist\index.js vision-switch:status --pretty

# Arm state, then run a dry tick.
node .\dist\index.js vision-switch:arm --pretty
node .\dist\index.js vision-switch:tick --panel C --pretty
```

Live cuts require all of: armed state, idle outputs, `LEGENDS_OBS_DRY_RUN=false`, and `--confirm`. Scene renames additionally require `--go <operator-authorization-note>`. The kit never changes Windows display mode and rejects automatic stretch-to-fill as a default policy.
