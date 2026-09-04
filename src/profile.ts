import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KitConfig } from "./config.js";
import { DEFAULT_PRESET_ID } from "./identity.js";
import { readRecordEncoderSettings } from "./obs-config.js";
import { assertOutputsIdle, type ObsWebSocketClient } from "./obs-websocket.js";
import { writeReceipt, writeSnapshot } from "./receipts.js";
import type { JsonObject, ObsPreset, ProfileParameter, ProfileSnapshot } from "./types.js";

const EXTRA_PARAMETERS: ProfileParameter[] = [
  { category: "AdvOut", name: "RecFilePath", value: "" },
  { category: "AdvOut", name: "RecTracks", value: "" },
];

export async function loadPreset(config: KitConfig, id = DEFAULT_PRESET_ID): Promise<ObsPreset> {
  if (path.basename(id) !== id) throw new Error("Preset id must not contain a path");
  const file = path.join(config.repoRoot, "presets", `${id}.json`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as ObsPreset;
  if (parsed.id !== id || !Array.isArray(parsed.parameters)) throw new Error(`Invalid preset: ${id}`);
  return parsed;
}

async function readParameter(client: ObsWebSocketClient, parameter: ProfileParameter): Promise<JsonObject> {
  return await client.request("GetProfileParameter", {
    parameterCategory: parameter.category,
    parameterName: parameter.name,
  });
}

async function readParameters(client: ObsWebSocketClient, parameters: ProfileParameter[]): Promise<JsonObject> {
  const unique = new Map<string, ProfileParameter>();
  for (const parameter of parameters) unique.set(`${parameter.category}/${parameter.name}`, parameter);
  const entries = await Promise.all(
    [...unique.entries()].map(async ([key, parameter]) => [key, await readParameter(client, parameter)] as const),
  );
  return Object.fromEntries(entries) as JsonObject;
}

export async function showProfile(client: ObsWebSocketClient, config: KitConfig, preset: ObsPreset): Promise<JsonObject> {
  const [profileList, videoSettings, parameters] = await Promise.all([
    client.request("GetProfileList"),
    client.request("GetVideoSettings"),
    readParameters(client, [...preset.parameters, ...EXTRA_PARAMETERS]),
  ]);
  const profileName = String(profileList.currentProfileName);
  const encoderSettings = await readRecordEncoderSettings(config.obsConfigRoot, profileName);
  return {
    profileName,
    profiles: profileList.profiles,
    videoSettings,
    parameters,
    encoderSettings,
    rangeLabel: ((parameters["Video/ColorRange"] as JsonObject | undefined)?.parameterValue === "Partial") ? "Limited" : "Full",
  };
}

function parameterValue(parameters: JsonObject, key: string): string | null {
  const entry = parameters[key] as JsonObject | undefined;
  return entry?.parameterValue === null || entry?.parameterValue === undefined ? null : String(entry.parameterValue);
}

export async function buildProfilePlan(client: ObsWebSocketClient, config: KitConfig, preset: ObsPreset): Promise<JsonObject> {
  const current = await showProfile(client, config, preset);
  const parameters = current.parameters as JsonObject;
  const parameterChanges = preset.parameters.flatMap((parameter) => {
    const key = `${parameter.category}/${parameter.name}`;
    const from = parameterValue(parameters, key);
    return from === parameter.value ? [] : [{ category: parameter.category, name: parameter.name, from, to: parameter.value }];
  });
  const currentVideo = current.videoSettings as JsonObject;
  const videoChanges = Object.entries(preset.video).flatMap(([name, to]) => {
    const from = Number(currentVideo[name]);
    return from === to ? [] : [{ name, from, to }];
  });
  const encoder = (current.encoderSettings as JsonObject | null) ?? {};
  const ffmpegMode = preset.encoderPolicy.mode === "ffmpeg";
  const encoderId = parameterValue(parameters, ffmpegMode ? "AdvOut/FFVEncoder" : "AdvOut/RecEncoder");
  let encoderChecks: JsonObject;
  if (ffmpegMode) {
    encoderChecks = {
      outputMode: { ok: parameterValue(parameters, "AdvOut/RecType") === "FFmpeg", actual: parameterValue(parameters, "AdvOut/RecType"), expected: "FFmpeg" },
      outputToFile: { ok: parameterValue(parameters, "AdvOut/FFOutputToFile") === "true", actual: parameterValue(parameters, "AdvOut/FFOutputToFile"), expected: "true" },
      encoder: { ok: encoderId !== null && preset.encoderPolicy.acceptedEncoderIds.includes(encoderId), actual: encoderId, accepted: preset.encoderPolicy.acceptedEncoderIds },
      container: { ok: parameterValue(parameters, "AdvOut/FFFormat") === preset.encoderPolicy.container, actual: parameterValue(parameters, "AdvOut/FFFormat"), expected: preset.encoderPolicy.container },
      videoBitrate: { ok: Number(parameterValue(parameters, "AdvOut/FFVBitrate")) >= Number(preset.encoderPolicy.bitrateMinimum), actual: Number(parameterValue(parameters, "AdvOut/FFVBitrate")), minimum: preset.encoderPolicy.bitrateMinimum ?? null },
      audioEncoder: { ok: parameterValue(parameters, "AdvOut/FFAEncoder") === preset.encoderPolicy.audioEncoder, actual: parameterValue(parameters, "AdvOut/FFAEncoder"), expected: preset.encoderPolicy.audioEncoder ?? null },
      audioMixes: { ok: Number(parameterValue(parameters, "AdvOut/FFAudioMixes")) === preset.encoderPolicy.audioMixes, actual: Number(parameterValue(parameters, "AdvOut/FFAudioMixes")), expected: preset.encoderPolicy.audioMixes ?? null },
    };
  } else {
    encoderChecks = {
      encoder: { ok: encoderId !== null && preset.encoderPolicy.acceptedEncoderIds.includes(encoderId), actual: encoderId, accepted: preset.encoderPolicy.acceptedEncoderIds },
      container: { ok: parameterValue(parameters, "AdvOut/RecFormat2") === preset.encoderPolicy.container, actual: parameterValue(parameters, "AdvOut/RecFormat2"), expected: preset.encoderPolicy.container },
      rateControl: { ok: String(encoder.rate_control ?? "").toUpperCase() === preset.encoderPolicy.rateControl, actual: encoder.rate_control ?? null, expected: preset.encoderPolicy.rateControl ?? null },
      cqp: { ok: Number(encoder.cqp) <= Number(preset.encoderPolicy.cqpMaximum), actual: encoder.cqp ?? null, maximum: preset.encoderPolicy.cqpMaximum ?? null },
      keyframeSeconds: { ok: Number(encoder.keyint_sec) === Number(preset.encoderPolicy.keyframeSeconds), actual: encoder.keyint_sec ?? null, expected: preset.encoderPolicy.keyframeSeconds ?? null },
      multipass: { ok: String(encoder.multipass ?? "") === preset.encoderPolicy.multipass, actual: encoder.multipass ?? null, expected: preset.encoderPolicy.multipass ?? null },
    };
  }
  const encoderPolicyOk = Object.values(encoderChecks).every((check) => (check as JsonObject).ok === true);
  return {
    ok: parameterChanges.length === 0 && videoChanges.length === 0 && encoderPolicyOk,
    preset: preset.id,
    profileName: current.profileName,
    parameterChanges,
    videoChanges,
    encoderPolicy: { ok: encoderPolicyOk, checks: encoderChecks },
    current,
  };
}

export async function captureProfileSnapshot(client: ObsWebSocketClient, config: KitConfig, preset: ObsPreset): Promise<{ snapshot: ProfileSnapshot; path: string }> {
  const current = await showProfile(client, config, preset);
  const snapshot = {
    kind: "legends-obs-profile-snapshot",
    version: 1,
    capturedAt: new Date().toISOString(),
    profileName: String(current.profileName),
    videoSettings: current.videoSettings as JsonObject,
    parameters: current.parameters as JsonObject,
    encoderSettings: current.encoderSettings as JsonObject | null,
  } satisfies ProfileSnapshot;
  const target = await writeSnapshot(config.stateDir, snapshot.profileName, snapshot);
  return { snapshot, path: target };
}

export async function applyPreset(client: ObsWebSocketClient, config: KitConfig, preset: ObsPreset): Promise<JsonObject> {
  const activity = await assertOutputsIdle(client);
  const beforePlan = await buildProfilePlan(client, config, preset);
  const encoderPolicy = beforePlan.encoderPolicy as JsonObject;
  const plannedEncoderRepair = (beforePlan.parameterChanges as JsonObject[]).some(
    (change) =>
      change.category === "AdvOut" &&
      ["RecType", "RecEncoder", "RecFormat2", "RecUseRescale"].includes(String(change.name)),
  );
  if (encoderPolicy.ok !== true && preset.encoderPolicy.mode !== "ffmpeg" && !plannedEncoderRepair) {
    throw new Error("Encoder policy is not satisfied; refusing a color-only apply that cannot produce the intended recording");
  }
  const backup = await captureProfileSnapshot(client, config, preset);
  let afterPlan: JsonObject;
  try {
    for (const change of beforePlan.parameterChanges as JsonObject[]) {
      await client.request("SetProfileParameter", {
        parameterCategory: change.category,
        parameterName: change.name,
        parameterValue: change.to,
      });
    }
    // OBS 32.2.1 can crash in obs_reset_video when SetVideoSettings is sent to an
    // already-correct pipeline. Refresh only when the requested change actually
    // touches video/color state.
    const needsVideoRefresh =
      (beforePlan.videoChanges as JsonObject[]).length > 0 ||
      (beforePlan.parameterChanges as JsonObject[]).some((change) => change.category === "Video");
    if (needsVideoRefresh) await client.request("SetVideoSettings", preset.video as unknown as JsonObject);
    afterPlan = await buildProfilePlan(client, config, preset);
    if (afterPlan.ok !== true) throw new Error("Profile apply readback did not match the selected preset");
  } catch (error) {
    try {
      await restoreSnapshotVerified(client, backup.snapshot);
    } catch (rollbackError) {
      throw new Error(
        `Profile apply failed and rollback could not be verified: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; ` +
        `original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error(`Profile apply failed; the previous profile was restored and verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  const receiptPayload = {
    ok: true,
    command: "profile:apply",
    appliedAt: new Date().toISOString(),
    preset: preset.id,
    profileName: beforePlan.profileName,
    activity,
    snapshotPath: backup.path,
    before: {
      parameterChanges: beforePlan.parameterChanges,
      videoChanges: beforePlan.videoChanges,
    },
    after: afterPlan,
  };
  const receiptPath = await writeReceipt(config.stateDir, "profile-apply", receiptPayload);
  return { ...receiptPayload, receiptPath } as JsonObject;
}

export async function refreshVideoPipeline(client: ObsWebSocketClient, config: KitConfig, preset: ObsPreset): Promise<JsonObject> {
  const activity = await assertOutputsIdle(client);
  const plan = await buildProfilePlan(client, config, preset);
  if (plan.ok !== true) throw new Error("Profile does not match the preset; apply it before refreshing the video pipeline");
  await client.request("SetVideoSettings", preset.video as unknown as JsonObject);
  const readback = await client.request("GetVideoSettings");
  const payload = {
    ok: true,
    command: "profile:refresh",
    refreshedAt: new Date().toISOString(),
    preset: preset.id,
    activity,
    videoSettings: readback,
  };
  const receiptPath = await writeReceipt(config.stateDir, "profile-refresh", payload);
  return { ...payload, receiptPath } as JsonObject;
}

export async function rollbackSnapshot(client: ObsWebSocketClient, config: KitConfig, snapshotPath: string): Promise<JsonObject> {
  await assertOutputsIdle(client);
  const parsed = JSON.parse(await readFile(path.resolve(snapshotPath), "utf8")) as ProfileSnapshot;
  if (parsed.kind !== "legends-obs-profile-snapshot" || parsed.version !== 1) throw new Error("Not a Legends OBS profile snapshot");
  const profileList = await client.request("GetProfileList");
  if (String(profileList.currentProfileName) !== parsed.profileName) {
    throw new Error(`Snapshot is for profile ${parsed.profileName}, current profile is ${String(profileList.currentProfileName)}`);
  }
  await restoreSnapshotVerified(client, parsed);
  const receiptPayload = {
    ok: true,
    command: "profile:rollback",
    rolledBackAt: new Date().toISOString(),
    profileName: parsed.profileName,
    snapshotPath: path.resolve(snapshotPath),
  };
  const receiptPath = await writeReceipt(config.stateDir, "profile-rollback", receiptPayload);
  return { ...receiptPayload, receiptPath } as JsonObject;
}

async function restoreSnapshot(client: ObsWebSocketClient, snapshot: ProfileSnapshot): Promise<void> {
  for (const [key, raw] of Object.entries(snapshot.parameters)) {
    const slash = key.indexOf("/");
    if (slash < 1 || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as JsonObject;
    await client.request("SetProfileParameter", {
      parameterCategory: key.slice(0, slash),
      parameterName: key.slice(slash + 1),
      parameterValue: entry.parameterValue,
    });
  }
  await client.request("SetVideoSettings", snapshot.videoSettings);
}

export async function restoreSnapshotVerified(client: ObsWebSocketClient, snapshot: ProfileSnapshot): Promise<void> {
  await restoreSnapshot(client, snapshot);
  const profileList = await client.request("GetProfileList");
  if (String(profileList.currentProfileName) !== snapshot.profileName) {
    throw new Error("Restored profile name did not read back exactly");
  }
  for (const [key, raw] of Object.entries(snapshot.parameters)) {
    const slash = key.indexOf("/");
    if (slash < 1 || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const expected = (raw as JsonObject).parameterValue;
    const actual = await client.request("GetProfileParameter", {
      parameterCategory: key.slice(0, slash),
      parameterName: key.slice(slash + 1),
    });
    if (JSON.stringify(actual.parameterValue) !== JSON.stringify(expected)) {
      throw new Error(`Restored parameter did not read back exactly: ${key}`);
    }
  }
  const actualVideo = await client.request("GetVideoSettings");
  for (const [key, expected] of Object.entries(snapshot.videoSettings)) {
    if (JSON.stringify(actualVideo[key]) !== JSON.stringify(expected)) {
      throw new Error(`Restored video setting did not read back exactly: ${key}`);
    }
  }
}
