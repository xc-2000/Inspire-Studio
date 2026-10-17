import test from "node:test";
import assert from "node:assert/strict";
import { videoGenerateAudio } from "./video-audio.ts";

test("legacy defaults, explicit mute, and reference audio precedence", () => {
    for (const value of [undefined, null, "", true, "true", 1]) assert.equal(videoGenerateAudio(value), true);
    for (const value of [false, "false", " FALSE ", 0, "0"]) assert.equal(videoGenerateAudio(value), false);
    for (const value of [undefined, true, "true", false]) assert.equal(videoGenerateAudio(value, 1), false);
    const saved = "true";
    assert.equal(videoGenerateAudio(saved, 2), false);
    assert.equal(videoGenerateAudio(saved, 0), true);
});
