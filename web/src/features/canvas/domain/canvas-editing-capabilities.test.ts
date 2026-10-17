import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createTextNode, createVideoNode } from "../constants.ts";
import { canvasEditingCapabilities } from "./canvas-editing-capabilities.ts";

test("empty selections do not expose incompatible media actions", () => {
    const capabilities = canvasEditingCapabilities([], new Set());
    assert.equal(capabilities.canRefine, false);
    assert.equal(capabilities.canEditVideo, false);
    assert.equal(capabilities.canCompare, false);
    assert.equal(capabilities.canDuplicate, false);
});

test("refinement requires a single image with an actual result", () => {
    const image = createImageNode({ id: "image", position: { x: 0, y: 0 } });
    const text = createTextNode({ id: "text", position: { x: 0, y: 0 } });
    assert.equal(canvasEditingCapabilities([image], new Set([image.id])).canRefine, false);
    image.content.source = "https://r2.example/image.png";
    assert.equal(canvasEditingCapabilities([image], new Set([image.id])).canRefine, true);
    assert.equal(canvasEditingCapabilities([image, text], new Set([image.id, text.id])).canRefine, false);
});

test("video editing requires a result and comparison requires exactly two videos", () => {
    const first = createVideoNode({ id: "video-1", position: { x: 0, y: 0 } });
    const second = createVideoNode({ id: "video-2", position: { x: 0, y: 0 } });
    const text = createTextNode({ id: "text", position: { x: 0, y: 0 } });
    assert.equal(canvasEditingCapabilities([first], new Set([first.id])).canEditVideo, false);
    first.content.source = "https://r2.example/one.mp4";
    second.content.source = "https://r2.example/two.mp4";
    assert.equal(canvasEditingCapabilities([first], new Set([first.id])).canEditVideo, true);
    assert.equal(canvasEditingCapabilities([first, second], new Set([first.id, second.id])).canCompare, true);
    assert.equal(canvasEditingCapabilities([first, second, text], new Set([first.id, second.id, text.id])).canCompare, false);
});
