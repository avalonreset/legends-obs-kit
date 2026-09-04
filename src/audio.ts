import { setTimeout as wait } from "node:timers/promises";
import type { KitConfig } from "./config.js";
import { captureAudit } from "./audit.js";
import { assertOutputsIdle, type ObsWebSocketClient } from "./obs-websocket.js";
import { writeReceipt } from "./receipts.js";
import type { JsonObject, ObsPreset } from "./types.js";

const DEVICE_PROPERTY = "device_id";

interface AudioDeviceItem extends JsonObject {
  itemName: string;
  itemValue: string;
  itemEnabled: boolean;
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function publicDevice(item: AudioDeviceItem): JsonObject {
  return {
    name: item.itemName,
    id: item.itemValue,
    enabled: item.itemEnabled,
  };
}

export function selectAudioDevice(items: AudioDeviceItem[], query: string): AudioDeviceItem {
  const wanted = normalized(query);
  if (!wanted) throw new Error("Audio device match cannot be empty");

  const enabled = items.filter((item) => item.itemEnabled !== false);
  const exact = enabled.filter((item) => normalized(item.itemName) === wanted || normalized(item.itemValue) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Audio device match is ambiguous: ${query}`);

  const partial = enabled.filter((item) => normalized(item.itemName).includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) throw new Error(`No enabled OBS audio device matches: ${query}`);
  throw new Error(`Audio device match is ambiguous: ${query}; matches ${partial.map((item) => item.itemName).join(", ")}`);
}

async function audioDeviceItems(client: ObsWebSocketClient, inputName: string): Promise<AudioDeviceItem[]> {
  const response = await client.request("GetInputPropertiesListPropertyItems", {
    inputName,
    propertyName: DEVICE_PROPERTY,
  });
  const raw = (response.propertyItems as JsonObject[] | undefined) ?? [];
  return raw.map((item) => ({
    itemName: String(item.itemName ?? ""),
    itemValue: String(item.itemValue ?? ""),
    itemEnabled: item.itemEnabled !== false,
  }));
}

export async function getAudioInputStatus(client: ObsWebSocketClient, inputName: string): Promise<JsonObject> {
  const [response, items, mute, volume, tracks] = await Promise.all([
    client.request("GetInputSettings", { inputName }),
    audioDeviceItems(client, inputName),
    client.request("GetInputMute", { inputName }),
    client.request("GetInputVolume", { inputName }),
    client.request("GetInputAudioTracks", { inputName }),
  ]);
  const inputSettings = (response.inputSettings as JsonObject | undefined) ?? {};
  const inputKind = String(response.inputKind ?? "");
  const configuredDeviceId = String(inputSettings[DEVICE_PROPERTY] ?? "default");
  const configured = items.find((item) => normalized(item.itemValue) === normalized(configuredDeviceId));
  const followsWindowsDefault = normalized(configuredDeviceId) === "default";
  const muted = mute.inputMuted === true;
  const inputVolumeMul = Number(volume.inputVolumeMul ?? 0);
  const inputAudioTracks = (tracks.inputAudioTracks as JsonObject | undefined) ?? {};
  const routedTracks = Object.entries(inputAudioTracks)
    .filter(([, enabled]) => enabled === true)
    .map(([track]) => Number(track))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const endpointHealthy = followsWindowsDefault || configured?.itemEnabled === true;
  const healthy = inputKind === "wasapi_input_capture" && endpointHealthy && !muted && inputVolumeMul > 0 && routedTracks.length > 0;

  return {
    ok: healthy,
    inputName,
    inputKind,
    configuredDeviceId,
    configuredDeviceName: configured?.itemName ?? (followsWindowsDefault ? "Default" : null),
    followsWindowsDefault,
    available: Boolean(configured) || followsWindowsDefault,
    enabled: followsWindowsDefault || configured?.itemEnabled === true,
    muted,
    inputVolumeMul,
    inputVolumeDb: volume.inputVolumeDb,
    routedTracks,
    devices: items.map(publicDevice),
  };
}

export async function getPrimaryMicrophoneStatus(client: ObsWebSocketClient): Promise<JsonObject> {
  const special = await client.request("GetSpecialInputs");
  const inputName = typeof special.inputName === "string" ? special.inputName : String(special.mic1 ?? "");
  if (!inputName) {
    return {
      ok: false,
      inputName: null,
      detail: "OBS has no primary Mic/Aux special input configured",
      devices: [],
    };
  }
  return await getAudioInputStatus(client, inputName);
}

export async function buildAudioBindPlan(client: ObsWebSocketClient, inputName: string, deviceMatch: string): Promise<JsonObject> {
  const current = await getAudioInputStatus(client, inputName);
  const items = ((current.devices as JsonObject[] | undefined) ?? []).map((item) => ({
    itemName: String(item.name ?? ""),
    itemValue: String(item.id ?? ""),
    itemEnabled: item.enabled !== false,
  }));
  const target = selectAudioDevice(items, deviceMatch);
  const configuredDeviceId = String(current.configuredDeviceId);
  const noOp = normalized(configuredDeviceId) === normalized(target.itemValue) && current.ok === true;
  return {
    ok: noOp,
    command: "audio:plan",
    inputName,
    current: {
      healthy: current.ok,
      deviceName: current.configuredDeviceName,
      deviceId: configuredDeviceId,
    },
    target: publicDevice(target),
    noOp,
    change: noOp ? null : { setting: DEVICE_PROPERTY, before: configuredDeviceId, after: target.itemValue },
  };
}

export async function bindAudioInput(
  client: ObsWebSocketClient,
  config: KitConfig,
  preset: ObsPreset,
  inputName: string,
  deviceMatch: string,
): Promise<JsonObject> {
  await assertOutputsIdle(client);
  const plan = await buildAudioBindPlan(client, inputName, deviceMatch);
  if (plan.noOp === true) return { ok: true, noOp: true, plan };

  const target = plan.target as JsonObject;
  const beforeAudit = await captureAudit(client, config, preset, { reason: "pre-audio-bind" });
  let readback: JsonObject;
  try {
    await client.request("SetInputSettings", {
      inputName,
      inputSettings: { [DEVICE_PROPERTY]: target.id },
      overlay: true,
    });
    await wait(750);
    readback = await getAudioInputStatus(client, inputName);
    const verified = readback.ok === true && normalized(readback.configuredDeviceId) === normalized(target.id);
    if (!verified) throw new Error(`Audio binding did not read back as healthy for ${inputName}`);
  } catch (error) {
    const prior = plan.current as JsonObject;
    try {
      await client.request("SetInputSettings", {
        inputName,
        inputSettings: { [DEVICE_PROPERTY]: prior.deviceId },
        overlay: true,
      });
      await wait(750);
      const rollback = await getAudioInputStatus(client, inputName);
      if (normalized(rollback.configuredDeviceId) !== normalized(prior.deviceId)) {
        throw new Error("previous device id did not read back exactly");
      }
    } catch (rollbackError) {
      throw new Error(
        `Audio binding failed and rollback could not be verified: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; ` +
        `original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error(`Audio binding failed; the previous device binding was restored and verified: ${error instanceof Error ? error.message : String(error)}`);
  }

  const afterAudit = await captureAudit(client, config, preset, { reason: "post-audio-bind" });
  const payload = {
    ok: true,
    command: "audio:bind",
    inputName,
    before: plan.current,
    after: {
      healthy: readback.ok,
      deviceName: readback.configuredDeviceName,
      deviceId: readback.configuredDeviceId,
    },
    rollback: {
      command: `audio:bind --input \"${inputName}\" --device \"${String((plan.current as JsonObject).deviceId)}\" --confirm`,
    },
    audits: { before: beforeAudit, after: afterAudit },
  };
  const receiptPath = await writeReceipt(config.stateDir, "audio-bind", payload);
  return { ...payload, receiptPath } as JsonObject;
}
