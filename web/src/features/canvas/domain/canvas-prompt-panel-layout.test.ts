import assert from "node:assert/strict";
import test from "node:test";
import { canvasPromptPanelLayout } from "./canvas-prompt-panel-layout.ts";

const input = {
    canvasWidth: 1200, canvasHeight: 844,
    frame: { position: { x: 100, y: 80 }, width: 480, height: 330 },
    viewport: { x: 0, y: 0, k: 1 }, panelHeight: 260,
};

test("390 and 320 pixel canvases keep the entire prompt panel inside horizontal margins", () => {
    for (const canvasWidth of [390, 320]) {
        for (const x of [-1200, 0, 5000]) {
            const panel = canvasPromptPanelLayout({ ...input, canvasWidth, viewport: { ...input.viewport, x } });
            assert.equal(panel.width, canvasWidth - 32);
            assert.equal(panel.left, 16);
            assert.ok(panel.left + panel.width <= canvasWidth - 16);
        }
    }
});

test("desktop width and below-node alignment remain unchanged", () => {
    const panel = canvasPromptPanelLayout(input);
    assert.deepEqual(panel, { width: 580, left: 50, top: 426 });
    const rightEdge = canvasPromptPanelLayout({ ...input, viewport: { x: 1200, y: 1200, k: 1 } });
    assert.deepEqual(rightEdge, { width: 580, left: 604, top: 496 });
});

test("resized and zoomed canvases use the actual panel width when centering", () => {
    const panel = canvasPromptPanelLayout({ ...input, canvasWidth: 700, viewport: { x: -500, y: 0, k: 2 } });
    assert.equal(panel.width, 580);
    assert.equal(panel.left, 16);
    assert.ok(panel.left + panel.width <= 684);
});
