import os from "node:os";
import { spawn } from "node:child_process";
import type { KitConfig } from "./config.js";
import {
  latestObsLog,
  publicWebSocketConfig,
  readDisplayProfilesFromLatestLog,
  readGlobalIniSettings,
  readObsCapabilitiesFromLatestLog,
  readObsWebSocketConfig,
  readProfileIniSettings,
} from "./obs-config.js";
import type { ObsWebSocketClient } from "./obs-websocket.js";
import { getOutputActivity } from "./obs-websocket.js";
import { showProfile } from "./profile.js";
import { redactUnknown } from "./redact.js";
import type { JsonObject, JsonValue, ObsPreset } from "./types.js";

async function commandOutput(command: string, args: string[]): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

async function probeMedia(ffprobePath: string, file: string): Promise<JsonObject | null> {
  const raw = await commandOutput(ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,width,height,r_frame_rate,color_range,color_space,color_transfer,color_primaries",
    "-of", "json",
    file,
  ]);
  if (!raw) return null;
  try { return JSON.parse(raw) as JsonObject; }
  catch { return null; }
}

async function optionalRequest(client: ObsWebSocketClient, requestType: string, requestData: JsonObject = {}): Promise<JsonObject | null> {
  try {
    return await client.request(requestType, requestData);
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function parseGpuInventory(raw: string | null): JsonObject[] {
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, driverVersion, memoryMiB, encoderSessionCount] = line.split(",").map((value) => value.trim());
    return {
      name: name || "unknown",
      driverVersion: driverVersion || "unknown",
      memoryMiB: Number.isFinite(Number(memoryMiB)) ? Number(memoryMiB) : null,
      encoderSessionCount: Number.isFinite(Number(encoderSessionCount)) ? Number(encoderSessionCount) : null,
    };
  });
}

async function collectInputState(client: ObsWebSocketClient, inputUuid: string): Promise<JsonObject> {
  const requestData = { inputUuid };
  const requests = [
    ["active", "GetSourceActive"],
    ["mute", "GetInputMute"],
    ["volume", "GetInputVolume"],
    ["balance", "GetInputAudioBalance"],
    ["syncOffset", "GetInputAudioSyncOffset"],
    ["monitorType", "GetInputAudioMonitorType"],
    ["audioTracks", "GetInputAudioTracks"],
    ["deinterlaceMode", "GetInputDeinterlaceMode"],
    ["deinterlaceFieldOrder", "GetInputDeinterlaceFieldOrder"],
    ["media", "GetMediaInputStatus"],
  ] as const;
  const entries = await Promise.all(requests.map(async ([key, request]) => [key, await optionalRequest(client, request, requestData)] as const));
  return Object.fromEntries(entries.filter(([, value]) => value !== null)) as JsonObject;
}

export async function collectInventory(client: ObsWebSocketClient, config: KitConfig, preset: ObsPreset): Promise<JsonObject> {
  const [
    version,
    stats,
    sceneList,
    inputList,
    outputList,
    monitorList,
    profile,
    activity,
    wsConfig,
    logPath,
    displayProfiles,
    gpuRaw,
    inputKindList,
    filterKindList,
    transitionKindList,
    sceneCollectionList,
    transitionList,
    currentTransition,
    hotkeyList,
    canvasList,
    specialInputs,
    groupList,
    recordDirectory,
    logCapabilities,
    globalSettings,
  ] = await Promise.all([
    client.request("GetVersion"),
    client.request("GetStats"),
    client.request("GetSceneList"),
    client.request("GetInputList"),
    client.request("GetOutputList"),
    client.request("GetMonitorList"),
    showProfile(client, config, preset),
    getOutputActivity(client),
    readObsWebSocketConfig(config.websocketConfigPath),
    latestObsLog(config.obsConfigRoot),
    readDisplayProfilesFromLatestLog(config.obsConfigRoot),
    commandOutput("nvidia-smi", ["--query-gpu=name,driver_version,memory.total,encoder.stats.sessionCount", "--format=csv,noheader,nounits"]),
    optionalRequest(client, "GetInputKindList"),
    optionalRequest(client, "GetSourceFilterKindList"),
    optionalRequest(client, "GetTransitionKindList"),
    optionalRequest(client, "GetSceneCollectionList"),
    optionalRequest(client, "GetSceneTransitionList"),
    optionalRequest(client, "GetCurrentSceneTransition"),
    optionalRequest(client, "GetHotkeyList"),
    optionalRequest(client, "GetCanvasList"),
    optionalRequest(client, "GetSpecialInputs"),
    optionalRequest(client, "GetGroupList"),
    optionalRequest(client, "GetRecordDirectory"),
    readObsCapabilitiesFromLatestLog(config.obsConfigRoot),
    readGlobalIniSettings(config.obsConfigRoot),
  ]);

  const profileName = String(profile.profileName);
  const profileSettings = await readProfileIniSettings(config.obsConfigRoot, profileName);
  const inputKinds = stringList(inputKindList?.inputKinds);
  const filterKinds = stringList(filterKindList?.sourceFilterKinds);
  const transitionKinds = stringList(transitionKindList?.transitionKinds);

  const inputDefaults: JsonObject = {};
  await Promise.all(inputKinds.map(async (inputKind) => {
    const response = await optionalRequest(client, "GetInputDefaultSettings", { inputKind });
    if (response) inputDefaults[inputKind] = (response.defaultInputSettings ?? {}) as JsonValue;
  }));

  const filterDefaults: JsonObject = {};
  await Promise.all(filterKinds.map(async (filterKind) => {
    const response = await optionalRequest(client, "GetSourceFilterDefaultSettings", { filterKind });
    if (response) filterDefaults[filterKind] = (response.defaultFilterSettings ?? {}) as JsonValue;
  }));

  const inputs: JsonValue[] = [];
  for (const rawInput of inputList.inputs as JsonObject[]) {
    const inputUuid = String(rawInput.inputUuid);
    const [settings, filters, state] = await Promise.all([
      client.request("GetInputSettings", { inputUuid }),
      optionalRequest(client, "GetSourceFilterList", { sourceUuid: inputUuid }),
      collectInputState(client, inputUuid),
    ]);
    const inputSettings = settings.inputSettings as JsonObject;
    const localFile = typeof inputSettings?.local_file === "string" ? inputSettings.local_file : null;
    const mediaProbe = localFile ? await probeMedia(config.ffprobePath, localFile) : null;
    inputs.push({
      ...rawInput,
      settings: inputSettings,
      filters: filters?.filters ?? [],
      state,
      mediaProbe,
    });
  }

  const scenes: JsonValue[] = [];
  for (const rawScene of sceneList.scenes as JsonObject[]) {
    const sceneUuid = String(rawScene.sceneUuid);
    const [items, filters] = await Promise.all([
      client.request("GetSceneItemList", { sceneUuid }),
      optionalRequest(client, "GetSourceFilterList", { sourceUuid: sceneUuid }),
    ]);
    scenes.push({
      sceneName: rawScene.sceneName,
      sceneUuid,
      sceneIndex: rawScene.sceneIndex ?? null,
      items: items.sceneItems,
      filters: filters?.filters ?? [],
    });
  }

  const groups: JsonValue[] = [];
  for (const group of (groupList?.groups as JsonValue[] | undefined) ?? []) {
    const sceneName = String(group);
    const items = await optionalRequest(client, "GetGroupSceneItemList", { sceneName });
    groups.push({ sceneName, items: items?.sceneItems ?? [] });
  }

  const outputs = await Promise.all((outputList.outputs as JsonObject[]).map(async (rawOutput) => {
    const outputName = String(rawOutput.outputName);
    const settings = await optionalRequest(client, "GetOutputSettings", { outputName });
    return { ...rawOutput, settings: settings?.outputSettings ?? null };
  }));

  const inventory = {
    ok: true,
    capturedAt: new Date().toISOString(),
    kit: { dryRun: config.dryRun, stateDir: config.stateDir },
    machine: {
      host: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpu: os.cpus()[0]?.model ?? null,
      logicalProcessors: os.cpus().length,
      ramGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      gpus: parseGpuInventory(gpuRaw),
      node: process.version,
    },
    control: publicWebSocketConfig(wsConfig),
    obs: {
      version: {
        obsVersion: version.obsVersion,
        obsWebSocketVersion: version.obsWebSocketVersion,
        rpcVersion: version.rpcVersion,
        platform: version.platform,
        platformDescription: version.platformDescription,
      },
      capabilities: {
        availableRequests: stringList(version.availableRequests),
        supportedImageFormats: stringList(version.supportedImageFormats),
        inputKinds,
        inputDefaults,
        sourceFilterKinds: filterKinds,
        sourceFilterDefaults: filterDefaults,
        transitionKinds,
        log: logCapabilities,
      },
      activity,
      stats,
      profile,
      profileSettings,
      globalSettings,
      recordDirectory,
      sceneCollections: sceneCollectionList,
      sceneCollection: {
        currentProgramSceneName: sceneList.currentProgramSceneName,
        currentProgramSceneUuid: sceneList.currentProgramSceneUuid,
        currentPreviewSceneName: sceneList.currentPreviewSceneName ?? null,
        currentPreviewSceneUuid: sceneList.currentPreviewSceneUuid ?? null,
        scenes,
        groups,
      },
      inputs,
      outputs,
      transitions: {
        available: transitionList,
        current: currentTransition,
      },
      hotkeys: hotkeyList?.hotkeys ?? [],
      canvases: canvasList?.canvases ?? [],
      specialInputs,
      latestLog: logPath,
      monitors: monitorList.monitors,
      displayProfiles,
    },
  };
  return redactUnknown(inventory) as JsonObject;
}
