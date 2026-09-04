#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs, flagNumber, flagString, isConfirmed } from "./args.js";
import { bindAudioInput, buildAudioBindPlan, getAudioInputStatus, getPrimaryMicrophoneStatus } from "./audio.js";
import { captureAudit, compareAudit, readAuditStatus, showAudit, verifyAudits } from "./audit.js";
import { runCanary, waitForRecordStart } from "./canary.js";
import { resolveConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { CLI_NAME, DEFAULT_PRESET_ID, VERSION } from "./identity.js";
import { collectInventory } from "./inventory.js";
import { buildAgentContext, buildManifest } from "./manifest.js";
import { latestObsLog, readObsWebSocketConfig } from "./obs-config.js";
import { assertOutputsIdle, getOutputActivity, ObsWebSocketClient } from "./obs-websocket.js";
import { output } from "./output.js";
import { applyPreset, buildProfilePlan, captureProfileSnapshot, loadPreset, refreshVideoPipeline, rollbackSnapshot, showProfile } from "./profile.js";
import { listReceiptFiles, verifyReceipts, writeReceipt } from "./receipts.js";
import { redactText } from "./redact.js";
import type { JsonObject, JsonValue, ParsedArgs } from "./types.js";
import {
  defaultVisionSwitchState,
  applyRenameStepsTransactional,
  evaluateVisionTick,
  inventoryFromLiveSnapshot,
  loadVisionSwitchState,
  markCutApplied,
  panelToPair,
  planSceneApply,
  planSceneGraph,
  planVisionCut,
  resolveDaemonOptions,
  sampleActivePanelFromShell,
  sampleFromPanelFlag,
  saveVisionSwitchState,
  sleepInterval,
  type Panel,
  type VisionSwitchState,
} from "./vision-switch.js";

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

const LIVE_COMMANDS = new Set([
  "status",
  "inventory",
  "audio:status",
  "audio:plan",
  "audio:bind",
  "audit:capture",
  "audit:diff",
  "profile:show",
  "profile:plan",
  "profile:backup",
  "profile:apply",
  "profile:rollback",
  "profile:refresh",
  "record:status",
  "record:start",
  "record:stop",
  "record:canary",
]);

main().catch((error: unknown) => {
  console.error(redactText(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();

  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
      console.log(`${CLI_NAME} ${VERSION}`);
      return;
    case "manifest":
      output(buildManifest(), args);
      return;
    case "agent:context":
      output(buildAgentContext(), args);
      return;
    case "doctor": {
      const result = await runDoctor(config);
      output(result, args);
      if (result.ok !== true) process.exitCode = 1;
      return;
    }
    case "receipts:list":
      output({ ok: true, receipts: await listReceiptFiles(config.stateDir) }, args);
      return;
    case "receipts:verify": {
      const result = await verifyReceipts(config.stateDir);
      output(result, args);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "audit:status":
      output(await readAuditStatus(config.stateDir), args);
      return;
    case "audit:verify": {
      const result = await verifyAudits(config.stateDir);
      output(result, args);
      if (result.ok !== true) process.exitCode = 1;
      return;
    }
    case "audit:show": {
      const requested = flagString(args, "which") ?? "good";
      if (requested !== "latest" && requested !== "good") throw new Error("audit:show --which must be latest or good");
      output(await showAudit(config.stateDir, requested, flagString(args, "machine")), args);
      return;
    }
    case "logs:latest": {
      const file = await latestObsLog(config.obsConfigRoot);
      const lines = file ? (await readFile(file, "utf8")).split(/\r?\n/).filter((line) => /NVENC|record|encoder|websocket|error|failed/i.test(line)).slice(-120).map(redactText) : [];
      output({ ok: Boolean(file), file, lines }, args);
      return;
    }
    case "vision-switch:scene-plan": {
      const current = flagString(args, "current-scene") ?? "panel-ab";
      output({
        ok: true,
        command: "vision-switch:scene-plan",
        graph: planSceneGraph(current),
        resolutionPolicy: "Preserve source pixels by default; any Windows display-mode change requires explicit operator approval; never auto-stretch to fill.",
      }, args);
      return;
    }
    case "vision-switch:arm":
    case "vision-switch:disarm":
    case "vision-switch:freeze":
    case "vision-switch:unfreeze": {
      const state = await loadVisionSwitchState(config.stateDir);
      if (args.command === "vision-switch:arm") state.armed = true;
      if (args.command === "vision-switch:disarm") state.armed = false;
      if (args.command === "vision-switch:freeze") state.frozen = true;
      if (args.command === "vision-switch:unfreeze") state.frozen = false;
      const statePath = await saveVisionSwitchState(config.stateDir, state);
      const receiptPath = await writeReceipt(config.stateDir, args.command, {
        ok: true,
        command: args.command,
        armed: state.armed,
        frozen: state.frozen,
        statePath,
      });
      output({
        ok: true,
        command: args.command,
        armed: state.armed,
        frozen: state.frozen,
        dryRunDefault: true,
        note: "Arm enables cuts only when LEGENDS_OBS_DRY_RUN=false and --confirm on tick/daemon. Default remains disarmed/dry.",
        statePath,
        receiptPath,
      }, args);
      return;
    }
    case "vision-switch:status": {
      const state = await loadVisionSwitchState(config.stateDir);
      let sample = null as Awaited<ReturnType<typeof resolveVisionSample>> | null;
      let sampleError: string | null = null;
      try {
        sample = await resolveVisionSample(args, { preferShell: true });
      } catch (error) {
        sampleError = error instanceof Error ? error.message : String(error);
      }
      // Prefer live scene when OBS is up; fall back to offline status.
      try {
        await withClient(config, async (client) => {
          const scene = await client.request("GetCurrentProgramScene");
          const currentScene = String(scene.currentProgramSceneName ?? "");
          const plan = sample
            ? planVisionCut({
                sample,
                state,
                currentProgramScene: currentScene,
                dryRun: config.dryRun !== false,
              })
            : null;
          output({
            ok: true,
            command: "vision-switch:status",
            mode: "live",
            state,
            sample: publicVisionSample(sample, args),
            sampleError,
            currentProgramScene: currentScene,
            plan,
            cutLoop: "deterministic-shell-geometry",
            llmInCutLoop: false,
            forceSecondary4k: false,
          }, args);
        });
      } catch (error) {
        output({
          ok: true,
          command: "vision-switch:status",
          mode: "offline",
          state,
          sample: publicVisionSample(sample, args),
          sampleError,
          obsError: error instanceof Error ? error.message : String(error),
          llmInCutLoop: false,
          forceSecondary4k: false,
        }, args);
      }
      return;
    }
    case "vision-switch:plan": {
      const state = await mergeStateFlags(await loadVisionSwitchState(config.stateDir), args);
      const sample = await resolveVisionSample(args, { preferShell: true });
      const currentSceneFlag = flagString(args, "current-scene");
      if (currentSceneFlag || flagString(args, "panel")) {
        // Offline-friendly when panel or scene forced
        if (currentSceneFlag && flagString(args, "panel")) {
          const plan = planVisionCut({
            sample,
            state,
            currentProgramScene: currentSceneFlag,
            dryRun: true,
          });
          output({ ok: true, command: "vision-switch:plan", mode: "offline", sample: publicVisionSample(sample, args), plan, state }, args);
          return;
        }
      }
      try {
        await withClient(config, async (client) => {
          const scene = await client.request("GetCurrentProgramScene");
          const currentScene = String(scene.currentProgramSceneName ?? "");
          const tick = evaluateVisionTick({
            sample,
            state,
            currentProgramScene: currentScene,
            dryRun: true,
            authorized: false,
          });
          output({
            ok: true,
            command: "vision-switch:plan",
            mode: "live-sample",
            dryRun: true,
            sample: publicVisionSample(tick.sample, args),
            plan: tick.plan,
            state: tick.state,
            note: "Dry plan only. No WS mutation. Arm + live + --confirm required for cuts.",
          }, args);
        });
      } catch {
        const plan = planVisionCut({
          sample,
          state,
          currentProgramScene: currentSceneFlag ?? state.lastScene ?? "panel-ab",
          dryRun: true,
        });
        output({ ok: true, command: "vision-switch:plan", mode: "offline-fallback", sample: publicVisionSample(sample, args), plan, state }, args);
      }
      return;
    }
    case "vision-switch:scene-apply": {
      await withClient(config, async (client) => routeLiveCommand(client, config, args));
      return;
    }
    case "vision-switch:tick": {
      await withClient(config, async (client) => routeLiveCommand(client, config, args));
      return;
    }
    case "vision-switch:daemon": {
      await runVisionDaemon(config, args);
      return;
    }
    default: {
      if (!LIVE_COMMANDS.has(args.command)) throw new Error(`Unknown command: ${args.command}. Run ${CLI_NAME} help.`);
      await withClient(config, async (client) => routeLiveCommand(client, config, args));
    }
  }
}

async function withClient<T>(config: ReturnType<typeof resolveConfig>, action: (client: ObsWebSocketClient) => Promise<T>): Promise<T> {
  const wsConfig = await readObsWebSocketConfig(config.websocketConfigPath);
  const client = await ObsWebSocketClient.connect(config.host, wsConfig);
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

async function routeLiveCommand(client: ObsWebSocketClient, config: ReturnType<typeof resolveConfig>, args: ParsedArgs): Promise<void> {
  const presetFlag = flagString(args, "preset");
  const explicitPresetCommands = new Set(["profile:show", "profile:plan", "profile:backup", "profile:apply", "profile:refresh", "record:canary"]);
  if (explicitPresetCommands.has(args.command) && !presetFlag) {
    throw new Error(`${args.command} requires an explicit --preset <id>`);
  }
  const preset = await loadPreset(config, presetFlag ?? DEFAULT_PRESET_ID);
  switch (args.command) {
    case "status": {
      const [version, stats, profiles, activity, recording] = await Promise.all([
        client.request("GetVersion"),
        client.request("GetStats"),
        client.request("GetProfileList"),
        getOutputActivity(client),
        client.request("GetRecordStatus"),
      ]);
      output({
        ok: true,
        version: {
          obsVersion: version.obsVersion,
          obsWebSocketVersion: version.obsWebSocketVersion,
          rpcVersion: version.rpcVersion,
          platform: version.platform,
          platformDescription: version.platformDescription,
        },
        profile: profiles.currentProfileName,
        activity,
        recording,
        stats,
      }, args);
      return;
    }
    case "inventory": {
      const inventory = await collectInventory(client, config, preset);
      output(flagBool(args, "full") ? inventory : summarizeInventory(inventory), args);
      return;
    }
    case "audio:status": {
      const inputName = flagString(args, "input");
      const status = inputName ? await getAudioInputStatus(client, inputName) : await getPrimaryMicrophoneStatus(client);
      output(flagBool(args, "include-devices") ? status : summarizeAudioStatus(status), args);
      return;
    }
    case "audio:plan": {
      const inputName = flagString(args, "input") ?? "Mic/Aux";
      const device = flagString(args, "device");
      if (!device) throw new Error("audio:plan requires --device <name-or-id>");
      output(await buildAudioBindPlan(client, inputName, device), args);
      return;
    }
    case "audio:bind": {
      const inputName = flagString(args, "input") ?? "Mic/Aux";
      const device = flagString(args, "device");
      if (!device) throw new Error("audio:bind requires --device <name-or-id>");
      const plan = await buildAudioBindPlan(client, inputName, device);
      if (plan.noOp === true) {
        output({ ok: true, noOp: true, plan }, args);
        return;
      }
      if (!mutationAuthorized(config.dryRun, args)) {
        output({ ok: false, mutation: false, dryRun: config.dryRun, confirmed: isConfirmed(args), wouldBind: true, plan }, args);
        process.exitCode = 5;
        return;
      }
      output(await bindAudioInput(client, config, preset, inputName, device), args);
      return;
    }
    case "audit:capture":
      output(await captureAudit(client, config, preset, { reason: flagString(args, "reason") ?? "manual" }), args);
      return;
    case "audit:diff": {
      const requested = flagString(args, "against") ?? "good";
      if (requested !== "latest" && requested !== "good") throw new Error("audit:diff --against must be latest or good");
      const result = await compareAudit(client, config, preset, requested);
      output(result, args);
      if (result.ok !== true) process.exitCode = 2;
      return;
    }
    case "profile:show":
      output({ ok: true, preset: preset.id, profile: await showProfile(client, config, preset) }, args);
      return;
    case "profile:plan":
      output({ ok: true, dryRun: config.dryRun, plan: await buildProfilePlan(client, config, preset) }, args);
      return;
    case "profile:backup": {
      const backup = await captureProfileSnapshot(client, config, preset);
      const audit = await captureAudit(client, config, preset, { reason: "profile-backup" });
      const receiptPath = await writeReceipt(config.stateDir, "profile-backup", { ok: true, command: "profile:backup", snapshotPath: backup.path, profileName: backup.snapshot.profileName });
      output({ ok: true, snapshotPath: backup.path, audit, receiptPath }, args);
      return;
    }
    case "profile:apply": {
      const plan = await buildProfilePlan(client, config, preset);
      if (plan.ok === true) {
        const audit = await captureAudit(client, config, preset, { reason: "profile-apply-noop" });
        output({ ok: true, noOp: true, preset: preset.id, plan, audit }, args);
        return;
      }
      if (!mutationAuthorized(config.dryRun, args)) {
        output({ ok: false, mutation: false, dryRun: config.dryRun, confirmed: isConfirmed(args), wouldApply: true, plan }, args);
        process.exitCode = 5;
        return;
      }
      const beforeAudit = await captureAudit(client, config, preset, { reason: "pre-profile-apply" });
      try {
        const result = await applyPreset(client, config, preset);
        const afterAudit = await captureAudit(client, config, preset, { reason: "post-profile-apply" });
        output({ ...result, audits: { before: beforeAudit, after: afterAudit } }, args);
      } catch (error) {
        await captureAudit(client, config, preset, { reason: "profile-apply-failed-or-rolled-back" }).catch(() => null);
        throw error;
      }
      return;
    }
    case "profile:rollback": {
      const snapshot = flagString(args, "snapshot");
      if (!snapshot) throw new Error("profile:rollback requires --snapshot <path>");
      if (!mutationAuthorized(config.dryRun, args)) {
        output({ ok: false, mutation: false, dryRun: config.dryRun, confirmed: isConfirmed(args), wouldRollback: snapshot }, args);
        process.exitCode = 5;
        return;
      }
      const beforeAudit = await captureAudit(client, config, preset, { reason: "pre-profile-rollback" });
      const result = await rollbackSnapshot(client, config, snapshot);
      const afterAudit = await captureAudit(client, config, preset, { reason: "post-profile-rollback" });
      output({ ...result, audits: { before: beforeAudit, after: afterAudit } }, args);
      return;
    }
    case "profile:refresh": {
      if (!mutationAuthorized(config.dryRun, args)) return mutationPreview(args, config.dryRun, "profile:refresh");
      const beforeAudit = await captureAudit(client, config, preset, { reason: "pre-profile-refresh" });
      const result = await refreshVideoPipeline(client, config, preset);
      const afterAudit = await captureAudit(client, config, preset, { reason: "post-profile-refresh" });
      output({ ...result, audits: { before: beforeAudit, after: afterAudit } }, args);
      return;
    }
    case "record:status":
      output({ ok: true, status: await client.request("GetRecordStatus"), activity: await getOutputActivity(client) }, args);
      return;
    case "record:start": {
      if (!mutationAuthorized(config.dryRun, args)) return mutationPreview(args, config.dryRun, "record:start");
      await assertOutputsIdle(client);
      const microphone = await getPrimaryMicrophoneStatus(client);
      const requireMicrophone = config.requirePrimaryMicrophone || flagBool(args, "require-microphone");
      if (requireMicrophone && microphone.ok !== true) {
        throw new Error("Primary Mic/Aux is not recording-ready; run audio:status and audio:bind first");
      }
      let startError: unknown = null;
      try {
        await client.request("StartRecord");
      } catch (error) {
        startError = error;
      }
      let status: JsonObject;
      try {
        status = await waitForRecordStart(client);
      } catch (error) {
        if (startError) {
          throw new Error(`StartRecord failed and recording never became active: ${startError instanceof Error ? startError.message : String(startError)}`);
        }
        throw error;
      }
      const receiptPath = await writeReceipt(config.stateDir, "record-start", {
        ok: true,
        command: "record:start",
        status,
        requirements: { primaryMicrophone: requireMicrophone },
        primaryMicrophone: microphone,
      });
      output({ ok: true, status, requirements: { primaryMicrophone: requireMicrophone }, primaryMicrophone: microphone, receiptPath }, args);
      return;
    }
    case "record:stop": {
      if (!mutationAuthorized(config.dryRun, args)) return mutationPreview(args, config.dryRun, "record:stop");
      const before = await client.request("GetRecordStatus");
      if (before.outputActive !== true) {
        output({ ok: true, noOp: true, status: before }, args);
        return;
      }
      const stopped = await client.request("StopRecord");
      const receiptPath = await writeReceipt(config.stateDir, "record-stop", { ok: true, command: "record:stop", outputPath: stopped.outputPath });
      output({ ok: true, outputPath: stopped.outputPath, receiptPath }, args);
      return;
    }
    case "record:canary": {
      if (!mutationAuthorized(config.dryRun, args)) return mutationPreview(args, config.dryRun, "record:canary");
      let result: JsonObject;
      try {
        result = await runCanary(
          client,
          config,
          preset,
          flagNumber(args, "seconds", 8),
          config.requirePrimaryMicrophone || flagBool(args, "require-microphone"),
        );
      } catch (error) {
        const payload = {
          ok: false,
          classification: "BLOCKED",
          command: "record:canary",
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        const receiptPath = await writeReceipt(config.stateDir, "record-canary-blocked", payload);
        output({ ...payload, receiptPath }, args);
        process.exitCode = 1;
        return;
      }
      try {
        const audit = await captureAudit(client, config, preset, {
          reason: result.ok === true ? "record-canary-verified" : "record-canary-blocked",
          verification: result.ok === true ? { receiptPath: String(result.receiptPath), canary: result } : undefined,
        });
        output({ ...result, audit }, args);
      } catch (error) {
        output({
          ...result,
          audit: { ok: false, error: error instanceof Error ? error.message : String(error) },
          warning: "Recording proof completed, but the settings ledger capture failed; last-known-good was not advanced",
        }, args);
        process.exitCode = 1;
      }
      if (result.ok !== true) process.exitCode = 1;
      return;
    }
    case "vision-switch:scene-apply": {
      await executeVisionSceneApply(client, config, args);
      return;
    }
    case "vision-switch:tick": {
      await executeVisionTick(client, config, args);
      return;
    }
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

async function resolveVisionSample(
  args: ParsedArgs,
  options?: { preferShell?: boolean },
): Promise<ReturnType<typeof sampleFromPanelFlag>> {
  const panelRaw = (flagString(args, "panel") ?? "").toUpperCase();
  if (panelRaw === "A" || panelRaw === "B" || panelRaw === "C" || panelRaw === "D") {
    return sampleFromPanelFlag(panelRaw as Panel, {
      process: flagString(args, "process") ?? undefined,
      title: flagString(args, "title") ?? undefined,
    });
  }
  if (options?.preferShell !== false) {
    return await sampleActivePanelFromShell();
  }
  throw new Error("Provide --panel A|B|C|D or ensure Shell Get-ActivePanel is available");
}

function mergeStateFlags(state: VisionSwitchState, args: ParsedArgs): VisionSwitchState {
  const next = { ...state };
  if (flagBool(args, "armed") || flagBool(args, "arm")) next.armed = true;
  if (flagBool(args, "disarmed") || flagBool(args, "disarm")) next.armed = false;
  if (flagBool(args, "frozen") || flagBool(args, "freeze")) next.frozen = true;
  if (flagBool(args, "unfrozen") || flagBool(args, "unfreeze")) next.frozen = false;
  return next;
}

async function executeVisionSceneApply(
  client: ObsWebSocketClient,
  config: ReturnType<typeof resolveConfig>,
  args: ParsedArgs,
): Promise<void> {
  const sceneList = await client.request("GetSceneList");
  const inputList = await client.request("GetInputList");
  const activity = await getOutputActivity(client);
  let monitors: Array<{ monitorName?: string; monitorWidth?: number; monitorHeight?: number; monitorIndex?: number }> = [];
  try {
    const mon = await client.request("GetMonitorList");
    monitors = (mon.monitors as typeof monitors) ?? [];
  } catch {
    monitors = [];
  }
  const scenesRaw = (sceneList.scenes as Array<{ sceneName: string }>) ?? [];
  const scenes: Array<{ sceneName: string; items?: Array<{ sourceName: string; sceneItemEnabled?: boolean }> }> = [];
  for (const raw of scenesRaw) {
    try {
      const items = await client.request("GetSceneItemList", { sceneName: raw.sceneName });
      scenes.push({
        sceneName: String(raw.sceneName),
        items: ((items.sceneItems as Array<Record<string, unknown>>) ?? []).map((item) => ({
          sourceName: String(item.sourceName ?? ""),
          sceneItemEnabled: item.sceneItemEnabled === true,
        })),
      });
    } catch {
      scenes.push({ sceneName: String(raw.sceneName), items: [] });
    }
  }
  const inventory = inventoryFromLiveSnapshot({
    currentProgramScene: String(sceneList.currentProgramSceneName ?? ""),
    scenes,
    inputs: ((inputList.inputs as Array<{ inputName: string }>) ?? []).map((i) => ({ inputName: String(i.inputName) })),
    monitors,
    activity: {
      recording: activity.recording === true,
      streaming: activity.streaming === true,
    },
  });
  const plan = planSceneApply({ inventory, dryRun: true });
  const mode = (flagString(args, "mode") ?? "plan").toLowerCase();
  const goNote = flagString(args, "go");
  const wantLive = mode === "renames-only" || mode === "apply-renames";
  const authorized = mutationAuthorized(config.dryRun, args) && Boolean(goNote && goNote.trim());

  if (!wantLive || !authorized) {
    const receiptPath = await writeReceipt(config.stateDir, "vision-switch-scene-apply-plan", {
      ok: true,
      dryRun: true,
      mode,
      plan,
      activity,
      goNote: goNote ?? null,
      note: wantLive
        ? "Live renames require LEGENDS_OBS_DRY_RUN=false --confirm --go <note> --mode renames-only"
        : "Dry plan only. Scene create is human-checklist; renames are autoApplyable when authorized and idle.",
      llmInCutLoop: false,
      forceSecondary4k: false,
    });
    output({
      ok: true,
      command: "vision-switch:scene-apply",
      mutation: false,
      dryRun: true,
      mode,
      authorized: false,
      activity,
      plan,
      receiptPath,
      requirement:
        wantLive && !authorized
          ? "Set LEGENDS_OBS_DRY_RUN=false, pass --confirm, and --go <human-authorization-note>"
          : undefined,
      llmInCutLoop: false,
      forceSecondary4k: false,
    }, args);
    if (wantLive && !authorized) process.exitCode = 5;
    return;
  }

  if (activity.recording === true || activity.streaming === true) {
    const receiptPath = await writeReceipt(config.stateDir, "vision-switch-scene-apply-blocked", {
      ok: false,
      reason: "outputs_active",
      activity,
      goNote,
    });
    output({ ok: false, command: "vision-switch:scene-apply", mutation: false, reason: "outputs_active", activity, receiptPath }, args);
    process.exitCode = 1;
    return;
  }

  await assertOutputsIdle(client);
  if (plan.blockers.length > 0) {
    throw new Error(`Scene rename plan is blocked: ${plan.blockers.join(", ")}`);
  }
  const applied = await applyRenameStepsTransactional(client, plan.autoApplyable);

  const afterScene = await client.request("GetCurrentProgramScene");
  const afterInputs = await client.request("GetInputList");
  const afterScenes = await client.request("GetSceneList");
  const receiptPath = await writeReceipt(config.stateDir, "vision-switch-scene-apply", {
    ok: applied.every((a) => a.ok),
    goNote,
    mode: "renames-only",
    applied,
    readback: {
      currentProgramScene: afterScene.currentProgramSceneName,
      scenes: ((afterScenes.scenes as Array<{ sceneName: string }>) ?? []).map((x) => x.sceneName),
      inputs: ((afterInputs.inputs as Array<{ inputName: string }>) ?? []).map((x) => x.inputName),
    },
    humanChecklist: plan.humanChecklist,
    at: new Date().toISOString(),
    llmInCutLoop: false,
    forceSecondary4k: false,
  });
  output({
    ok: applied.every((a) => a.ok),
    command: "vision-switch:scene-apply",
    mutation: true,
    mode: "renames-only",
    goNote,
    applied,
    plan: { ...plan, dryRun: false },
    receiptPath,
    residual: "panel-cd creation and pixel-accurate placement remain an operator checklist; never auto-stretch",
    llmInCutLoop: false,
    forceSecondary4k: false,
  }, args);
  if (!applied.every((a) => a.ok)) process.exitCode = 1;
}
async function executeVisionTick(
  client: ObsWebSocketClient,
  config: ReturnType<typeof resolveConfig>,
  args: ParsedArgs,
): Promise<void> {
  const persisted = await loadVisionSwitchState(config.stateDir);
  const state = mergeStateFlags(persisted, args);
  // Explicit --arm on tick does not auto-persist; use vision-switch:arm for durable arm.
  const sample = await resolveVisionSample(args, { preferShell: true });
  const scene = await client.request("GetCurrentProgramScene");
  const currentScene = String(scene.currentProgramSceneName ?? "");
  const activity = await getOutputActivity(client);
  const outputsActive = Object.values(activity).some((v) => v === true);
  // Live cut requires dryRun=false AND --confirm (same gate as other mutations).
  const authorized = mutationAuthorized(config.dryRun, args) && state.armed && !state.frozen;
  const tick = evaluateVisionTick({
    sample,
    state,
    currentProgramScene: currentScene,
    dryRun: config.dryRun !== false || !authorized,
    authorized,
    outputsActive,
  });

  let nextState = tick.state;
  let receiptPath: string | undefined;
  let cut = false;

  if (tick.plan.wouldCut && authorized && config.dryRun === false) {
    await assertOutputsIdle(client);
    await client.request("SetCurrentProgramScene", { sceneName: tick.plan.targetScene });
    const at = new Date().toISOString();
    nextState = markCutApplied(tick.state, sample, tick.plan.targetScene, at);
    cut = true;
    receiptPath = await writeReceipt(config.stateDir, "vision-switch-cut", {
      ok: true,
      command: "vision-switch:tick",
      from: currentScene,
      to: tick.plan.targetScene,
      panel: sample.panel,
      pair: sample.pair,
      process: sample.process ?? null,
      at,
      llmInCutLoop: false,
    });
  } else {
    receiptPath = await writeReceipt(config.stateDir, "vision-switch-tick", {
      ok: true,
      command: "vision-switch:tick",
      cut: false,
      plan: tick.plan,
      sample: publicVisionSample(sample, args),
      dryRun: config.dryRun !== false,
      authorized,
    });
  }

  const statePath = await saveVisionSwitchState(config.stateDir, nextState);
  output({
    ok: true,
    command: "vision-switch:tick",
    cut,
    plan: tick.plan,
    sample: publicVisionSample(sample, args),
    activity,
    state: nextState,
    statePath,
    receiptPath,
    requirement: tick.requirement ?? (tick.plan.residual === "vision_switch_outputs_active"
      ? "Outputs active; refusing cut to avoid thrash during record/stream"
      : undefined),
    llmInCutLoop: false,
    forceSecondary4k: false,
  }, args);
}

async function runVisionDaemon(
  config: ReturnType<typeof resolveConfig>,
  args: ParsedArgs,
): Promise<void> {
  const opts = resolveDaemonOptions({
    intervalMs: flagNumber(args, "interval-ms", flagNumber(args, "interval", 500)),
    maxTicks: flagString(args, "max-ticks") != null ? flagNumber(args, "max-ticks", 1) : flagNumber(args, "ticks", 0) || null,
    dryRun: config.dryRun !== false,
    authorized: mutationAuthorized(config.dryRun, args),
  });

  // Default safety: if max-ticks omitted, require explicit --forever for unbounded loop
  const forever = flagBool(args, "forever");
  const maxTicks = forever ? null : (opts.maxTicks ?? 3);

  const ticks: unknown[] = [];
  let cuts = 0;
  let state = await loadVisionSwitchState(config.stateDir);
  state = mergeStateFlags(state, args);

  const startReceipt = await writeReceipt(config.stateDir, "vision-switch-daemon-start", {
    ok: true,
    command: "vision-switch:daemon",
    dryRun: opts.dryRun,
    authorized: opts.authorized && !opts.dryRun,
    armed: state.armed,
    frozen: state.frozen,
    intervalMs: opts.intervalMs,
    maxTicks,
    forever,
    llmInCutLoop: false,
    forceSecondary4k: false,
    note: "Default disarmed/dry. Shell Get-ActivePanel → plan → optional tick.",
  });

  let client: ObsWebSocketClient | null = null;
  try {
    const wsConfig = await readObsWebSocketConfig(config.websocketConfigPath);
    client = await ObsWebSocketClient.connect(config.host, wsConfig);

    let i = 0;
    while (maxTicks == null || i < maxTicks) {
      i += 1;
      state = await loadVisionSwitchState(config.stateDir);
      state = mergeStateFlags(state, args);
      const sample = await resolveVisionSample(args, { preferShell: true });
      const scene = await client.request("GetCurrentProgramScene");
      const currentScene = String(scene.currentProgramSceneName ?? "");
      const authorized = opts.authorized && !opts.dryRun && state.armed && !state.frozen;
      const tick = evaluateVisionTick({
        sample,
        state,
        currentProgramScene: currentScene,
        dryRun: opts.dryRun || !authorized,
        authorized,
      });

      let nextState = tick.state;
      let cut = false;
      if (tick.plan.wouldCut && authorized) {
        try {
          await assertOutputsIdle(client);
          await client.request("SetCurrentProgramScene", { sceneName: tick.plan.targetScene });
          const at = new Date().toISOString();
          nextState = markCutApplied(tick.state, sample, tick.plan.targetScene, at);
          cut = true;
          cuts += 1;
          await writeReceipt(config.stateDir, "vision-switch-cut", {
            ok: true,
            command: "vision-switch:daemon",
            tick: i,
            from: currentScene,
            to: tick.plan.targetScene,
            panel: sample.panel,
            pair: sample.pair,
            process: sample.process ?? null,
            at,
            llmInCutLoop: false,
          });
        } catch (error) {
          await writeReceipt(config.stateDir, "vision-switch-cut-blocked", {
            ok: false,
            tick: i,
            error: error instanceof Error ? error.message : String(error),
            plan: tick.plan,
          });
        }
      }

      await saveVisionSwitchState(config.stateDir, nextState);
      state = nextState;
      ticks.push({
        tick: i,
        cut,
        panel: sample.panel,
        pair: sample.pair,
        process: sample.process ?? null,
        reason: tick.plan.reason,
        wouldCut: tick.plan.wouldCut,
        targetScene: tick.plan.targetScene,
        currentScene,
        armed: state.armed,
        frozen: state.frozen,
      });

      if (maxTicks == null || i < maxTicks) {
        await sleepInterval(opts.intervalMs);
      }
    }
  } finally {
    if (client) await client.close();
  }

  const endReceipt = await writeReceipt(config.stateDir, "vision-switch-daemon-end", {
    ok: true,
    command: "vision-switch:daemon",
    dryRun: opts.dryRun,
    cuts,
    tickCount: ticks.length,
    ticks,
    armed: state.armed,
    frozen: state.frozen,
    llmInCutLoop: false,
    forceSecondary4k: false,
    startReceipt,
  });

  output({
    ok: true,
    command: "vision-switch:daemon",
    dryRun: opts.dryRun,
    authorized: opts.authorized && !opts.dryRun,
    armed: state.armed,
    frozen: state.frozen,
    intervalMs: opts.intervalMs,
    maxTicks,
    tickCount: ticks.length,
    cuts,
    ticks,
    startReceipt,
    endReceipt,
    llmInCutLoop: false,
    forceSecondary4k: false,
    note: "Daemon poll: Shell Get-ActivePanel → plan → optional cut. Default dry/disarmed.",
  }, args);
}

function printHelp(): void {
  console.log(`${CLI_NAME} ${VERSION}\n\nRead: doctor | status | inventory | audio:status | audio:plan | audit:status | audit:capture | audit:show | audit:diff | audit:verify | profile:show | profile:plan | profile:backup | record:status | logs:latest | receipts:list | receipts:verify | vision-switch:scene-plan | vision-switch:scene-apply | vision-switch:plan | vision-switch:status | vision-switch:arm | vision-switch:disarm | vision-switch:freeze | vision-switch:unfreeze\nWrite: audio:bind | profile:apply | profile:refresh | profile:rollback | record:start | record:stop | record:canary | vision-switch:tick | vision-switch:daemon | vision-switch:scene-apply --mode renames-only\n\nInventory is a privacy-minimized summary by default; use inventory --full only for local diagnostics. Audio device IDs require audio:status --include-devices.\nProfile show/plan/backup/apply/refresh and canary require --preset <id>. Vision Switcher accepts --panel A|B|C|D or LEGENDS_OBS_PANEL_SENSOR; it is disarmed/dry by default and has no LLM in the cut loop.\nOBS mutations require LEGENDS_OBS_DRY_RUN=false and --confirm. Scene-apply live also needs --go <note>. Audit capture writes only redacted local evidence.`);
}

function summarizeAudioStatus(status: JsonObject): JsonObject {
  const { devices: rawDevices, configuredDeviceId: _configuredDeviceId, ...rest } = status;
  return {
    ...rest,
    availableDeviceCount: Array.isArray(rawDevices) ? rawDevices.length : 0,
    note: "Use --include-devices to show local endpoint names and IDs.",
  } as JsonObject;
}

function publicVisionSample(sample: unknown, args: ParsedArgs): unknown {
  if (flagBool(args, "include-window") || !sample || typeof sample !== "object") return sample;
  const { title: _title, hwnd: _hwnd, ...safe } = sample as Record<string, unknown>;
  return {
    ...safe,
    note: "Window title and handle omitted; use --include-window for local diagnostics.",
  };
}

function summarizeInventory(inventory: JsonObject): JsonObject {
  const machine = inventory.machine as JsonObject;
  const obs = inventory.obs as JsonObject;
  const capabilities = obs.capabilities as JsonObject;
  const sceneCollection = obs.sceneCollection as JsonObject;
  const scenes = (sceneCollection.scenes as JsonObject[] | undefined) ?? [];
  const inputs = (obs.inputs as JsonObject[] | undefined) ?? [];
  const outputs = (obs.outputs as JsonObject[] | undefined) ?? [];
  const profile = obs.profile as JsonObject;
  const parameters = profile.parameters as JsonObject;
  const parameterValue = (name: string): JsonValue => (parameters[name] as JsonObject | undefined)?.parameterValue ?? null;
  const inputKinds = Object.entries(inputs.reduce<Record<string, number>>((counts, input) => {
    const kind = String(input.inputKind ?? "unknown");
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {})).map(([inputKind, count]) => ({ inputKind, count }));
  return {
    ok: inventory.ok,
    capturedAt: inventory.capturedAt,
    machine: {
      platform: machine.platform,
      release: machine.release,
      architecture: machine.architecture,
      cpu: machine.cpu,
      logicalProcessors: machine.logicalProcessors,
      ramGiB: machine.ramGiB,
      gpus: machine.gpus,
      node: machine.node,
    },
    control: inventory.control,
    obs: {
      version: obs.version,
      activity: obs.activity,
      stats: obs.stats,
      profile: {
        profileName: profile.profileName,
        videoSettings: profile.videoSettings,
        rangeLabel: profile.rangeLabel,
        recording: {
          mode: parameterValue("AdvOut/RecType"),
          container: parameterValue("AdvOut/RecFormat2"),
          encoder: parameterValue("AdvOut/RecEncoder"),
          rescale: parameterValue("AdvOut/RecUseRescale"),
        },
        encoderSettings: profile.encoderSettings,
      },
      capabilityCounts: {
        requests: Array.isArray(capabilities.availableRequests) ? capabilities.availableRequests.length : 0,
        inputKinds: Array.isArray(capabilities.inputKinds) ? capabilities.inputKinds.length : 0,
        filterKinds: Array.isArray(capabilities.sourceFilterKinds) ? capabilities.sourceFilterKinds.length : 0,
        transitionKinds: Array.isArray(capabilities.transitionKinds) ? capabilities.transitionKinds.length : 0,
      },
      sceneCount: scenes.length,
      inputCount: inputs.length,
      inputKinds,
      outputs: outputs.map((item) => ({ outputKind: item.outputKind, outputActive: item.outputActive })),
      canvasCount: Array.isArray(obs.canvases) ? obs.canvases.length : 0,
      monitorCount: Array.isArray(obs.monitors) ? obs.monitors.length : 0,
    },
    privacy: "summary; use inventory --full only for local diagnostics because it can include paths, UUIDs, source settings, and window titles",
  } as JsonObject;
}

function mutationAuthorized(dryRun: boolean, args: ParsedArgs): boolean {
  return dryRun === false && isConfirmed(args);
}

function mutationPreview(args: ParsedArgs, dryRun: boolean, command: string): void {
  output({ ok: false, mutation: false, command, dryRun, confirmed: isConfirmed(args), requirement: "Set LEGENDS_OBS_DRY_RUN=false and pass --confirm" }, args);
  process.exitCode = 5;
}
