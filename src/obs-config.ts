import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { JsonObject } from "./types.js";

export interface ObsWebSocketConfig {
  server_enabled: boolean;
  server_port: number;
  auth_required: boolean;
  server_password?: string;
}

export async function readObsWebSocketConfig(file: string): Promise<ObsWebSocketConfig> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ObsWebSocketConfig>;
  if (typeof parsed.server_port !== "number") throw new Error(`Invalid OBS WebSocket config: ${file}`);
  return {
    server_enabled: parsed.server_enabled === true,
    server_port: parsed.server_port,
    auth_required: parsed.auth_required === true,
    server_password: typeof parsed.server_password === "string" ? parsed.server_password : undefined,
  };
}

export function publicWebSocketConfig(config: ObsWebSocketConfig): JsonObject {
  return {
    serverEnabled: config.server_enabled,
    port: config.server_port,
    authenticationRequired: config.auth_required,
    passwordPresent: Boolean(config.server_password),
  };
}

export async function resolveProfileDirectory(obsConfigRoot: string, profileName: string): Promise<string> {
  const profilesRoot = path.join(obsConfigRoot, "basic", "profiles");
  const entries = await readdir(profilesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(profilesRoot, entry.name);
    try {
      const ini = await readFile(path.join(directory, "basic.ini"), "utf8");
      if (readIniValue(ini, "General", "Name") === profileName) return directory;
    } catch {
      // Ignore incomplete profile folders and continue resolving by declared name.
    }
  }
  throw new Error(`Could not resolve OBS profile directory for ${profileName}`);
}

export async function readRecordEncoderSettings(obsConfigRoot: string, profileName: string): Promise<JsonObject | null> {
  const directory = await resolveProfileDirectory(obsConfigRoot, profileName);
  try {
    return JSON.parse(await readFile(path.join(directory, "recordEncoder.json"), "utf8")) as JsonObject;
  } catch {
    return null;
  }
}

export async function readProfileIniSettings(obsConfigRoot: string, profileName: string): Promise<JsonObject | null> {
  const directory = await resolveProfileDirectory(obsConfigRoot, profileName);
  try {
    return parseIni(await readFile(path.join(directory, "basic.ini"), "utf8"));
  } catch {
    return null;
  }
}

export async function readGlobalIniSettings(obsConfigRoot: string): Promise<JsonObject | null> {
  try {
    return parseIni(await readFile(path.join(obsConfigRoot, "global.ini"), "utf8"));
  } catch {
    return null;
  }
}

export async function latestObsLog(obsConfigRoot: string): Promise<string | null> {
  const logsRoot = path.join(obsConfigRoot, "logs");
  try {
    const entries = (await readdir(logsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return entries[0] ? path.join(logsRoot, entries[0]) : null;
  } catch {
    return null;
  }
}

export async function readDisplayProfilesFromLatestLog(obsConfigRoot: string): Promise<JsonObject[]> {
  const file = await latestObsLog(obsConfigRoot);
  if (!file) return [];
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const starts = lines
    .map((line, index) => ({ index, match: /output (\d+):\s*$/.exec(line) }))
    .filter((entry) => entry.match !== null);
  return starts.map((entry, position) => {
    const end = starts[position + 1]?.index ?? Math.min(lines.length, entry.index + 20);
    const block = lines.slice(entry.index + 1, end).join("\n");
    const value = (name: string): string | null => {
      const match = new RegExp(`${name}=([^\\r\\n]+)`).exec(block);
      return match?.[1]?.trim() ?? null;
    };
    const bits = Number(value("bits_per_color"));
    const refresh = Number(value("refresh"));
    return {
      index: Number(entry.match?.[1]),
      name: value("name"),
      size: value("size"),
      refresh: Number.isFinite(refresh) ? refresh : null,
      bitsPerColor: Number.isFinite(bits) ? bits : null,
      colorSpace: value("space"),
      sdrWhiteNits: value("sdr_white_nits"),
      nitRange: value("nit_range"),
      dpi: value("dpi"),
      sourceLog: file,
    };
  });
}

export async function readDisplayProfileFromLatestLog(obsConfigRoot: string): Promise<JsonObject | null> {
  return (await readDisplayProfilesFromLatestLog(obsConfigRoot))[0] ?? null;
}

export async function readObsCapabilitiesFromLatestLog(obsConfigRoot: string): Promise<JsonObject | null> {
  const file = await latestObsLog(obsConfigRoot);
  if (!file) return null;
  const rawLines = (await readFile(file, "utf8")).split(/\r?\n/);
  const lines = rawLines.map((line) => line.replace(/^\d{2}:\d{2}:\d{2}\.\d+:\s*/, "").trim());

  const loadedModules: string[] = [];
  const loadedStart = lines.findIndex((line) => line === "Loaded Modules:");
  if (loadedStart >= 0) {
    for (const line of lines.slice(loadedStart + 1)) {
      if (/^-{5,}$/.test(line)) break;
      if (/\.dll$/i.test(line)) loadedModules.push(line);
    }
  }

  const encoders = { video: [] as JsonObject[], audio: [] as JsonObject[] };
  const encoderStart = lines.findIndex((line) => line === "Available Encoders:");
  if (encoderStart >= 0) {
    let section: "video" | "audio" | null = null;
    for (const line of lines.slice(encoderStart + 1)) {
      if (/^Video Encoders:$/.test(line)) {
        section = "video";
        continue;
      }
      if (/^Audio Encoders:$/.test(line)) {
        section = "audio";
        continue;
      }
      if (/^=+ Startup complete/.test(line)) break;
      const match = /^-\s+(\S+)\s+\((.+)\)$/.exec(line);
      if (section && match) encoders[section].push({ id: match[1], name: match[2] });
    }
  }

  const failedModules = rawLines.flatMap((line) => {
    const match = /Failed to (?:initialize|load)(?: module)? '([^']+)'/i.exec(line);
    return match ? [match[1]] : [];
  });
  const nvencLine = rawLines.find((line) => /\[obs-nvenc].*NVENC version:/i.test(line));
  const nvencMatch = nvencLine
    ? /NVENC version:\s*([^ ]+)\s*\(compiled\)\s*\/\s*([^ ]+)\s*\(driver\),\s*CUDA driver version:\s*([^,]+),\s*AV1 supported:\s*(true|false)/i.exec(nvencLine)
    : null;

  return {
    sourceLog: file,
    loadedModules: [...new Set(loadedModules)].sort(),
    failedModules: [...new Set(failedModules)].sort(),
    encoders,
    nvenc: nvencMatch ? {
      compiledVersion: nvencMatch[1],
      driverVersion: nvencMatch[2],
      cudaDriverVersion: nvencMatch[3].trim(),
      av1Supported: nvencMatch[4].toLowerCase() === "true",
    } : null,
  };
}

export function parseIni(text: string): JsonObject {
  const result: JsonObject = {};
  let section = "__root__";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (!result[section]) result[section] = {};
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    if (!result[section]) result[section] = {};
    (result[section] as JsonObject)[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

export function readIniValue(text: string, section: string, key: string): string | undefined {
  let active = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch) {
      active = sectionMatch[1];
      continue;
    }
    if (active !== section) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() === key) return line.slice(separator + 1).trim();
  }
  return undefined;
}
