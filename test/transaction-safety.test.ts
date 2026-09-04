import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPreset } from "../src/profile.js";
import type { KitConfig } from "../src/config.js";
import type { ObsWebSocketClient } from "../src/obs-websocket.js";
import type { JsonObject, ObsPreset } from "../src/types.js";

test("profile apply restores and verifies a snapshot after a mid-write failure", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "legends-obs-profile-transaction-"));
  const parameters = new Map<string, unknown>([
    ["Video/TestA", "old-a"],
    ["Video/TestB", "old-b"],
    ["AdvOut/RecFilePath", "C:/recordings"],
    ["AdvOut/RecTracks", "1"],
  ]);
  const video: JsonObject = { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 };
  let failedTargetWrite = false;
  const request = async (requestType: string, data: JsonObject = {}): Promise<JsonObject> => {
    if (["GetRecordStatus", "GetStreamStatus", "GetReplayBufferStatus", "GetVirtualCamStatus"].includes(requestType)) return { outputActive: false };
    if (requestType === "GetProfileList") return { currentProfileName: "Test", profiles: ["Test"] };
    if (requestType === "GetVideoSettings") return { ...video };
    if (requestType === "SetVideoSettings") {
      Object.assign(video, data);
      return {};
    }
    if (requestType === "GetProfileParameter") {
      const key = `${String(data.parameterCategory)}/${String(data.parameterName)}`;
      return { parameterValue: parameters.get(key) ?? null };
    }
    if (requestType === "SetProfileParameter") {
      const key = `${String(data.parameterCategory)}/${String(data.parameterName)}`;
      if (key === "Video/TestB" && data.parameterValue === "new-b" && !failedTargetWrite) {
        failedTargetWrite = true;
        throw new Error("simulated mid-write failure");
      }
      parameters.set(key, data.parameterValue);
      return {};
    }
    throw new Error(`unexpected request: ${requestType}`);
  };
  const preset: ObsPreset = {
    id: "test",
    displayName: "Test",
    description: "transaction fixture",
    parameters: [
      { category: "Video", name: "TestA", value: "new-a" },
      { category: "Video", name: "TestB", value: "new-b" },
    ],
    video: video as ObsPreset["video"],
    encoderPolicy: { mode: "ffmpeg", acceptedEncoderIds: [], container: "", bitrateMinimum: 0, audioEncoder: "", audioMixes: 0 },
    expectedProbe: { codec: "", width: 0, height: 0, fps: 0, bitDepth: 0, colorRange: "", colorSpace: "", colorTransfer: "", colorPrimaries: "" },
  };
  const config: KitConfig = {
    repoRoot: stateDir,
    obsConfigRoot: stateDir,
    websocketConfigPath: path.join(stateDir, "ws.json"),
    stateDir,
    ffprobePath: "ffprobe",
    dryRun: false,
    requirePrimaryMicrophone: false,
    host: "127.0.0.1",
  };
  try {
    const profileDirectory = path.join(stateDir, "basic", "profiles", "Test");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(path.join(profileDirectory, "basic.ini"), "[General]\nName=Test\n", "utf8");
    await assert.rejects(
      applyPreset({ request } as unknown as ObsWebSocketClient, config, preset),
      /previous profile was restored and verified.*simulated mid-write failure/,
    );
    assert.equal(parameters.get("Video/TestA"), "old-a");
    assert.equal(parameters.get("Video/TestB"), "old-b");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
