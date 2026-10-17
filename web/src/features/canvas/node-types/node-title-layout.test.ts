import assert from "node:assert/strict";
import test from "node:test";
import { canvasNodeTitleLayout } from "./node-title-layout";

test("zoomed-out captions cannot overflow the displayed node width", () => {
    for (const zoom of [0.2, 0.4, 0.6, 1, 2]) {
        for (const nodeWidth of [220, 315, 640, 1024]) {
            const layout = canvasNodeTitleLayout(nodeWidth, zoom, false);
            assert.ok(layout.width <= nodeWidth * zoom);
            assert.ok(layout.width <= 240);
            assert.ok(layout.fontSize >= 10 && layout.fontSize <= 12);
            assert.ok(layout.offset <= 8);
        }
    }
});

test("overview retains usable shot labels and hides only genuinely tiny unselected captions", () => {
    assert.equal(canvasNodeTitleLayout(315, 0.2, false).visible, false);
    assert.equal(canvasNodeTitleLayout(320, 0.2, false).visible, true);
    const overview = canvasNodeTitleLayout(315, 0.4, false);
    assert.equal(overview.visible, true);
    assert.equal(overview.width, 126);
    assert.ok(overview.offset < 4);
});

test("a selected tiny node keeps a bounded rename target and a readable editor", () => {
    const selected = canvasNodeTitleLayout(220, 0.2, true);
    assert.equal(selected.visible, true);
    assert.equal(selected.width, 64);
    const editing = canvasNodeTitleLayout(220, 0.2, false, true);
    assert.equal(editing.visible, true);
    assert.equal(editing.width, 280);
    assert.ok(32 + editing.offset < 42, "the editor must fit below the hover toolbar");
});
