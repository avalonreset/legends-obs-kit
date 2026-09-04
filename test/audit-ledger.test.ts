import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMachineKey,
  buildDecisionSurface,
  canonicalJson,
  diffJson,
  hashJson,
  persistAuditDocument,
  readAuditStatus,
  showAudit,
  verifyAudits,
} from "../src/audit.js";
import type { JsonObject } from "../src/types.js";

function auditDocument(capturedAt: string, classification: "observed" | "verified-good", secret = "safe"): JsonObject {
  const hardware = { gpu: "RTX 4090" };
  const capabilities = { encoders: ["av1"] };
  const decisionSurface = { hardware, capabilities, settings: { profile: "HDR", quality: 18 } };
  return {
    kind: "legends-obs-settings-audit",
    version: 1,
    capturedAt,
    reason: classification,
    classification,
    machineKey: "workstation-test",
    hashes: {
      hardware: hashJson(hardware),
      capabilities: hashJson(capabilities),
      settings: hashJson(decisionSurface),
    },
    decisionSurface,
    inventory: { browserUrl: `https://example.test/control?token=${secret}`, obs: { capabilities } },
  };
}

test("canonical hashes ignore object key insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
});

test("machine key is stable across driver and encoder-session changes", () => {
  const base = {
    host: "TEST-WORKSTATION",
    architecture: "x64",
    cpu: "i9-12900K",
    logicalProcessors: 24,
    ramGiB: 127.8,
    gpus: [{ name: "RTX 4090", memoryMiB: 24564, driverVersion: "600", encoderSessionCount: 0 }],
  } as JsonObject;
  const changed = structuredClone(base);
  ((changed.gpus as JsonObject[])[0]).driverVersion = "610.62";
  ((changed.gpus as JsonObject[])[0]).encoderSessionCount = 2;
  assert.equal(buildMachineKey(base), buildMachineKey(changed));
  assert.match(buildMachineKey(base), /^machine-[a-f0-9]{12}$/);
  assert.doesNotMatch(buildMachineKey(base), /workstation/i);
});

test("drift diff reports exact changed, added, and removed paths", () => {
  const differences = diffJson(
    { profile: { color: "P010", range: "Full", old: true } },
    { profile: { color: "P216", range: "Full", peak: 1000 } },
  );
  assert.deepEqual(differences.map((difference) => [difference.path, difference.change]), [
    ["profile.color", "changed"],
    ["profile.old", "removed"],
    ["profile.peak", "added"],
  ]);
});

test("drift diff treats primitive and named arrays as stable sets", () => {
  const primitive = diffJson({ kinds: ["a", "c"] }, { kinds: ["a", "b", "c"] });
  assert.deepEqual(primitive.map((difference) => [difference.path, difference.change]), [
    ["kinds[value=\"b\"]", "added"],
  ]);
  const named = diffJson(
    { inputs: [{ inputName: "camera", enabled: true }, { inputName: "mic", enabled: true }] },
    { inputs: [{ inputName: "camera", enabled: false }, { inputName: "browser", enabled: true }, { inputName: "mic", enabled: true }] },
  );
  assert.deepEqual(named.map((difference) => [difference.path, difference.change]), [
    ["inputs[inputName=browser]", "added"],
    ["inputs[inputName=camera].enabled", "changed"],
  ]);
});

test("decision surface ignores the recorder's last output file path", () => {
  const inventory = (lastPath: string) => ({
    machine: {},
    control: {},
    obs: { outputs: [{ outputName: "record", settings: { path: lastPath, format: "mkv" } }] },
  }) as JsonObject;
  assert.equal(
    hashJson(buildDecisionSurface(inventory("D:/GAMECAPTURE/one.mkv"))),
    hashJson(buildDecisionSurface(inventory("D:/GAMECAPTURE/two.mkv"))),
  );
});

test("ledger keeps latest observed separate from last-known-good", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legends-obs-audit-test-"));
  try {
    const good = await persistAuditDocument(directory, auditDocument("2026-07-18T20:00:00.000Z", "verified-good", "first-secret"));
    const observed = await persistAuditDocument(directory, auditDocument("2026-07-18T21:00:00.000Z", "observed", "second-secret"));
    const status = await readAuditStatus(directory);
    assert.equal(status.ok, true);
    const machine = (status.machines as JsonObject[])[0];
    assert.equal((machine.latest as JsonObject).classification, "observed");
    assert.equal((machine.lastKnownGood as JsonObject).classification, "verified-good");
    assert.equal((machine.latest as JsonObject).capturedAt, "2026-07-18T21:00:00.000Z");
    assert.equal((machine.lastKnownGood as JsonObject).capturedAt, "2026-07-18T20:00:00.000Z");
    assert.equal(good.lastKnownGoodPointerPath !== null, true);
    assert.equal(observed.lastKnownGoodPointerPath, null);
    const text = await readFile(String(observed.auditPath), "utf8");
    assert.doesNotMatch(text, /second-secret/);
    assert.match(text, /%5BREDACTED%5D/);
    assert.deepEqual(await verifyAudits(directory), { ok: true, machineCount: 1, count: 2, failures: [] });
    const shown = await showAudit(directory, "good");
    assert.equal(shown.classification, "verified-good");
    assert.deepEqual(shown.decisionSurface, auditDocument("2026-07-18T20:00:00.000Z", "verified-good").decisionSurface);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
