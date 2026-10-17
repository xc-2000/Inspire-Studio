import assert from "node:assert/strict";
import test from "node:test";
import { resolveCanvasAgentTool } from "../utils/canvas-agent-tools.ts";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops.ts";
import { canvasTextGenerationInstruction } from "./canvas-text-generation.ts";

test("a new Agent text generation keeps its creation instruction after saving and reloading", () => {
    const execution = resolveCanvasAgentTool("canvas_generate_text", { prompt: "写一段产品介绍" }, () => "new");
    assert.ok(execution);
    const before: CanvasAgentSnapshot = { projectId: "project", title: "canvas", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    const applied = applyCanvasAgentOps(before, execution.ops.filter((op) => op.type !== "run_generation"));
    const restored = JSON.parse(JSON.stringify(applied.nodes[0]));
    assert.equal(restored.content.role, "generation-prompt");
    assert.equal(canvasTextGenerationInstruction(restored.content, "写一段产品介绍"), "写一段产品介绍");
});

test("an existing text node retains its original text and explicit rewrite request", () => {
    const instruction = canvasTextGenerationInstruction({ text: "已有介绍", fontSize: 14 }, "缩短到一句话");
    assert.match(instruction, /原文：\n已有介绍/);
    assert.match(instruction, /修改要求：\n缩短到一句话/);
    assert.equal(canvasTextGenerationInstruction({ text: "", fontSize: 14 }, "写一段介绍"), "写一段介绍");
});
