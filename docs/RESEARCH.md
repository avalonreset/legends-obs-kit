# Research and compatibility evidence

## Surface decision

| Surface | Evidence | Decision |
|---|---|---|
| Official CLI | OBS does not ship a general profile, scene, source, and recording operator CLI. | Provide a narrow CLI. |
| Official API | OBS WebSocket v5 is built into OBS 28+ and exposes the required control and inventory requests. | Use the native protocol as the runtime spine. |
| Local authentication | OBS stores the loopback WebSocket port and password in its own local config. | Read it in-process; never print or copy it. |
| Recording proof | FFprobe validates the file, OBS logs expose encoder failures, and WebSocket stats expose skipped frames. | A canary must combine all three evidence sources. |
| MCP | The native protocol covers the current intent set. | No runtime MCP dependency. |

Official sources: [obs-websocket](https://github.com/obsproject/obs-websocket), [protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md), and [OBS HDR guide](https://obsproject.com/kb/hdr-and-10-bit-color).

## Verified reference configuration

The current public release candidate was exercised on Windows 11 with OBS Studio 32.2.2, obs-websocket 5.7.4, and an RTX 4090. The `hdr-4k60-av1-hybrid-mp4` canary produced AV1 at 3840×2160/60, 10-bit `yuv420p10le`, limited-range BT.2020, ST 2084/PQ transfer, four audio streams, zero new render/output skipped frames, and no fresh encoder errors.

This is evidence for that reference preset, not a minimum hardware requirement. Core doctor, inventory, ledger, scene, source, and status functions are designed to work independently of NVIDIA, HDR, 4K, 60 fps, FFprobe, and a configured microphone.

## Important implementation findings

- `SetProfileParameter` persists color values but does not always rebuild the active video pipeline. Profile apply uses `SetVideoSettings` only when video/color state actually changes, avoiding an unnecessary reset on already-correct OBS 32.2.x pipelines.
- Standard NVENC AV1 with Hybrid MP4 is the qualified reference output. Earlier Standard MKV and Custom FFmpeg experiments are not shipped as recommended presets.
- After OBS, GPU-driver, plugin, display, or audio changes, rerun doctor, inventory, drift comparison, and one bounded canary before retaining a `WORKS` claim for a preset.
