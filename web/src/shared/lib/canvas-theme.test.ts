import assert from "node:assert/strict";
import test from "node:test";

import { canvasThemes } from "./canvas-theme.ts";

test("canvasThemes 保留浅色画布色板", () => {
    assert.equal(canvasThemes.light.canvas.background, "#f6f7f8");
    assert.equal(canvasThemes.light.node.text, "#14181b");
});

test("canvasThemes 提供暗色画布色板", () => {
    assert.equal(canvasThemes.dark.canvas.background, "#0b0d0f");
    assert.equal(canvasThemes.dark.node.text, "#eef1f3");
    assert.equal(canvasThemes.dark.toolbar.panel, "rgba(18,20,23,.92)");
});
