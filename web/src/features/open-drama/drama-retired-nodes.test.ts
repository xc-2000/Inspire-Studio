import test from "node:test";
import assert from "node:assert/strict";
import { createTextNode, createImageNode, createVideoNode, createStoryboardNode, createVideoCompositionNode } from "@/features/canvas/constants";
import type { CanvasNode, CanvasConnection, CanvasStoryboardShot } from "@/features/canvas/types";
import { collectRetiredDramaNodeIds, removeRetiredDramaNodes } from "./drama-retired-nodes";

const position = { x: 0, y: 0 };
const own = <T extends CanvasNode>(node: T): T => ({ ...node, dramaChapterId: "chapter" });
const edge = (source: string, target: string): CanvasConnection => ({ id: `${source}-${target}`, source: { nodeId: source }, target: { nodeId: target } });
function fixture(legacy = true) {
    const board = own(createStoryboardNode({ id: "board", position }));
    board.storyboard.shots = [{ id: "current" } as CanvasStoryboardShot];
    const script = own(createTextNode({ id: "script", position }));
    const activeVideo = { ...own(createVideoNode({ id: "current", position })), dramaStoryboardId: "board", dramaShotId: "current" };
    activeVideo.content.source = "/current.mp4";
    const retired = [own(createTextNode({ id: "board:old:prompt", position })), own(createImageNode({ id: "board:old:image", position }))].map(node => ({ ...node,
        title: legacy ? `历史 · ${node.title}` : node.title, ...(!legacy ? { dramaStoryboardId: "board", dramaShotId: "old" } : {}),
    }));
    const video = own(createVideoNode({ id: "derived-video", position })); video.content.source = "/old.mp4";
    const composition = own(createVideoCompositionNode({ id: "composition", position }));
    composition.composition = { inputVideoNodeIds: [video.id], resultVideoNodeId: "result" };
    const result = own(createVideoNode({ id: "result", position })); result.content.source = "/old-final.mp4";
    const nodes: CanvasNode[] = [script, board, activeVideo, ...retired, video, composition, result];
    const connections = [edge(script.id, board.id), edge(board.id, retired[0].id), edge(retired[0].id, retired[1].id), edge(retired[1].id, video.id), edge(video.id, composition.id), edge(composition.id, result.id)];
    return { nodes, connections };
}

test("旧版节点连同独立旧合成归档，当前分镜和用户节点不变", () => {
    const { nodes, connections } = fixture();
    const arbitrary = own(createTextNode({ id: "personal", title: "历史 · 我的笔记", position }));
    nodes.push(arbitrary);
    const before = structuredClone({ nodes, connections });
    const result = removeRetiredDramaNodes(nodes, connections, "chapter");
    assert.equal(result.removedIds.length, 5);
    assert.deepEqual(result.nodes.map(node => node.id), ["script", "board", "current", "personal"]);
    result.nodes.forEach(node => assert.strictEqual(node, nodes.find(original => original.id === node.id)));
    assert.deepEqual(result.connections, [connections[0]]);
    assert.deepEqual({ nodes, connections }, before);
    assert.strictEqual(removeRetiredDramaNodes(result.nodes, result.connections, "chapter").nodes, result.nodes);
});
test("新分镜替换后不必清空旧节点归属即可找到整条旧链", () => {
    const { nodes, connections } = fixture(false);
    assert.equal(collectRetiredDramaNodeIds(nodes, connections, "chapter").length, 5);
});
test("当前镜头、另章镜头和未关联的同名节点不会误删", () => {
    const { nodes, connections } = fixture();
    const active = { ...own(createImageNode({ id: "board:current:image", position, title: "历史 · 图片" })) };
    const foreign = { ...own(createImageNode({ id: "board:foreign:image", position, title: "历史 · 图片" })), dramaChapterId: "other" };
    nodes.push(active, foreign);
    const ids = collectRetiredDramaNodeIds(nodes, connections, "chapter");
    assert.ok(!ids.includes(active.id)); assert.ok(!ids.includes(foreign.id));
    assert.deepEqual(collectRetiredDramaNodeIds(nodes, connections, "absent"), []);
});
test("时间线引用、运行任务和对外连接会保护整条旧依赖", () => {
    for (const condition of ["timeline", "running", "external"] as const) {
        const { nodes, connections } = fixture();
        if (condition === "running") nodes.find(node => node.id === "derived-video")!.execution.phase = "running";
        if (condition === "external") connections.push(edge("derived-video", "current"));
        const options = condition === "timeline" ? { protectedNodeIds: new Set(["result"]) } : {};
        assert.deepEqual(collectRetiredDramaNodeIds(nodes, connections, "chapter", options), [], condition);
    }
});
test("混合当前镜头的合成及无连线的合成属性引用均被保护", () => {
    const { nodes, connections } = fixture();
    const composition = nodes.find(node => node.kind === "videoComposition")!;
    if (composition.kind !== "videoComposition") throw new Error("missing");
    composition.composition.inputVideoNodeIds.push("current");
    const withoutCompositionEdges = connections.filter(e => e.target.nodeId !== "composition" && e.source.nodeId !== "composition");
    assert.deepEqual(collectRetiredDramaNodeIds(nodes, withoutCompositionEdges, "chapter"), []);
});
