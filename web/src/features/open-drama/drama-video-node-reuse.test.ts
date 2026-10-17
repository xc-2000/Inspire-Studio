import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasConnection, CanvasNode, CanvasStoryboardNode, CanvasVideoNode } from "@/features/canvas/types";
import { createStoryboardNode } from "@/features/canvas/constants";
import { collectRedundantFailedDramaVideoNodeIds, findReusableDramaVideoNode } from "./drama-video-node-reuse";

function board(id = "board"): CanvasStoryboardNode {
    const node = createStoryboardNode({ id, position: { x: 0, y: 0 } });
    node.storyboard.shots = [{ id: "six", shotNumber: 6, durationSeconds: 10, visualDescription: "镜头六", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "镜头六", videoPrompt: "镜头六", assetIds: [] }];
    return node;
}
function failed(id: string, extra: Partial<CanvasVideoNode> = {}): CanvasVideoNode {
    return { id, kind: "video", dramaStoryboardId: "board", dramaShotId: "six", execution: { phase: "failed", errorMessage: "前镜未完成" }, content: { source: "" }, generation: { prompt: "镜头六", model: "muse", references: [] }, ...extra } as CanvasVideoNode;
}
function edges(nodes: CanvasNode[]): CanvasConnection[] {
    return nodes.filter(node => node.kind === "video" && node.dramaStoryboardId).map(node => ({ id: `edge-${node.id}`, source: { nodeId: node.dramaStoryboardId! }, target: { nodeId: node.id } }));
}

test("reuses the most recent empty failure without mutating the scene", () => {
    const nodes = [board(), failed("older"), failed("latest")];
    const before = JSON.stringify(nodes);
    assert.equal(findReusableDramaVideoNode(nodes, edges(nodes), "board", "six")?.id, "latest");
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, edges(nodes)), ["older"]);
    assert.equal(JSON.stringify(nodes), before);
});

test("keeps the most recent timestamped attempt even if node order changes or an old failure completes late", () => {
    const nodes = [board(), failed("new", { execution: { phase: "failed", startedAt: "2026-10-07T10:10:00Z" } }), failed("old", { execution: { phase: "failed", startedAt: "2026-10-07T10:00:00Z", completedAt: "2026-10-07T10:20:00Z" } })];
    assert.equal(findReusableDramaVideoNode(nodes, edges(nodes), "board", "six")?.id, "new");
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, edges(nodes)), ["old"]);
});

test("never reuses successful, running, idle, or previously saved media nodes", () => {
    const nodes = [board(), failed("one"), failed("success", { execution: { phase: "succeeded" } }), failed("running", { execution: { phase: "running" } }), failed("idle", { execution: { phase: "idle" } }), failed("media", { content: { source: "/saved.mp4" } }), failed("storage", { content: { source: "", storageKey: "saved" } })];
    assert.equal(findReusableDramaVideoNode(nodes, edges(nodes), "board", "six")?.id, "one");
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, edges(nodes)), []);
});

test("preserves the sole failure even when a later successful video exists", () => {
    const nodes = [board(), failed("failed"), failed("success", { execution: { phase: "succeeded" }, content: { source: "/success.mp4" } })];
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, edges(nodes)), []);
});

test("preserves manual prompt edits, different settings, missing shot links and disconnected nodes", () => {
    const original = failed("original");
    const nodes = [board(), original, failed("edited", { generation: { ...original.generation, prompt: "自己编辑的提示词" } }), failed("other-model", { generation: { ...original.generation, model: "different" } }), failed("manual", { dramaStoryboardId: undefined, dramaShotId: undefined }), failed("removed", { dramaShotId: "missing" }), failed("disconnected")];
    const connections = edges(nodes).filter(edge => edge.target.nodeId !== "disconnected");
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, connections), []);
    assert.notEqual(findReusableDramaVideoNode(nodes, connections, "board", "six")?.id, "disconnected");
});

test("protects outgoing workflows, external inputs, background groups, composition references and explicit protected ids", () => {
    const nodes: CanvasNode[] = [board(), failed("base"), failed("output"), failed("input"), failed("grouped"), failed("composition-source"), failed("timeline"), { id: "group", kind: "background", memberNodeIds: ["grouped"] } as CanvasNode, { id: "composition", kind: "videoComposition", composition: { inputVideoNodeIds: ["composition-source"] } } as CanvasNode];
    const connections = [...edges(nodes), { id: "out", source: { nodeId: "output" }, target: { nodeId: "consumer" } }, { id: "in", source: { nodeId: "reference" }, target: { nodeId: "input" } }];
    const options = { protectedNodeIds: new Set(["timeline"]) };
    assert.equal(findReusableDramaVideoNode(nodes, connections, "board", "six", options)?.id, "base");
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, connections, options), []);
});

test("cleanup is scoped to board and preserves latest failure independently of successful/active nodes", () => {
    const nodes = [board(), board("other"), failed("one"), failed("two"), failed("three", { execution: { phase: "running" } }), failed("other-one", { dramaStoryboardId: "other" }), failed("other-two", { dramaStoryboardId: "other" })];
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, edges(nodes), { boardId: "board" }), ["one"]);
    assert.deepEqual(collectRedundantFailedDramaVideoNodeIds(nodes, edges(nodes)), ["one", "other-one"]);
});
