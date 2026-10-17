import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createTextNode, createVideoNode } from "../constants.ts";
import { compileCanvasWorkflow, executeCanvasWorkflow, workflowInput, type WorkflowRun } from "./canvas-workflow-run.ts";
import type { CanvasConnection, CanvasDocument, CanvasNode } from "../types.ts";
const edge = (source: string, target: string): CanvasConnection => ({ id: `${source}-${target}`, source: { nodeId: source }, target: { nodeId: target } });
const fixtures = () => [createTextNode({ id: "text", text: "sunrise", position: { x: 0, y: 0 } }), createImageNode({ id: "image", position: { x: 0, y: 0 } }), createVideoNode({ id: "video", position: { x: 0, y: 0 } })];
const graph = [edge("text", "image"), edge("image", "video")];
function run(nodes: CanvasNode[]): WorkflowRun { return { status: "running", startedAt: "2026-09-27", force: false, snapshot: { scene: { nodes, connections: graph } } as CanvasDocument, steps: compileCanvasWorkflow(nodes, graph).map(node => ({ nodeId: node.id, title: node.title, kind: node.kind, status: "pending" })) }; }

test("目标执行包含上游且保持拓扑顺序", () => {
    assert.deepEqual(compileCanvasWorkflow(fixtures().reverse(), graph, ["video"]).map(n => n.id), ["text", "image", "video"]);
    assert.deepEqual(compileCanvasWorkflow(fixtures(), graph, ["image"]).map(n => n.id), ["text", "image"]);
});
test("循环与丢失节点明确阻止执行", () => {
    assert.throws(() => compileCanvasWorkflow(fixtures(), [...graph, edge("video", "text")]), /循环/);
    assert.throws(() => compileCanvasWorkflow(fixtures(), [edge("missing", "image")]), /不存在/);
});
test("条件来源参与拓扑和循环检测", () => {
    const nodes = fixtures(); nodes[1].workflowCondition = { sourceId: "video", operator: "hasOutput", value: "" };
    assert.throws(() => compileCanvasWorkflow(nodes, graph), /循环/);
});
test("失败停止下游且保留实际错误", async () => {
    const nodes = fixtures(), data = run(nodes), calls: string[] = [];
    await executeCanvasWorkflow({ run: data, nodes: () => nodes, connections: () => graph, signal: new AbortController().signal, checkpoint: async () => {}, execute: async node => { calls.push(node.id); throw new Error("channel unavailable"); } });
    assert.deepEqual(calls, ["image"]); assert.equal(data.status, "failed"); assert.equal(data.steps[1].error, "channel unavailable"); assert.equal(data.steps[2].status, "pending");
});
test("不满足条件阻断下游而非使用旧素材", async () => {
    const nodes = fixtures(); nodes[1].workflowCondition = { sourceId: "text", operator: "contains", value: "snow" };
    const data = run(nodes);
    await executeCanvasWorkflow({ run: data, nodes: () => nodes, connections: () => graph, signal: new AbortController().signal, checkpoint: async () => {}, execute: async () => assert.fail("must not generate") });
    assert.deepEqual(data.steps.map(s => s.status), ["reused", "skipped", "skipped"]);
});
test("续跑复用未变化结果，输入变化后重新生成", async () => {
    const nodes = fixtures(); const image = nodes[1]; if (image.kind !== "image") throw new Error(); image.content.source = "old-image";
    const prior = run(nodes); prior.steps[1] = { ...prior.steps[1], status: "succeeded", input: workflowInput(image, nodes, graph), output: "old-image" };
    const calls: string[] = [];
    await executeCanvasWorkflow({ run: run(nodes), nodes: () => nodes, connections: () => graph, prior, signal: new AbortController().signal, checkpoint: async () => {}, execute: async n => { calls.push(n.id); } });
    assert.deepEqual(calls, ["video"]);
    calls.length = 0; image.generation.prompt = "changed";
    await executeCanvasWorkflow({ run: run(nodes), nodes: () => nodes, connections: () => graph, prior, signal: new AbortController().signal, checkpoint: async () => {}, execute: async n => { calls.push(n.id); } });
    assert.deepEqual(calls, ["image", "video"]);
});
test("执行前日志保存失败不产生生成调用", async () => {
    const nodes = fixtures(); let calls = 0;
    await assert.rejects(executeCanvasWorkflow({ run: run(nodes), nodes: () => nodes, connections: () => graph, signal: new AbortController().signal, checkpoint: async () => { throw new Error("storage unavailable"); }, execute: async () => { calls++; } }), /storage unavailable/);
    assert.equal(calls, 0);
});
