import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { readAuditStatus } from "./audit.js";
import type { KitConfig } from "./config.js";
import { latestObsLog, publicWebSocketConfig, readDisplayProfilesFromLatestLog, readObsWebSocketConfig } from "./obs-config.js";
import { ObsWebSocketClient } from "./obs-websocket.js";
import { getPrimaryMicrophoneStatus } from "./audio.js";
import type { JsonObject, JsonValue } from "./types.js";

async function commandVersion(command: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["-version"], { windowsHide: true, shell: false });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout.split(/\r?\n/)[0] ?? command : null));
  });
}

function check(name: string, ok: boolean, detail: unknown, required = true): JsonObject {
  return { name, ok, required, detail: (detail === undefined ? null : detail) as JsonValue };
}

export async function runDoctor(config: KitConfig): Promise<JsonObject> {
  const checks: JsonObject[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(check("node", nodeMajor >= 22, process.version));

  let wsConfig;
  try {
    wsConfig = await readObsWebSocketConfig(config.websocketConfigPath);
    checks.push(check("websocket-config", true, publicWebSocketConfig(wsConfig)));
    checks.push(check("websocket-enabled", wsConfig.server_enabled, `port ${wsConfig.server_port}`));
    checks.push(check("websocket-authentication", wsConfig.auth_required && Boolean(wsConfig.server_password), {
      required: wsConfig.auth_required,
      passwordPresent: Boolean(wsConfig.server_password),
    }));
  } catch (error) {
    const detail = error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? "OBS WebSocket configuration was not found. Start OBS once, enable Tools > WebSocket Server Settings, then retry."
      : error instanceof Error ? error.message : String(error);
    checks.push(check("websocket-config", false, detail));
  }

  const ffprobe = await commandVersion(config.ffprobePath);
  checks.push(check("ffprobe", ffprobe !== null, ffprobe ?? "Install FFprobe to use record:canary", false));

  try {
    const auditStatus = await readAuditStatus(config.stateDir);
    const machines = auditStatus.machines as JsonObject[];
    checks.push(check("settings-ledger", auditStatus.initialized === true, {
      machineCount: auditStatus.machineCount,
      latestCount: machines.filter((machine) => machine.latest !== null).length,
      lastKnownGoodCount: machines.filter((machine) => machine.lastKnownGood !== null).length,
    }, false));
  } catch (error) {
    checks.push(check("settings-ledger", false, error instanceof Error ? error.message : String(error), false));
  }

  let client: ObsWebSocketClient | null = null;
  if (wsConfig?.server_enabled) {
    try {
      client = await ObsWebSocketClient.connect(config.host, wsConfig);
      const [version, stats, recording] = await Promise.all([
        client.request("GetVersion"),
        client.request("GetStats"),
        client.request("GetRecordStatus"),
      ]);
      checks.push(check("authenticated-control", true, {
        obsVersion: version.obsVersion,
        obsWebSocketVersion: version.obsWebSocketVersion,
        rpcVersion: version.rpcVersion,
      }));
      checks.push(check("obs-performance", Number(stats.activeFps) > 0, {
        activeFps: stats.activeFps,
        averageFrameRenderTime: stats.averageFrameRenderTime,
        availableDiskSpaceMiB: stats.availableDiskSpace,
      }, false));
      checks.push(check("recording-idle", recording.outputActive !== true, recording.outputTimecode, false));

      try {
        const microphone = await getPrimaryMicrophoneStatus(client);
        checks.push(check("primary-microphone", microphone.ok === true, {
          ok: microphone.ok,
          followsWindowsDefault: microphone.followsWindowsDefault,
          available: microphone.available,
          enabled: microphone.enabled,
          muted: microphone.muted,
          inputVolumeMul: microphone.inputVolumeMul,
          routedTracks: microphone.routedTracks,
          availableDeviceCount: Array.isArray(microphone.devices) ? microphone.devices.length : 0,
        }, config.requirePrimaryMicrophone));
      } catch (error) {
        checks.push(check("primary-microphone", false, error instanceof Error ? error.message : String(error), config.requirePrimaryMicrophone));
      }

      try {
        const recordDirectory = await client.request("GetRecordDirectory");
        const recordPath = String(recordDirectory.recordDirectory ?? "");
        let writable = false;
        try {
          await access(recordPath, constants.W_OK);
          writable = true;
        } catch {
          writable = false;
        }
        checks.push(check("recording-directory", writable, { configured: Boolean(recordPath), writable }, false));
      } catch (error) {
        checks.push(check("recording-directory", false, error instanceof Error ? error.message : String(error), false));
      }

      const logPath = await latestObsLog(config.obsConfigRoot);
      let av1Supported = false;
      try {
        if (logPath) {
          const text = await readFile(logPath, "utf8");
          av1Supported = /AV1 supported:\s*true/i.test(text) && /obs_nvenc_av1_tex/i.test(text);
        }
      } catch {
        av1Supported = false;
      }
      checks.push(check("nvenc-av1", av1Supported, { supported: av1Supported, obsLogFound: Boolean(logPath) }, false));
      try {
        const displays = await readDisplayProfilesFromLatestLog(config.obsConfigRoot);
        const hdrDisplays = displays.filter((display) => /G2084/.test(String(display.colorSpace ?? "")) && /P2020/.test(String(display.colorSpace ?? "")));
        checks.push(check("display-hdr-mode", hdrDisplays.length > 0, {
          displayCount: displays.length,
          hdrDisplayCount: hdrDisplays.length,
          colorSpaces: [...new Set(displays.map((display) => String(display.colorSpace ?? "unknown")))].sort(),
        }, false));
      } catch (error) {
        checks.push(check("display-hdr-mode", false, error instanceof Error ? error.message : String(error), false));
      }
      try {
        const canvasList = await client.request("GetCanvasList");
        const canvases = (canvasList.canvases as JsonObject[] | undefined) ?? [];
        checks.push(check("single-canvas-operations", canvases.length <= 1, {
          canvasCount: canvases.length,
          note: canvases.length <= 1
            ? "Current scene operations are unambiguous"
            : "Scene mutations currently target the main canvas; select and verify manually when multiple canvases exist",
        }, false));
      } catch (error) {
        checks.push(check("single-canvas-operations", false, error instanceof Error ? error.message : String(error), false));
      }
    } catch (error) {
      checks.push(check("authenticated-control", false, error instanceof Error ? error.message : String(error)));
    } finally {
      await client?.close();
    }
  }

  const required = checks.filter((item) => item.required === true);
  const ok = required.every((item) => item.ok === true);
  return {
    ok,
    hardGate: ok ? "pass" : "fail",
    dryRun: config.dryRun,
    checkedAt: new Date().toISOString(),
    checks,
  };
}
