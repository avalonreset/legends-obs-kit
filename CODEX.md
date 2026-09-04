# Legends OBS Kit — Codex

Use the installed `legends-obs-kit` skill. Resolve the real checkout from the skill junction; do not hardcode a stale copy.

First checks:

```powershell
node .\dist\index.js doctor --pretty
node .\dist\index.js manifest --pretty
node .\dist\index.js agent:context --pretty
```

Stay read-only while any output is active. For an authorized write, plan it, enable live mode for one bounded command, pass `--confirm`, read back, then restore dry-run and verify receipts.
