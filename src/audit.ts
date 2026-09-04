import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KitConfig } from "./config.js";
import { collectInventory } from "./inventory.js";
import type { ObsWebSocketClient } from "./obs-websocket.js";
import { containsSecretMarker, redactUnknown } from "./redact.js";
import type { JsonObject, JsonValue, ObsPreset } from "./types.js";

const AUDIT_KIND = "legends-obs-settings-audit";
const POINTER_KIND = "legends-obs-audit-pointer";
const AUDIT_VERSION = 1;

export interface AuditCaptureOptions {
  reason: string;
  verification?: {
    receiptPath: string;
    canary: JsonObject;
  };
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "unnamed";
}

function stamp(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashJson(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function gpuHardware(gpus: unknown): JsonValue[] {
  if (!Array.isArray(gpus)) return [];
  return gpus.map((raw) => {
    const gpu = raw as JsonObject;
    return { name: gpu.name ?? null, memoryMiB: gpu.memoryMiB ?? null };
  });
}

export function buildMachineKey(machine: JsonObject): string {
  const hardwareIdentity = {
    host: machine.host ?? null,
    architecture: machine.architecture ?? null,
    cpu: machine.cpu ?? null,
    logicalProcessors: machine.logicalProcessors ?? null,
    ramGiB: machine.ramGiB ?? null,
    gpus: gpuHardware(machine.gpus),
  };
  return `machine-${hashJson(hardwareIdentity).slice(0, 12)}`;
}

function stateRelative(stateDir: string, target: unknown): string | null {
  if (typeof target !== "string" || target.length === 0) return null;
  return path.relative(stateDir, target).replaceAll("\\", "/");
}

function publicMachineKey(machineKey: string): string {
  return /^machine-[a-f0-9]{12}$/i.test(machineKey) ? machineKey : `legacy-${hashJson(machineKey).slice(0, 12)}`;
}

const volatileKeys = new Set([
  "activity",
  "capturedAt",
  "dryRun",
  "encoderSessionCount",
  "latestLog",
  "outputActive",
  "outputBytes",
  "outputCongestion",
  "outputDuration",
  "outputReconnecting",
  "outputSkippedFrames",
  "outputTimecode",
  "canvasUuid",
  "currentPreviewSceneUuid",
  "currentProgramSceneUuid",
  "inputUuid",
  "sceneUuid",
  "sourceUuid",
  "transitionUuid",
  "sourceLog",
  "state",
  "stateDir",
  "stats",
]);

function stableDecisionValue(value: unknown, key = ""): JsonValue {
  if (volatileKeys.has(key)) return null;
  if (Array.isArray(value)) return value.map((child) => stableDecisionValue(child));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([childKey]) => !volatileKeys.has(childKey))
        .map(([childKey, child]) => [childKey, stableDecisionValue(child, childKey)]),
    ) as JsonObject;
  }
  if (value === undefined) return null;
  return value as JsonValue;
}

function stableOutputs(value: unknown): JsonValue {
  if (!Array.isArray(value)) return null;
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return stableDecisionValue(raw);
    const output = structuredClone(raw as Record<string, unknown>);
    if (output.settings && typeof output.settings === "object" && !Array.isArray(output.settings)) {
      delete (output.settings as Record<string, unknown>).path;
    }
    return stableDecisionValue(output);
  });
}

export function buildDecisionSurface(inventory: JsonObject): JsonObject {
  const machine = inventory.machine as JsonObject;
  const obs = inventory.obs as JsonObject;
  const surface = {
    hardware: {
      host: machine.host ?? null,
      platform: machine.platform ?? null,
      release: machine.release ?? null,
      architecture: machine.architecture ?? null,
      cpu: machine.cpu ?? null,
      logicalProcessors: machine.logicalProcessors ?? null,
      ramGiB: machine.ramGiB ?? null,
      gpus: machine.gpus ?? [],
    },
    runtime: {
      node: machine.node ?? null,
      obs: obs.version ?? null,
      control: inventory.control ?? null,
    },
    capabilities: obs.capabilities ?? null,
    settings: {
      profile: obs.profile ?? null,
      profileSettings: obs.profileSettings ?? null,
      globalSettings: obs.globalSettings ?? null,
      recordDirectory: obs.recordDirectory ?? null,
      sceneCollections: obs.sceneCollections ?? null,
      sceneCollection: obs.sceneCollection ?? null,
      inputs: obs.inputs ?? null,
      outputs: stableOutputs(obs.outputs),
      transitions: obs.transitions ?? null,
      hotkeys: obs.hotkeys ?? null,
      canvases: obs.canvases ?? null,
      specialInputs: obs.specialInputs ?? null,
      monitors: obs.monitors ?? null,
      displayProfiles: obs.displayProfiles ?? (obs.displayProfile ? [obs.displayProfile] : []),
    },
  };
  return stableDecisionValue(surface) as JsonObject;
}

function differenceValue(value: unknown): JsonValue {
  return value === undefined ? null : value as JsonValue;
}

export function diffJson(before: unknown, after: unknown, currentPath = ""): JsonObject[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  const beforeArray = Array.isArray(before);
  const afterArray = Array.isArray(after);
  if (beforeArray || afterArray) {
    if (!beforeArray || !afterArray) {
      return [{ path: currentPath || "$", change: "changed", before: differenceValue(before), after: differenceValue(after) }];
    }
    const beforePrimitive = before.every((item) => item === null || typeof item !== "object");
    const afterPrimitive = after.every((item) => item === null || typeof item !== "object");
    if (beforePrimitive && afterPrimitive) {
      const left = new Map(before.map((item) => [canonicalJson(item), item]));
      const right = new Map(after.map((item) => [canonicalJson(item), item]));
      const differences: JsonObject[] = [];
      for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
        const childPath = `${currentPath || "$"}[value=${key}]`;
        if (!left.has(key)) differences.push({ path: childPath, change: "added", before: null, after: differenceValue(right.get(key)) });
        else if (!right.has(key)) differences.push({ path: childPath, change: "removed", before: differenceValue(left.get(key)), after: null });
      }
      return differences;
    }
    const identityKeys = ["inputName", "outputName", "sceneName", "sourceName", "filterName", "transitionName", "canvasName", "name", "id"];
    const identity = (item: unknown): string | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const object = item as Record<string, unknown>;
      const key = identityKeys.find((candidate) => object[candidate] !== undefined && object[candidate] !== null);
      return key ? `${key}=${String(object[key])}` : null;
    };
    const beforeIdentities = before.map(identity);
    const afterIdentities = after.map(identity);
    if (beforeIdentities.every(Boolean) && afterIdentities.every(Boolean)) {
      const left = new Map(beforeIdentities.map((key, index) => [String(key), before[index]]));
      const right = new Map(afterIdentities.map((key, index) => [String(key), after[index]]));
      if (left.size === before.length && right.size === after.length) {
        const differences: JsonObject[] = [];
        for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
          const childPath = `${currentPath || "$"}[${key}]`;
          if (!left.has(key)) differences.push({ path: childPath, change: "added", before: null, after: differenceValue(right.get(key)) });
          else if (!right.has(key)) differences.push({ path: childPath, change: "removed", before: differenceValue(left.get(key)), after: null });
          else differences.push(...diffJson(left.get(key), right.get(key), childPath));
        }
        return differences;
      }
    }
    const differences: JsonObject[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${currentPath || "$"}[${index}]`;
      if (index >= before.length) differences.push({ path: childPath, change: "added", before: null, after: differenceValue(after[index]) });
      else if (index >= after.length) differences.push({ path: childPath, change: "removed", before: differenceValue(before[index]), after: null });
      else differences.push(...diffJson(before[index], after[index], childPath));
    }
    return differences;
  }

  const beforeObject = before && typeof before === "object";
  const afterObject = after && typeof after === "object";
  if (beforeObject || afterObject) {
    if (!beforeObject || !afterObject) {
      return [{ path: currentPath || "$", change: "changed", before: differenceValue(before), after: differenceValue(after) }];
    }
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const differences: JsonObject[] = [];
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      if (!(key in left)) differences.push({ path: childPath, change: "added", before: null, after: differenceValue(right[key]) });
      else if (!(key in right)) differences.push({ path: childPath, change: "removed", before: differenceValue(left[key]), after: null });
      else differences.push(...diffJson(left[key], right[key], childPath));
    }
    return differences;
  }
  return [{ path: currentPath || "$", change: "changed", before: differenceValue(before), after: differenceValue(after) }];
}

async function writeJsonAtomic(target: string, payload: unknown): Promise<void> {
  const redacted = redactUnknown(payload);
  if (containsSecretMarker(redacted)) throw new Error(`Refusing to write secret-like content to ${target}`);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(target, { force: true });
    await rename(temporary, target).catch(async () => {
      await rm(temporary, { force: true });
      throw error;
    });
  }
}

export async function persistAuditDocument(stateDir: string, document: JsonObject): Promise<JsonObject> {
  if (document.kind !== AUDIT_KIND || document.version !== AUDIT_VERSION) throw new Error("Invalid Legends OBS audit document");
  const machineKey = safeName(String(document.machineKey));
  const machineDirectory = path.join(stateDir, "audits", machineKey);
  const snapshotsDirectory = path.join(machineDirectory, "snapshots");
  await mkdir(snapshotsDirectory, { recursive: true });
  const target = path.join(snapshotsDirectory, `${stamp(new Date(String(document.capturedAt)))}-${safeName(String(document.reason))}.json`);
  await writeJsonAtomic(target, document);

  const hashes = document.hashes as JsonObject;
  const pointer = {
    kind: POINTER_KIND,
    version: AUDIT_VERSION,
    machineKey,
    updatedAt: document.capturedAt,
    classification: document.classification,
    target: path.relative(machineDirectory, target),
    settingsHash: hashes.settings,
    capabilitiesHash: hashes.capabilities,
  };
  const latestPointerPath = path.join(machineDirectory, "latest.json");
  await writeJsonAtomic(latestPointerPath, pointer);

  let lastKnownGoodPointerPath: string | null = null;
  if (document.classification === "verified-good") {
    lastKnownGoodPointerPath = path.join(machineDirectory, "last-known-good.json");
    await writeJsonAtomic(lastKnownGoodPointerPath, pointer);
  }
  return { auditPath: target, latestPointerPath, lastKnownGoodPointerPath };
}

async function verifiedCanary(stateDir: string, verification: AuditCaptureOptions["verification"]): Promise<JsonObject | null> {
  if (!verification) return null;
  const receiptRoot = path.resolve(stateDir, "receipts");
  const receiptPath = path.resolve(verification.receiptPath);
  if (receiptPath !== receiptRoot && !receiptPath.startsWith(`${receiptRoot}${path.sep}`)) {
    throw new Error("Verified-good audits require a canary receipt from this kit state directory");
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as JsonObject;
  if (receipt.ok !== true || receipt.classification !== "WORKS" || receipt.command !== "record:canary") {
    throw new Error("Last-known-good can only advance from a passing record:canary receipt");
  }
  if (verification.canary.ok !== true || verification.canary.classification !== "WORKS") {
    throw new Error("Canary result does not qualify as verified-good");
  }
  return {
    receiptPath,
    completedAt: receipt.completedAt ?? null,
    outputPath: receipt.outputPath ?? null,
    actual: receipt.actual ?? null,
    checks: receipt.checks ?? null,
  };
}

export async function captureAudit(
  client: ObsWebSocketClient,
  config: KitConfig,
  preset: ObsPreset,
  options: AuditCaptureOptions,
): Promise<JsonObject> {
  const verification = await verifiedCanary(config.stateDir, options.verification);
  const inventory = await collectInventory(client, config, preset);
  const machine = inventory.machine as JsonObject;
  const obs = inventory.obs as JsonObject;
  const machineKey = buildMachineKey(machine);
  const decisionSurface = buildDecisionSurface(inventory);
  const capturedAt = String(inventory.capturedAt);
  const document = {
    kind: AUDIT_KIND,
    version: AUDIT_VERSION,
    capturedAt,
    reason: options.reason,
    classification: verification ? "verified-good" : "observed",
    machineKey,
    coverage: {
      completeFor: [
        "hardware and software fingerprint",
        "current OBS profile, video, output, encoder, scene, source, filter, audio-routing, and monitor settings exposed by OBS WebSocket and local profile files",
        "installed input/filter/transition kinds and defaults exposed by OBS WebSocket",
        "loaded modules plus video/audio encoders reported by the active OBS log",
      ],
      deliberatelyExcluded: [
        "stream-service credentials and stream keys",
        "plugin-private settings not exposed by OBS WebSocket",
        "UI-only choice enumerations that OBS WebSocket does not publish",
      ],
    },
    hashes: {
      hardware: hashJson((decisionSurface.hardware as JsonObject) ?? {}),
      capabilities: hashJson(obs.capabilities ?? {}),
      settings: hashJson(decisionSurface),
    },
    verification,
    decisionSurface,
    inventory,
  } as unknown as JsonObject;
  const paths = await persistAuditDocument(config.stateDir, document);
  const hashes = document.hashes as JsonObject;
  return {
    ok: true,
    command: "audit:capture",
    machineKey,
    capturedAt,
    reason: options.reason,
    classification: document.classification,
    hashes,
    coverage: document.coverage,
    auditPath: stateRelative(config.stateDir, paths.auditPath),
    latestPointerPath: stateRelative(config.stateDir, paths.latestPointerPath),
    lastKnownGoodPointerPath: stateRelative(config.stateDir, paths.lastKnownGoodPointerPath),
  };
}

async function readPointer(machineDirectory: string, pointerName: string): Promise<JsonObject | null> {
  const pointerPath = path.join(machineDirectory, `${pointerName}.json`);
  try {
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as JsonObject;
    if (pointer.kind !== POINTER_KIND || pointer.version !== AUDIT_VERSION) throw new Error(`Invalid audit pointer: ${pointerPath}`);
    const target = path.resolve(machineDirectory, String(pointer.target));
    if (target !== machineDirectory && !target.startsWith(`${machineDirectory}${path.sep}`)) throw new Error(`Audit pointer escapes machine directory: ${pointerPath}`);
    const document = JSON.parse(await readFile(target, "utf8")) as JsonObject;
    if (document.kind !== AUDIT_KIND || document.version !== AUDIT_VERSION) throw new Error(`Invalid audit target: ${target}`);
    return { pointerPath, target, pointer, document };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function pointerSummary(entry: JsonObject | null): JsonValue {
  if (!entry) return null;
  const pointer = entry.pointer as JsonObject;
  const document = entry.document as JsonObject;
  return {
    capturedAt: document.capturedAt,
    reason: document.reason,
    classification: document.classification,
    settingsHash: pointer.settingsHash,
    capabilitiesHash: pointer.capabilitiesHash,
    auditPath: `snapshots/${path.basename(String(entry.target))}`,
    pointerPath: path.basename(String(entry.pointerPath)),
  };
}

export async function readAuditStatus(stateDir: string): Promise<JsonObject> {
  const root = path.join(stateDir, "audits");
  let machineNames: string[] = [];
  try {
    machineNames = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const machines = await Promise.all(machineNames.map(async (machineKey) => {
    const directory = path.join(root, machineKey);
    const [latest, lastKnownGood] = await Promise.all([
      readPointer(directory, "latest"),
      readPointer(directory, "last-known-good"),
    ]);
    return { machineKey: publicMachineKey(machineKey), latest: pointerSummary(latest), lastKnownGood: pointerSummary(lastKnownGood) };
  }));
  return {
    ok: machines.length > 0,
    initialized: machines.length > 0,
    machineCount: machines.length,
    machines,
  };
}

export async function verifyAudits(stateDir: string): Promise<JsonObject> {
  const root = path.join(stateDir, "audits");
  let machineNames: string[] = [];
  try {
    machineNames = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const failures: string[] = [];
  let count = 0;
  for (const machineKey of machineNames) {
    const machineDirectory = path.join(root, machineKey);
    const snapshotsDirectory = path.join(machineDirectory, "snapshots");
    let files: string[] = [];
    try {
      files = (await readdir(snapshotsDirectory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      failures.push(`${snapshotsDirectory}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const name of files) {
      const file = path.join(snapshotsDirectory, name);
      count += 1;
      try {
        const document = JSON.parse(await readFile(file, "utf8")) as JsonObject;
        if (document.kind !== AUDIT_KIND || document.version !== AUDIT_VERSION) throw new Error("invalid schema");
        if (document.machineKey !== machineKey) throw new Error("machine key mismatch");
        if (containsSecretMarker(document)) throw new Error("secret-like value");
        const hashes = document.hashes as JsonObject;
        const decisionSurface = document.decisionSurface as JsonObject;
        const obs = (document.inventory as JsonObject).obs as JsonObject;
        if (hashJson(decisionSurface) !== hashes.settings) throw new Error("settings hash mismatch");
        if (hashJson(decisionSurface.hardware ?? {}) !== hashes.hardware) throw new Error("hardware hash mismatch");
        if (hashJson(obs.capabilities ?? {}) !== hashes.capabilities) throw new Error("capabilities hash mismatch");
      } catch (error) {
        failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const pointerName of ["latest", "last-known-good"]) {
      try {
        const entry = await readPointer(machineDirectory, pointerName);
        if (!entry && pointerName === "latest" && files.length > 0) failures.push(`${machineDirectory}: missing latest pointer`);
        if (entry) {
          const pointer = entry.pointer as JsonObject;
          const document = entry.document as JsonObject;
          const hashes = document.hashes as JsonObject;
          if (pointer.settingsHash !== hashes.settings || pointer.capabilitiesHash !== hashes.capabilities) {
            failures.push(`${String(entry.pointerPath)}: pointer hash mismatch`);
          }
          if (pointerName === "last-known-good" && document.classification !== "verified-good") {
            failures.push(`${String(entry.pointerPath)}: target is not verified-good`);
          }
        }
      } catch (error) {
        failures.push(`${machineDirectory}\\${pointerName}.json: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { ok: failures.length === 0, machineCount: machineNames.length, count, failures };
}

export async function showAudit(stateDir: string, which: "latest" | "good", requestedMachine?: string): Promise<JsonObject> {
  const root = path.join(stateDir, "audits");
  let machineNames: string[] = [];
  try {
    machineNames = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const requestedKey = requestedMachine ? safeName(requestedMachine) : null;
  const machineKey = requestedKey
    ? machineNames.find((name) => name === requestedKey || publicMachineKey(name) === requestedKey) ?? null
    : machineNames.length === 1 ? machineNames[0] : null;
  if (!machineKey) throw new Error(machineNames.length === 0 ? "No audit ledger exists; run audit:capture" : "Multiple machine ledgers exist; pass --machine <machine-key>");
  const pointerName = which === "latest" ? "latest" : "last-known-good";
  const entry = await readPointer(path.join(root, machineKey), pointerName);
  if (!entry) throw new Error(`No ${pointerName} audit exists for ${machineKey}`);
  const document = entry.document as JsonObject;
  return {
    ok: true,
    command: "audit:show",
    machineKey: publicMachineKey(machineKey),
    which,
    auditPath: stateRelative(stateDir, entry.target),
    capturedAt: document.capturedAt,
    reason: document.reason,
    classification: document.classification,
    hashes: document.hashes,
    coverage: document.coverage,
    verification: document.verification,
    decisionSurface: document.decisionSurface,
  };
}

export async function compareAudit(
  client: ObsWebSocketClient,
  config: KitConfig,
  preset: ObsPreset,
  against: "latest" | "good",
): Promise<JsonObject> {
  const inventory = await collectInventory(client, config, preset);
  const machineKey = buildMachineKey(inventory.machine as JsonObject);
  const machineDirectory = path.join(config.stateDir, "audits", machineKey);
  const pointerName = against === "latest" ? "latest" : "last-known-good";
  const baseline = await readPointer(machineDirectory, pointerName);
  if (!baseline) throw new Error(`No ${pointerName} audit exists for ${machineKey}; run audit:capture, then a passing record:canary for last-known-good`);
  const document = baseline.document as JsonObject;
  const expectedSurface = document.decisionSurface as JsonObject;
  const expectedHash = String((document.hashes as JsonObject).settings);
  if (hashJson(expectedSurface) !== expectedHash) throw new Error(`Audit integrity check failed: ${String(baseline.target)}`);
  const currentSurface = buildDecisionSurface(inventory);
  const differences = diffJson(expectedSurface, currentSurface);
  return {
    ok: differences.length === 0,
    command: "audit:diff",
    classification: differences.length === 0 ? "MATCH" : "DRIFT",
    machineKey,
    against,
    baselinePath: stateRelative(config.stateDir, baseline.target),
    baselineCapturedAt: document.capturedAt,
    baselineClassification: document.classification,
    baselineHash: expectedHash,
    currentHash: hashJson(currentSurface),
    differenceCount: differences.length,
    differences: differences.slice(0, 250),
    truncated: differences.length > 250,
  };
}
