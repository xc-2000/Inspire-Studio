import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createStoryboardNode, createTextNode, createVideoCompositionNode, createVideoNode } from "@/features/canvas/constants";
import type { CanvasConnection, CanvasNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { arrangeDramaChapterNodes } from "./drama-canvas-layout";
import { expandDramaShots } from "./drama-workspace";

const chapterId = "chapter-1";
const origin = { x: 20, y: 30 };
const edge = (source: string, target: string): CanvasConnection => ({ id: `${source}->${target}`, source: { nodeId: source }, target: { nodeId: target } });
const shot = (number: number): CanvasStoryboardShot => ({ id: `shot-${number}`, shotNumber: number, durationSeconds: 8,
    visualDescription: "画面", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "提示词", assetIds: [] });
const own = <T extends CanvasNode>(node: T): T => ({ ...node, dramaChapterId: chapterId });
const linked = <T extends CanvasNode>(node: T, number: number): T => ({ ...own(node), dramaStoryboardId: "board", dramaShotId: `shot-${number}` });
const video = (nodes: CanvasNode[], id: string) => {
    const node = nodes.find(node => node.id === id);
    if (node?.kind !== "video") throw new Error(`Video ${id} missing`);
    return node;
};

function assertNoOverlap(nodes: CanvasNode[]) {
    for (let index = 0; index < nodes.length; index++) {
        const first = nodes[index];
        for (const second of nodes.slice(index + 1)) {
            const a = first.frame, b = second.frame;
            assert.ok(a.position.x + a.width <= b.position.x || b.position.x + b.width <= a.position.x
                || a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y,
            `${first.id} overlaps ${second.id}`);
        }
    }
}

function fixture() {
    const board = own(createStoryboardNode({ id: "board", position: origin }));
    board.storyboard.shots = [shot(3), shot(1), shot(2)];
    const script = own(createTextNode({ id: "script", position: origin, text: "完整剧本" }));
    script.frame.width = 900; script.frame.height = 1200;
    const prompt1 = linked(createTextNode({ id: "prompt1", position: origin, text: "镜头一提示词" }), 1);
    prompt1.frame.width = 320; prompt1.frame.height = 950;
    const image1 = linked(createImageNode({ id: "image1", position: origin }), 1);
    image1.frame.width = 380; image1.frame.height = 1100; image1.content.source = "/portrait.png";
    const video1 = linked(createVideoNode({ id: "video1", position: origin }), 1);
    video1.frame.width = video1.frame.height = 630;
    video1.content = { source: "/take1.mp4", storageKey: "take1" };
    video1.execution = { phase: "succeeded", taskId: "task1" };
    const take1 = linked(createVideoNode({ id: "take1", position: origin }), 1);
    take1.frame.width = 800; take1.frame.height = 1000; take1.content.source = "/other-take.mp4";
    const video2 = linked(createVideoNode({ id: "video2", position: origin }), 2);
    video2.frame.height = 1250;
    video2.execution = { phase: "running", taskId: "live", progress: 45 };
    const video3 = linked(createVideoNode({ id: "video3", position: origin }), 3);
    const composition = own(createVideoCompositionNode({ id: "composition", position: origin }));
    composition.composition = { inputVideoNodeIds: [video1.id, video2.id], resultVideoNodeId: "final" };
    const result = own(createVideoNode({ id: "final", position: origin }));
    result.content.source = "/final.mp4";
    const orphan = linked(createVideoNode({ id: "old-shot", position: origin }), 100);
    orphan.content.source = "/historical-take.mp4";
    const note = own(createTextNode({ id: "note", position: origin, text: "其他备注" }));
    const nodes: CanvasNode[] = [script, board, prompt1, image1, video3, video1, take1, video2, composition, result, orphan, note];
    const connections = [edge("script", "board"), edge("board", "prompt1"), edge("prompt1", "image1"), edge("image1", "video1"), edge("board", "take1"), edge("composition", "final")];
    return { nodes, connections };
}

test("按镜号排列高竖图与多个视频版本，列宽和行高适应实际尺寸且不重叠", () => {
    const { nodes, connections } = fixture();
    const arranged = arrangeDramaChapterNodes(nodes, chapterId, connections);
    const at = (id: string) => arranged.find(node => node.id === id)!;
    assertNoOverlap(arranged);
    assert.equal(at("prompt1").frame.position.y, at("image1").frame.position.y);
    assert.equal(at("image1").frame.position.y, at("video1").frame.position.y);
    assert.equal(at("video1").frame.position.y, at("take1").frame.position.y);
    assert.ok(at("video2").frame.position.y >= at("video1").frame.position.y + 1100 + 120);
    assert.ok(at("video3").frame.position.y >= at("video2").frame.position.y + 1250 + 120);
    for (const [first, second] of [["script", "board"], ["board", "prompt1"], ["prompt1", "image1"], ["image1", "video1"], ["video1", "take1"], ["take1", "composition"], ["composition", "final"]]) {
        assert.ok(at(second).frame.position.x >= at(first).frame.position.x + at(first).frame.width + 120, `${first} -> ${second}`);
    }
    const mainBottom = Math.max(...arranged.filter(node => !["old-shot", "note"].includes(node.id)).map(node => node.frame.position.y + node.frame.height));
    assert.ok(at("old-shot").frame.position.y >= mainBottom + 120);
    assert.equal(video(arranged, "old-shot").content.source, "/historical-take.mp4");
});

test("布局只改变坐标，全部媒体、执行状态、尺寸、连线和原始输入保持不变且重复调用幂等", () => {
    const { nodes, connections } = fixture();
    const snapshot = JSON.stringify({ nodes, connections });
    const arranged = arrangeDramaChapterNodes(nodes, chapterId, connections);
    assert.equal(JSON.stringify({ nodes, connections }), snapshot);
    assert.deepEqual(arranged.map(node => node.id), nodes.map(node => node.id));
    arranged.forEach((node, index) => {
        const original = nodes[index];
        assert.deepEqual({ ...node, frame: { ...node.frame, position: original.frame.position } }, original);
        assert.strictEqual(node.execution, original.execution);
        if ("content" in node && "content" in original) assert.strictEqual(node.content, original.content);
    });
    assert.strictEqual(arrangeDramaChapterNodes(arranged, chapterId, connections), arranged);
});

test("仅移动当前章节及无显式归属的本章镜头，不移动其他章节或连向外章的节点", () => {
    const { nodes, connections } = fixture();
    const foreignBoard = { ...createStoryboardNode({ id: "foreign-board", position: origin }), dramaChapterId: "chapter-2" };
    const foreign = { ...linked(createVideoNode({ id: "foreign", position: origin }), 1), dramaChapterId: "chapter-2" };
    const foreignLinked = { ...linked(createVideoNode({ id: "foreign-linked", position: origin }), 1), dramaStoryboardId: "foreign-board" };
    const global = createTextNode({ id: "global", position: origin });
    const inferred = linked(createVideoNode({ id: "inferred", position: origin }), 2);
    delete inferred.dramaChapterId;
    const all = [...nodes, foreignBoard, foreign, foreignLinked, global, inferred];
    const arranged = arrangeDramaChapterNodes(all, chapterId, connections);
    for (const unchanged of [foreignBoard, foreign, foreignLinked, global]) assert.strictEqual(arranged.find(node => node.id === unchanged.id), unchanged);
    assert.notStrictEqual(arranged.find(node => node.id === inferred.id), inferred);
    assert.strictEqual(arrangeDramaChapterNodes(all, "missing", connections), all);
});

test("同镜号遵循原数组顺序，无分镜的孤立节点也能稳定整理", () => {
    const { nodes, connections } = fixture();
    const board = nodes.find(node => node.kind === "storyboard")!;
    if (board.kind !== "storyboard") throw new Error("board missing");
    board.storyboard.shots.forEach(shot => { shot.shotNumber = 1; });
    const arranged = arrangeDramaChapterNodes(nodes, chapterId, connections);
    assert.ok(arranged.find(node => node.id === "video3")!.frame.position.y < arranged.find(node => node.id === "video1")!.frame.position.y);
    const orphans = [own(createTextNode({ id: "a", position: origin })), own(createVideoNode({ id: "b", position: origin }))];
    const ordered = arrangeDramaChapterNodes(orphans, chapterId);
    assertNoOverlap(ordered);
    assert.strictEqual(arrangeDramaChapterNodes(ordered, chapterId), ordered);
});

test("新增展开节点会按镜头整理已有成片，重复展开不覆盖手动布局", () => {
    const { nodes, connections } = fixture();
    const expanded = expandDramaShots(nodes, connections, "board", ["shot-1", "shot-2"]);
    assertNoOverlap(expanded.nodes);
    assert.equal(video(expanded.nodes, "video1").content.source, "/take1.mp4");
    const manuallyMoved = expanded.nodes.map(node => node.id === "board:shot-1:video" ? { ...node, frame: { ...node.frame, position: { x: -300, y: 7000 } } } : node);
    const repeated = expandDramaShots(manuallyMoved, expanded.connections, "board", ["shot-1", "shot-2"]);
    assert.strictEqual(repeated.nodes, manuallyMoved);
    assert.strictEqual(repeated.connections, expanded.connections);
    assert.deepEqual(repeated.nodes.find(node => node.id === "board:shot-1:video")!.frame.position, { x: -300, y: 7000 });
});
