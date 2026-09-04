import assert from "node:assert/strict";
import test from "node:test";
import { selectAudioDevice } from "../src/audio.js";

const devices = [
  { itemName: "Microphone (H Series Stereo Track Usb Audio)", itemValue: "{zoom-id}", itemEnabled: true },
  { itemName: "Microphone (MiNiSTUDIO US-32/42)", itemValue: "{studio-id}", itemEnabled: true },
  { itemName: "Old Zoom", itemValue: "{stale-id}", itemEnabled: false },
];

test("audio device selection resolves an enabled unique name fragment or exact id", () => {
  assert.equal(selectAudioDevice(devices, "H Series Stereo Track").itemValue, "{zoom-id}");
  assert.equal(selectAudioDevice(devices, "{studio-id}").itemName, "Microphone (MiNiSTUDIO US-32/42)");
});

test("audio device selection rejects missing and disabled endpoints", () => {
  assert.throws(() => selectAudioDevice(devices, "Old Zoom"), /No enabled OBS audio device/);
  assert.throws(() => selectAudioDevice(devices, "not present"), /No enabled OBS audio device/);
});
