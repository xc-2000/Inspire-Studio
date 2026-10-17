import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/features/settings/stores/use-config-store";
import { buildCanvasImageRefinementConfig } from "./canvas-image-refinement-config";

test("portrait refinement follows the reference instead of the global landscape size", () => {
    const config = { ...defaultConfig, size: "16:9", count: "4", model: "chat-model", imageModel: "image-model", imageResolution: "2K" };
    const edit = buildCanvasImageRefinementConfig(config, 398, 720);
    assert.equal(edit.size, "9:16");
    assert.equal(edit.count, "1");
    assert.equal(edit.model, "image-model");
    assert.equal(edit.imageResolution, "2K");
    assert.equal(config.size, "16:9");
    assert.equal(config.count, "4");
});

test("symmetrical outpainting and square relighting retain their source orientation", () => {
    assert.equal(buildCanvasImageRefinementConfig(defaultConfig, 597, 1080).size, "9:16");
    assert.equal(buildCanvasImageRefinementConfig(defaultConfig, 1920, 1080).size, "16:9");
    assert.equal(buildCanvasImageRefinementConfig(defaultConfig, 1024, 1024).size, "1:1");
    assert.equal(buildCanvasImageRefinementConfig(defaultConfig, 1600, 1200).size, "4:3");
});

test("invalid source dimensions cannot silently fall back to unrelated global settings", () => {
    for (const [width, height] of [[0, 1024], [1024, 0], [Number.NaN, 1024]]) assert.throws(() => buildCanvasImageRefinementConfig(defaultConfig, width, height), /尺寸/);
});
