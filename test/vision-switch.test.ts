import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyRenameStepsTransactional,
  applyHysteresis,
  classifyFocusProcess,
  defaultVisionSwitchState,
  evaluateVisionTick,
  isObsProcess,
  isUsefulFocusProcess,
  loadVisionSwitchState,
  panelToPair,
  parseActivePanelJson,
  DEFAULT_HONEST_PIXEL_OPTION,
  HONEST_PIXEL_OPTIONS,
  planSceneApply,
  planSceneGraph,
  resolveCanonicalSource,
  planVisionCut,
  pairToSceneName,
  resolveDaemonOptions,
  sampleFromPanelFlag,
  saveVisionSwitchState,
  sceneNameToPair,
  shouldHoldLastPairForObs,
} from "../src/vision-switch.js";

test("panelToPair maps A/B→AB and C/D→CD", () => {
  assert.equal(panelToPair("A"), "AB");
  assert.equal(panelToPair("B"), "AB");
  assert.equal(panelToPair("C"), "CD");
  assert.equal(panelToPair("D"), "CD");
});

test("legacy scene name maps to AB", () => {
  assert.equal(sceneNameToPair("codex left / chrome right"), "AB");
  assert.equal(pairToSceneName("AB"), "panel-ab");
});

test("disarmed plan never cuts", () => {
  const state = defaultVisionSwitchState();
  const plan = planVisionCut({
    sample: { panel: "C", pair: "CD" },
    state,
    currentProgramScene: "codex left / chrome right",
    dryRun: true,
  });
  assert.equal(plan.wouldCut, false);
  assert.equal(plan.residual, "vision_switch_disarmed");
});

test("armed plan cuts when on other pair", () => {
  const state = { ...defaultVisionSwitchState(), armed: true, lastPair: "AB" as const };
  const plan = planVisionCut({
    sample: { panel: "C", pair: "CD", process: "ChatGPT" },
    state,
    currentProgramScene: "codex left / chrome right",
    dryRun: true,
  });
  assert.equal(plan.wouldCut, true);
  assert.equal(plan.targetScene, "panel-cd");
  assert.equal(plan.residual, "dry_run_no_ws_mutation");
});

test("OBS process on D holds last pair (obs_recursion_guard)", () => {
  const state = { ...defaultVisionSwitchState(), armed: true, lastPair: "AB" as const };
  const plan = planVisionCut({
    sample: { panel: "D", pair: "CD", process: "obs64" },
    state,
    currentProgramScene: "panel-ab",
    dryRun: false,
  });
  assert.equal(plan.wouldCut, false);
  assert.equal(plan.reason, "hold_last_pair");
  assert.equal(plan.residual, "obs_recursion_guard");
  assert.equal(plan.holdLastPair, true);
  assert.equal(plan.heldPair, "AB");
  assert.equal(plan.focusClass, "obs");
  assert.equal(plan.chromeFirst, true);
});

test("obsidian is not OBS recursion (useful/other, not hold)", () => {
  assert.equal(isObsProcess("obsidian"), false);
  assert.equal(isObsProcess("obs64"), true);
  assert.equal(isObsProcess("OBS64.exe"), true);
  assert.equal(isObsProcess("C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe"), true);
  assert.equal(classifyFocusProcess("obsidian"), "useful");
  const state = { ...defaultVisionSwitchState(), armed: true, lastPair: "AB" as const };
  const plan = planVisionCut({
    sample: { panel: "C", pair: "CD", process: "obsidian" },
    state,
    currentProgramScene: "panel-ab",
    dryRun: true,
  });
  assert.equal(plan.holdLastPair, false);
  assert.equal(plan.wouldCut, true);
  assert.equal(plan.focusClass, "useful");
});

test("useful focus classifies common browsers and desktop apps", () => {
  assert.equal(classifyFocusProcess("chrome"), "useful");
  assert.equal(classifyFocusProcess("msedge"), "useful");
  assert.equal(classifyFocusProcess("ChatGPT"), "useful");
  assert.equal(classifyFocusProcess("codex"), "useful");
  assert.equal(isUsefulFocusProcess("chrome"), true);
  assert.equal(shouldHoldLastPairForObs({ panel: "D", pair: "CD", process: "obs64" }), true);
  assert.equal(shouldHoldLastPairForObs({ panel: "B", pair: "AB", process: "chrome" }), false);
  assert.equal(shouldHoldLastPairForObs({ panel: "A", pair: "AB", process: "obs64" }), false);
});

test("evaluateVisionTick OBS-on-D holds lastPair and clears hysteresis", () => {
  const state = {
    ...defaultVisionSwitchState(),
    armed: true,
    lastPair: "AB" as const,
    consecutiveNewPair: 1,
  };
  const tick = evaluateVisionTick({
    sample: sampleFromPanelFlag("D", { process: "obs64" }),
    state,
    currentProgramScene: "panel-ab",
    dryRun: false,
    authorized: true,
  });
  assert.equal(tick.cut, false);
  assert.equal(tick.plan.reason, "hold_last_pair");
  assert.equal(tick.plan.residual, "obs_recursion_guard");
  assert.equal(tick.state.lastPair, "AB");
  assert.equal(tick.state.consecutiveNewPair, 0);
  // daemon continues: sample recorded, no throw
  assert.equal(tick.state.lastPanel, "D");
});

test("Chrome on C is useful cut candidate (not blocked by OBS self-capture)", () => {
  const state = { ...defaultVisionSwitchState(), armed: true, lastPair: "AB" as const, consecutiveNewPair: 1 };
  const tick = evaluateVisionTick({
    sample: sampleFromPanelFlag("C", { process: "chrome" }),
    state,
    currentProgramScene: "panel-ab",
    dryRun: false,
    authorized: true,
  });
  assert.equal(tick.plan.focusClass, "useful");
  assert.equal(tick.plan.holdLastPair, false);
  assert.equal(tick.plan.wouldCut, true);
  assert.equal(tick.cut, true);
  assert.equal(tick.plan.targetPair, "CD");
});

test("hysteresis needs two samples", () => {
  let state = defaultVisionSwitchState();
  state.lastPair = "AB";
  let r = applyHysteresis(state, "CD");
  assert.equal(r.ready, false);
  r = applyHysteresis(r.state, "CD");
  assert.equal(r.ready, true);
});

test("scene graph proposes AB and CD without forcing 4K secondary", () => {
  const g = planSceneGraph("codex left / chrome right");
  assert.equal(g.proposed.length, 2);
  assert.equal(g.proposed[0].sceneName, "panel-ab");
  assert.equal(g.renameFrom?.[0]?.to, "panel-ab");
  assert.match(g.resolutionPolicy, /2560x1440/);
  assert.match(g.resolutionPolicy, /no OBS stretch|integer scale/i);
  assert.match(g.proposed[1].notes, /Reject OBS scale-to-fill|honest-pixel|1:1/i);
});

test("honest pixel policy: default B, reject stretch D", () => {
  const g = planSceneGraph(null);
  assert.equal(g.pixelPolicy.defaultOption, DEFAULT_HONEST_PIXEL_OPTION);
  assert.equal(g.pixelPolicy.defaultOption, "B_native_pillarbox");
  assert.equal(g.pixelPolicy.rejectedDefault, "D_stretch_rejected");
  const stretch = HONEST_PIXEL_OPTIONS.find((o) => o.id === "D_stretch_rejected");
  assert.ok(stretch);
  assert.equal(stretch!.allowed, false);
  const optA = HONEST_PIXEL_OPTIONS.find((o) => o.id === "A_windows_4k_render");
  assert.ok(optA?.requiresExplicitApproval);
  assert.ok(optA?.allowed);
  const optB = HONEST_PIXEL_OPTIONS.find((o) => o.id === "B_native_pillarbox");
  assert.ok(optB?.isDefault);
  assert.doesNotMatch(g.resolutionPolicy, /scale CD pair into|scale-to-fill as default/i);
});

test("parseActivePanelJson accepts Shell Get-ActivePanel shape", () => {
  const sample = parseActivePanelJson({
    ok: true,
    panel: "D",
    pair: "CD",
    process: "obs64",
    title: "OBS",
    hwnd: 123,
    sceneHint: "panel-cd",
    display: "supplementary",
    confidence: "high",
  });
  assert.equal(sample.panel, "D");
  assert.equal(sample.pair, "CD");
  assert.equal(sample.process, "obs64");
  assert.equal(sample.source, "shell");
});

test("default state is disarmed and unfrozen", () => {
  const s = defaultVisionSwitchState();
  assert.equal(s.armed, false);
  assert.equal(s.frozen, false);
});

test("state load/save roundtrip defaults disarmed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-state-"));
  try {
    const loaded = await loadVisionSwitchState(dir);
    assert.equal(loaded.armed, false);
    loaded.armed = true;
    await saveVisionSwitchState(dir, loaded);
    const again = await loadVisionSwitchState(dir);
    assert.equal(again.armed, true);
    const text = await readFile(path.join(dir, "vision-switch-state.json"), "utf8");
    assert.match(text, /"armed": true/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evaluateVisionTick dry disarmed never authorizes cut", () => {
  const tick = evaluateVisionTick({
    sample: sampleFromPanelFlag("C", { process: "ChatGPT" }),
    state: defaultVisionSwitchState(),
    currentProgramScene: "codex left / chrome right",
    dryRun: true,
    authorized: false,
  });
  assert.equal(tick.cut, false);
  assert.equal(tick.plan.wouldCut, false);
  assert.equal(tick.plan.reason, "disarmed");
});

test("evaluateVisionTick hysteresis blocks first sample even when armed", () => {
  const state = { ...defaultVisionSwitchState(), armed: true, lastPair: "AB" as const };
  const tick = evaluateVisionTick({
    sample: sampleFromPanelFlag("C", { process: "ChatGPT" }),
    state,
    currentProgramScene: "panel-ab",
    dryRun: false,
    authorized: true,
  });
  assert.equal(tick.cut, false);
  assert.equal(tick.plan.reason, "hysteresis_pending");
  assert.equal(tick.state.consecutiveNewPair, 1);
});

test("evaluateVisionTick second sample cuts when armed and authorized", () => {
  let state = { ...defaultVisionSwitchState(), armed: true, lastPair: "AB" as const, consecutiveNewPair: 0 };
  let tick = evaluateVisionTick({
    sample: sampleFromPanelFlag("C"),
    state,
    currentProgramScene: "panel-ab",
    dryRun: false,
    authorized: true,
  });
  assert.equal(tick.plan.reason, "hysteresis_pending");
  tick = evaluateVisionTick({
    sample: sampleFromPanelFlag("C"),
    state: tick.state,
    currentProgramScene: "panel-ab",
    dryRun: false,
    authorized: true,
  });
  assert.equal(tick.plan.wouldCut, true);
  assert.equal(tick.cut, true);
  assert.equal(tick.plan.targetScene, "panel-cd");
});

test("daemon options default dry and reject live without auth", () => {
  const dry = resolveDaemonOptions({ dryRun: true, authorized: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.authorized, false);
  const live = resolveDaemonOptions({ dryRun: false, authorized: true, intervalMs: 400, maxTicks: 5 });
  assert.equal(live.authorized, true);
  assert.equal(live.intervalMs, 400);
  assert.equal(live.maxTicks, 5);
});

test("resolveCanonicalSource maps legacy LEFT/RIGHT names", () => {
  assert.equal(resolveCanonicalSource(" LEFT A"), "A");
  assert.equal(resolveCanonicalSource("RIGHT B"), "B");
  assert.equal(resolveCanonicalSource("LEFT C"), "C");
  assert.equal(resolveCanonicalSource("RIGHT D"), "D");
  assert.equal(resolveCanonicalSource("capture-A"), "A");
  assert.equal(resolveCanonicalSource("Desktop Audio"), null);
});

test("planSceneApply renames legacy scene and sources; blocks on recording", () => {
  const plan = planSceneApply({
    inventory: {
      currentProgramScene: "codex left / chrome right",
      sceneNames: ["codex left / chrome right"],
      inputNames: [" LEFT A", "RIGHT B", "LEFT C", "RIGHT D", "Mic/Aux"],
      recording: true,
      streaming: false,
    },
  });
  assert.equal(plan.dryRun, true);
  assert.ok(plan.blockers.includes("recording_active"));
  assert.equal(plan.observed.hasPanelCd, false);
  assert.ok(plan.autoApplyable.some((s) => s.action === "rename_scene" && s.to === "panel-ab"));
  assert.ok(plan.autoApplyable.some((s) => s.action === "rename_input" && s.to === "capture-A"));
  assert.ok(plan.autoApplyable.some((s) => s.action === "rename_input" && s.to === "capture-C"));
  assert.ok(plan.steps.some((s) => s.action === "duplicate_scene_human" && s.autoApply === false));
  assert.match(plan.resolutionPolicy, /2560x1440/);
  assert.match(plan.resolutionPolicy, /no OBS stretch|integer scale/i);
  assert.match(plan.captureStrategy, /display-region|desktop applications/);
  assert.equal(plan.pixelPolicy.defaultOption, "B_native_pillarbox");
  assert.ok(plan.steps.some((s) => s.action === "honest_pixel_policy"));
  assert.ok(
    plan.steps.some(
      (s) => s.action === "honest_pixel_policy" && /Reject automatic scale-to-fill/i.test(s.detail),
    ),
  );
  assert.ok(plan.humanChecklist.some((h) => /Option A|1:1|no stretch/i.test(h)));
  assert.ok(plan.humanChecklist.length >= 5);
});

test("planSceneApply no rename when already canonical", () => {
  const plan = planSceneApply({
    inventory: {
      currentProgramScene: "panel-ab",
      sceneNames: ["panel-ab", "panel-cd"],
      inputNames: ["capture-A", "capture-B", "capture-C", "capture-D"],
      recording: false,
    },
  });
  assert.equal(plan.autoApplyable.length, 0);
  assert.equal(plan.observed.hasPanelAb, true);
  assert.equal(plan.observed.hasPanelCd, true);
  assert.equal(plan.observed.missingCanonical.length, 0);
});

test("planSceneApply blocks duplicate aliases before a target collision", () => {
  const plan = planSceneApply({
    inventory: {
      currentProgramScene: "panel-ab",
      sceneNames: ["panel-ab", "panel-cd"],
      inputNames: [" LEFT A", "capture-A", "capture-B", "capture-C", "capture-D"],
    },
  });
  assert.ok(plan.blockers.some((blocker) => blocker.startsWith("ambiguous_source_a:")));
  assert.equal(plan.autoApplyable.some((step) => step.to === "capture-A"), false);
});

test("rename transaction fails fast and rolls back an earlier rename", async () => {
  const inputs = new Set([" LEFT A", "RIGHT B"]);
  const request = async (requestType: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (requestType === "GetInputList") return { inputs: [...inputs].map((inputName) => ({ inputName })) };
    if (requestType === "GetSceneList") return { scenes: [{ sceneName: "panel-ab" }] };
    if (requestType === "SetInputName") {
      const from = String(data.inputName);
      const to = String(data.newInputName);
      if (from === "RIGHT B") throw new Error("simulated second-write failure");
      inputs.delete(from);
      inputs.add(to);
      return {};
    }
    throw new Error(`unexpected request: ${requestType}`);
  };
  await assert.rejects(
    applyRenameStepsTransactional({ request }, [
      { id: "a", action: "rename_input", from: " LEFT A", to: "capture-A", detail: "a", wsSafe: true, risk: "low", autoApply: true },
      { id: "b", action: "rename_input", from: "RIGHT B", to: "capture-B", detail: "b", wsSafe: true, risk: "low", autoApply: true },
    ]),
    /rollback verified.*simulated second-write failure/,
  );
  assert.deepEqual([...inputs].sort(), [" LEFT A", "RIGHT B"]);
});

test("rename transaction recovers when OBS applied a rename but the response was lost", async () => {
  const inputs = new Set(["LEFT A"]);
  const request = async (requestType: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (requestType === "GetInputList") return { inputs: [...inputs].map((inputName) => ({ inputName })) };
    if (requestType === "GetSceneList") return { scenes: [] };
    if (requestType === "SetInputName") {
      inputs.delete(String(data.inputName));
      inputs.add(String(data.newInputName));
      throw new Error("response lost after rename applied");
    }
    throw new Error(`unexpected request: ${requestType}`);
  };
  await assert.rejects(
    applyRenameStepsTransactional({ request }, [
      { id: "a", action: "rename_input", from: "LEFT A", to: "capture-A", detail: "a", wsSafe: true, risk: "low", autoApply: true },
    ]),
    /rollback verified.*response lost after rename applied/,
  );
  assert.deepEqual([...inputs], ["LEFT A"]);
});

test("planVisionCut refuses cut while outputs active", () => {
  const state = { ...defaultVisionSwitchState(), armed: true, lastPair: "AB" as const };
  const plan = planVisionCut({
    sample: sampleFromPanelFlag("C"),
    state,
    currentProgramScene: "panel-ab",
    dryRun: true,
    outputsActive: true,
  });
  assert.equal(plan.wouldCut, false);
  assert.equal(plan.residual, "vision_switch_outputs_active");
});
