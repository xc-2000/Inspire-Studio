import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelIcon, isMonochromeModelIcon } from "./model-icon.ts";

test("video model aliases resolve brand icons behind a common gateway", () => {
    assert.equal(resolveModelIcon("sora-2", "newapi"), "/icons/openai.svg");
    assert.equal(resolveModelIcon("veo-3.1-lite-generate-preview", "newapi"), "/icons/gemini.svg");
    assert.equal(resolveModelIcon("doubao-video-2.5", "newapi"), "/icons/bytedance.svg");
    assert.equal(resolveModelIcon("MiniMax H3", "newapi"), "/icons/minimax.svg");
    assert.equal(isMonochromeModelIcon("sora-2", "newapi"), true);
    assert.equal(isMonochromeModelIcon("veo-3.1-fast", "newapi"), false);
});

test("explicit model brand takes priority over provider format fallback", () => {
    assert.equal(resolveModelIcon("gemini-3-pro-image-preview", "minimax"), "/icons/gemini.svg");
    assert.equal(isMonochromeModelIcon("gemini-3-pro-image-preview", "minimax"), false);
    assert.equal(resolveModelIcon("unknown", "seedance"), "/icons/bytedance.svg");
});
