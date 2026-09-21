# troubleshooting

Start with `node .\dist\index.js doctor --pretty` from the toolkit directory.
Use `lobs` instead only if you installed the command on your PATH.

| symptom | check | next action |
|---|---|---|
| `dist/index.js` is missing | source checkout versus extracted release | run `pnpm install --frozen-lockfile` and `pnpm build`, or use the prebuilt release |
| connection or authentication fails | OBS is running; Tools → WebSocket Server Settings has server and authentication enabled | keep the password in OBS; rerun doctor after correcting the local server setup |
| FFprobe warning | `where.exe ffprobe` | install FFprobe or set `LEGENDS_OBS_FFPROBE_PATH` to its executable before a recording canary |
| encoder or HDR warning | current machine's reported capabilities | inspect inventory and choose a suitable profile; do not copy the RTX 4090 reference preset blindly |
| no last-known-good snapshot | `audit:status` | capture a first baseline; a successful recording canary establishes known-good state |
| a change is dry-run or refused | live mode, explicit confirmation, and output activity | inspect the plan; follow the bounded [mutation recipe](RECIPES.md) only for an authorized change |
| multiple canvases are reported | doctor advisory and intended scene canvas | verify the intended target; scene mutations currently address the main canvas |

## report a reproducible problem

Include the kit version, Windows and OBS versions, exact command, expected
result, and redacted error. Say whether this came from a source checkout or a
release archive. [Open an issue](https://github.com/avalonreset/legends-obs-kit/issues).

Default status and inventory are privacy-minimized, but review anything before
posting it. Do not attach OBS configuration, passwords, stream keys, recordings,
full inventory, or machine audit files. Report vulnerabilities through
[the security policy](../SECURITY.md).

The automated package tests verify command packaging and simulated behavior.
They do not certify your capture hardware; a local canary checks the recording
on your machine. See [first run](FIRST-RUN.md) and [safety](SAFETY.md).
