import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { KitConfig } from "./config.js";
import { latestObsLog } from "./obs-config.js";
import { assertOutputsIdle, type ObsWebSocketClient } from "./obs-websocket.js";
import { buildProfilePlan } from "./profile.js";
import { writeReceipt } from "./receipts.js";
import { getPrimaryMicrophoneStatus } from "./audio.js";
import type { JsonObject, ObsPreset } from "./types.js";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type RecordStatusClient = Pick<ObsWebSocketClient, "request">;

export async function waitForRecordStart(
  client: RecordStatusClient,
  timeoutMs = 30_000,
  pollMs = 250,
): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: JsonObject = { outputActive: false };
  while (Date.now() < deadline) {
    lastStatus = await client.request("GetRecordStatus");
    if (lastStatus.outputActive === true) return lastStatus;
    await wait(pollMs);
  }
  throw new Error(
    `OBS accepted StartRecord but did not become active within ${timeoutMs} ms ` +
    `(last outputActive=${String(lastStatus.outputActive)})`,
  );
}

export async function waitForRecordStop(
  client: RecordStatusClient,
  timeoutMs = 30_000,
  pollMs = 250,
): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: JsonObject = { outputActive: true };
  while (Date.now() < deadline) {
    lastStatus = await client.request("GetRecordStatus");
    if (lastStatus.outputActive !== true) return lastStatus;
    await wait(pollMs);
  }
  throw new Error(
    `OBS did not become idle within ${timeoutMs} ms ` +
    `(last outputActive=${String(lastStatus.outputActive)})`,
  );
}

export async function stopRecordingAndVerifyIdle(
  client: RecordStatusClient,
  watchMs = 5_000,
  pollMs = 250,
): Promise<void> {
  const deadline = Date.now() + watchMs;
  do {
    const status = await client.request("GetRecordStatus");
    if (status.outputActive === true) {
      await client.request("StopRecord");
      await waitForRecordStop(client, Math.max(pollMs, deadline - Date.now()), pollMs);
    }
    if (Date.now() < deadline) await wait(pollMs);
  } while (Date.now() < deadline);
  const finalStatus = await client.request("GetRecordStatus");
  if (finalStatus.outputActive === true) throw new Error("Recording became active at the end of the cleanup watch window");
}

async function runJson(command: string, args: string[]): Promise<JsonObject> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
      else {
        try { resolve(JSON.parse(stdout) as JsonObject); }
        catch { reject(new Error(`${command} returned invalid JSON`)); }
      }
    });
  });
}

function parseFps(value: unknown): number {
  const text = String(value ?? "0/1");
  const [numerator, denominator] = text.split("/").map(Number);
  return denominator ? numerator / denominator : numerator;
}

async function waitForFile(file: string): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const current = (await stat(file)).size;
      if (current > 0 && current === previous) return current;
      previous = current;
    } catch {
      // Recorder may have returned before the file handle is visible.
    }
    await wait(250);
  }
  throw new Error(`Recording did not settle: ${file}`);
}

export async function runCanary(
  client: ObsWebSocketClient,
  config: KitConfig,
  preset: ObsPreset,
  seconds: number,
  requirePrimaryMicrophone = config.requirePrimaryMicrophone,
): Promise<JsonObject> {
  if (seconds < 3 || seconds > 30) throw new Error("Canary duration must be between 3 and 30 seconds");
  await assertOutputsIdle(client);
  const profilePlan = await buildProfilePlan(client, config, preset);
  if (profilePlan.ok !== true) throw new Error(`Selected preset ${preset.id} is not ready; run profile:plan and profile:apply first`);
  const primaryMicrophone = await getPrimaryMicrophoneStatus(client);
  if (requirePrimaryMicrophone && primaryMicrophone.ok !== true) {
    throw new Error("Primary Mic/Aux endpoint is unavailable; run audio:status and audio:bind before recording");
  }

  const logPath = await latestObsLog(config.obsConfigRoot);
  const logBefore = logPath ? await readFile(logPath, "utf8") : "";
  const statsBefore = await client.request("GetStats");
  let stopResult: JsonObject;
  try {
    await client.request("StartRecord");
    await waitForRecordStart(client);
    await wait(seconds * 1000);
    stopResult = await client.request("StopRecord");
    await waitForRecordStop(client);
  } catch (error) {
    try {
      // A lost StartRecord response may still produce a late recording.
      // Never return from a failed canary until idle state is positively read back.
      await stopRecordingAndVerifyIdle(client);
    } catch (cleanupError) {
      throw new Error(
        `Canary failed and recording cleanup could not verify idle: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; ` +
        `original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error(`Canary failed; recording cleanup verified idle: ${error instanceof Error ? error.message : String(error)}`);
  }

  const outputPath = String(stopResult.outputPath);
  const sizeBytes = await waitForFile(outputPath);
  const probe = await runJson(config.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputPath]);
  const streams = (probe.streams as JsonObject[] | undefined) ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Canary recording has no video stream");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const statsAfter = await client.request("GetStats");

  const renderSkippedDelta = Number(statsAfter.renderSkippedFrames) - Number(statsBefore.renderSkippedFrames);
  const outputSkippedDelta = Number(statsAfter.outputSkippedFrames) - Number(statsBefore.outputSkippedFrames);
  const logAfter = logPath ? await readFile(logPath, "utf8") : "";
  const logSegment = logAfter.slice(logBefore.length);
  const encoderErrors = logSegment.split(/\r?\n/).filter((line) => /NVENC Error|Failed to start recording|encoder.*failed|output.*failed|WASAPI.*failed|Failed to enumerate device/i.test(line));
  const bitDepth = Number(video.bits_per_raw_sample || (/10/.test(String(video.pix_fmt)) ? 10 : 8));
  const actual = {
    codec: video.codec_name,
    width: video.width,
    height: video.height,
    fps: parseFps(video.avg_frame_rate || video.r_frame_rate),
    bitDepth,
    pixelFormat: video.pix_fmt,
    colorRange: video.color_range,
    colorSpace: video.color_space,
    colorTransfer: video.color_transfer,
    colorPrimaries: video.color_primaries,
    audioStreams: audioStreams.length,
    primaryMicrophone: {
      healthy: primaryMicrophone.ok,
      inputName: primaryMicrophone.inputName,
      deviceName: primaryMicrophone.configuredDeviceName,
      deviceId: primaryMicrophone.configuredDeviceId,
      muted: primaryMicrophone.muted,
      inputVolumeMul: primaryMicrophone.inputVolumeMul,
      routedTracks: primaryMicrophone.routedTracks,
    },
  };
  const expected = preset.expectedProbe;
  const checks = {
    codec: actual.codec === expected.codec,
    dimensions: actual.width === expected.width && actual.height === expected.height,
    fps: Math.abs(Number(actual.fps) - expected.fps) < 0.01,
    bitDepth: actual.bitDepth >= expected.bitDepth,
    colorRange: actual.colorRange === expected.colorRange,
    colorSpace: actual.colorSpace === expected.colorSpace,
    colorTransfer: actual.colorTransfer === expected.colorTransfer,
    colorPrimaries: actual.colorPrimaries === expected.colorPrimaries,
    primaryMicrophone: !requirePrimaryMicrophone || primaryMicrophone.ok === true,
    encoderErrors: encoderErrors.length === 0,
    outputSkippedFrames: outputSkippedDelta <= 0,
    renderSkippedFrames: renderSkippedDelta <= 2,
  };
  const ok = Object.values(checks).every(Boolean);
  const payload = {
    ok,
    classification: ok ? "WORKS" : "BLOCKED",
    command: "record:canary",
    completedAt: new Date().toISOString(),
    durationSeconds: seconds,
    outputPath,
    sizeBytes,
    expected,
    actual,
    requirements: { primaryMicrophone: requirePrimaryMicrophone },
    checks,
    frameDeltas: { renderSkipped: renderSkippedDelta, outputSkipped: outputSkippedDelta },
    encoderErrors,
    latestLog: logPath,
  };
  const receiptPath = await writeReceipt(config.stateDir, "record-canary", payload);
  return { ...payload, receiptPath } as JsonObject;
}
