import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanvasKeyboardCommand } from "./canvas-keyboard-shortcuts.ts";

test("画布快捷键将组合键解析为明确命令", () => {
    assert.equal(resolveCanvasKeyboardCommand({ key: "z", control: true, meta: false, alt: false, shift: false }), "undo");
    assert.equal(resolveCanvasKeyboardCommand({ key: "z", control: true, meta: false, alt: false, shift: true }), "redo");
    assert.equal(resolveCanvasKeyboardCommand({ key: "Delete", control: false, meta: false, alt: false, shift: false }), "delete");
    assert.equal(resolveCanvasKeyboardCommand({ key: "Escape", control: false, meta: false, alt: false, shift: false }), "cancel");
});

test("Alt 组合键和普通输入不会触发画布命令", () => {
    assert.equal(resolveCanvasKeyboardCommand({ key: "z", control: true, meta: false, alt: true, shift: false }), null);
    assert.equal(resolveCanvasKeyboardCommand({ key: "a", control: false, meta: false, alt: false, shift: false }), null);
});

test("Ctrl D 和 Command D 复制选区，普通 D 不接管", () => {
    assert.equal(resolveCanvasKeyboardCommand({ key: "d", control: true, meta: false, alt: false, shift: false }), "duplicate");
    assert.equal(resolveCanvasKeyboardCommand({ key: "D", control: false, meta: true, alt: false, shift: false }), "duplicate");
    assert.equal(resolveCanvasKeyboardCommand({ key: "d", control: false, meta: false, alt: false, shift: false }), null);
});
