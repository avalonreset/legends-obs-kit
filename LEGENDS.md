# legends-obs-kit

**Skill id:** `legends-obs-kit`  
**CLI:** `legends-obs-kit` / `lobs`  
**Platform:** Windows 10/11

**Spine:** authenticated OBS WebSocket v5 + local OBS configuration/log evidence + FFprobe proof
**Local state:** `%LOCALAPPDATA%\LegendsOBSKit\state` for new installs; existing checkout-local `.legends-obs-kit/` state remains supported

## Product contract

legends-obs-kit provides a hardware-neutral control and evidence layer for OBS Studio. It discovers the user's actual machine and profile before making recommendations. Optional bundled presets are explicit examples, not universal defaults.

Every mutation is dry-run by default, requires a fresh confirmation, checks output activity, preserves rollback evidence where applicable, and verifies readback. The kit never copies OBS WebSocket passwords, stream keys, or service credentials.
