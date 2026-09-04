import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/args.js";
import { resolveConfig } from "../src/config.js";
import { buildManifest } from "../src/manifest.js";
import { containsSecretMarker, redactText, redactUnknown } from "../src/redact.js";
import { verifyReceipts, writeReceipt } from "../src/receipts.js";

test("argument parser keeps confirmation explicit", () => {
  const parsed = parseArgs(["profile:apply", "--preset", "hdr-4k60-av1-balanced", "--confirm", "--pretty"]);
  assert.equal(parsed.command, "profile:apply");
  assert.equal(parsed.flags.preset, "hdr-4k60-av1-balanced");
  assert.equal(parsed.flags.confirm, true);
  assert.equal(parsed.flags.pretty, true);
});

test("dry-run defaults true and only literal false enables live mode", () => {
  assert.equal(resolveConfig({ APPDATA: "C:\\Temp" }).dryRun, true);
  assert.equal(resolveConfig({ APPDATA: "C:\\Temp", LEGENDS_OBS_DRY_RUN: "false" }).dryRun, false);
  assert.equal(resolveConfig({ APPDATA: "C:\\Temp", LEGENDS_OBS_DRY_RUN: "0" }).dryRun, true);
  assert.equal(resolveConfig({ APPDATA: "C:\\Temp" }).requirePrimaryMicrophone, false);
  assert.equal(resolveConfig({ APPDATA: "C:\\Temp", LEGENDS_OBS_REQUIRE_PRIMARY_MICROPHONE: "true" }).requirePrimaryMicrophone, true);
  assert.equal(resolveConfig({ APPDATA: "C:\\Temp" }).ffprobePath, "ffprobe");
  assert.equal(resolveConfig({ APPDATA: "C:\\Temp", LEGENDS_OBS_FFPROBE_PATH: "C:\\Tools\\ffprobe.exe" }).ffprobePath, "C:\\Tools\\ffprobe.exe");
});

test("redactor removes credential-shaped keys and values", () => {
  const oauthLike = ["ya29", "example"].join(".");
  const redacted = redactUnknown({ server_password: "secret", Token: oauthLike, nested: { cookie: "session", key: "plain-secret" } });
  assert.equal((redacted as Record<string, unknown>).server_password, "[REDACTED]");
  assert.equal((redacted as Record<string, unknown>).Token, "[REDACTED]");
  assert.deepEqual((redacted as Record<string, unknown>).nested, { cookie: "[REDACTED]", key: "[REDACTED]" });
  assert.doesNotMatch(String((redactUnknown("https://example.test/?access_token=private-value"))), /private-value/);
  assert.equal(redactText("log https://user:pass@example.test/path continued"), "log https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/path continued");
  assert.equal(redactText("C:\\Users\\someone\\AppData\\Roaming\\obs-studio"), "%USERPROFILE%\\AppData\\Roaming\\obs-studio");
  const openAiLike = `sk-proj-${"A".repeat(32)}`;
  const slackLike = `xoxb-${"1".repeat(12)}-${"A".repeat(24)}`;
  const slackAppLike = `xapp-${"1".repeat(12)}-${"A".repeat(24)}`;
  const slackEnvelopeLike = `xoxe-${"1".repeat(12)}-${"A".repeat(24)}`;
  assert.equal(redactText(openAiLike), "[REDACTED]");
  assert.equal(redactText(slackLike), "[REDACTED]");
  assert.equal(redactText(slackAppLike), "[REDACTED]");
  assert.equal(redactText(slackEnvelopeLike), "[REDACTED]");
  assert.equal(containsSecretMarker({ key: "plain-secret" }), true);
  assert.equal(containsSecretMarker(openAiLike), true);
  assert.equal(containsSecretMarker(slackLike), true);
  assert.equal(containsSecretMarker(slackAppLike), true);
  assert.equal(containsSecretMarker(slackEnvelopeLike), true);
  assert.equal(containsSecretMarker("log https://example.test/?access_token=private-value continued"), true);
  assert.equal(containsSecretMarker({ safe: "ordinary text" }), false);
});

test("manifest has no ambient MCP and marks every write", () => {
  const manifest = buildManifest();
  assert.equal(manifest.ambientMcp, false);
  const commands = manifest.commands as Array<{ command: string; mutation: boolean }>;
  for (const name of ["audio:bind", "profile:apply", "profile:refresh", "profile:rollback", "record:start", "record:stop", "record:canary", "vision-switch:tick", "vision-switch:daemon"]) {
    assert.equal(commands.find((command) => command.command === name)?.mutation, true, name);
  }
});

test("receipts are redacted and verify clean", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legends-obs-kit-test-"));
  try {
    const passwordValue = ["do", "not", "store"].join("-");
    const file = await writeReceipt(directory, "test", { password: passwordValue, safe: "yes" });
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /do-not-store/);
    assert.match(text, /\[REDACTED]/);
    assert.deepEqual(await verifyReceipts(directory), { ok: true, count: 1, failures: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
