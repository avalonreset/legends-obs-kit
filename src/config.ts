import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface KitConfig {
  repoRoot: string;
  obsConfigRoot: string;
  websocketConfigPath: string;
  stateDir: string;
  ffprobePath: string;
  dryRun: boolean;
  requirePrimaryMicrophone: boolean;
  host: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): KitConfig {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..");
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const obsConfigRoot = path.resolve(env.LEGENDS_OBS_CONFIG_ROOT || path.join(appData, "obs-studio"));
  const legacyStateDir = path.join(repoRoot, ".legends-obs-kit");
  const defaultStateDir = existsSync(legacyStateDir)
    ? legacyStateDir
    : path.join(localAppData, "LegendsOBSKit", "state");
  const stateDir = path.resolve(env.LEGENDS_OBS_STATE_DIR || defaultStateDir);
  return {
    repoRoot,
    obsConfigRoot,
    websocketConfigPath: path.join(obsConfigRoot, "plugin_config", "obs-websocket", "config.json"),
    stateDir,
    ffprobePath: env.LEGENDS_OBS_FFPROBE_PATH || "ffprobe",
    dryRun: String(env.LEGENDS_OBS_DRY_RUN ?? "true").toLowerCase() !== "false",
    requirePrimaryMicrophone: String(env.LEGENDS_OBS_REQUIRE_PRIMARY_MICROPHONE ?? "false").toLowerCase() === "true",
    host: "127.0.0.1",
  };
}
