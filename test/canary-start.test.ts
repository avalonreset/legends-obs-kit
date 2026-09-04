import assert from "node:assert/strict";
import test from "node:test";
import { stopRecordingAndVerifyIdle, waitForRecordStart, waitForRecordStop } from "../src/canary.js";

test("waitForRecordStart tolerates slow encoder initialization", async () => {
  let polls = 0;
  const client = {
    async request(): Promise<Record<string, unknown>> {
      polls += 1;
      return { outputActive: polls >= 4 };
    },
  };

  const status = await waitForRecordStart(client, 1_000, 1);
  assert.equal(status.outputActive, true);
  assert.equal(polls, 4);
});

test("waitForRecordStop requires an idle readback", async () => {
  let polls = 0;
  const client = {
    async request(): Promise<Record<string, unknown>> {
      polls += 1;
      return { outputActive: polls < 3 };
    },
  };
  const status = await waitForRecordStop(client, 1_000, 1);
  assert.equal(status.outputActive, false);
  assert.equal(polls, 3);
});

test("cleanup stops an active recording and verifies idle", async () => {
  let active = true;
  const calls: string[] = [];
  const client = {
    async request(type: string): Promise<Record<string, unknown>> {
      calls.push(type);
      if (type === "StopRecord") active = false;
      return { outputActive: active };
    },
  };
  await stopRecordingAndVerifyIdle(client, 3, 1);
  assert.equal(calls.includes("StopRecord"), true);
  assert.equal(active, false);
});

test("cleanup surfaces a stop failure instead of claiming idle", async () => {
  const client = {
    async request(type: string): Promise<Record<string, unknown>> {
      if (type === "StopRecord") throw new Error("transport lost");
      return { outputActive: true };
    },
  };
  await assert.rejects(stopRecordingAndVerifyIdle(client, 10, 1), /transport lost/);
});

test("waitForRecordStart fails closed after its bounded authority window", async () => {
  const client = {
    async request(): Promise<Record<string, unknown>> {
      return { outputActive: false };
    },
  };

  await assert.rejects(
    waitForRecordStart(client, 10, 1),
    /did not become active within 10 ms/,
  );
});
