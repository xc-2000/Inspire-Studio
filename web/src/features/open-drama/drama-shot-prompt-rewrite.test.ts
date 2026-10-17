import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createStoryboardNode, createVideoNode } from "@/features/canvas/constants";
import type { CanvasNode, CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { applyDramaShotPromptRewrite, prepareDramaShotPromptRewrite, restoreDramaShotPromptRewrite } from "./drama-shot-prompt-rewrite";

function shot(id: string, number: number): CanvasStoryboardShot {
    return { id, shotNumber: number, durationSeconds: 10, visualDescription: id + "的画面", shotSize: "中景", lightingAtmosphere: "清晨", dialogueVoiceover: "人物说话", soundEffect: "风声", cameraMovement: "缓慢推进", finalPrompt: "旧通用词", imagePrompt: "图片词保持原样", videoPrompt: id + "的视频词", assetIds: ["hero"], continuity: { sceneId: "yard", time: "清晨", transition: number === 1 ? "establish" : "continue", openingState: "站立", closingState: "走近", storyBeat: "发现线索" }, image: { source: "/shot.png" }, video: { source: "/original.mp4" } };
}
function fixture(): CanvasNode[] {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    board.storyboard.shots = [shot("before", 1), shot("current", 2), shot("after", 3), shot("far", 4)];
    board.storyboard.assets = [{ id: "hero", kind: "character", name: "林岁安", description: "蓝衣女子", image: { source: "https://private.invalid/character.png" } }];
    const linked = createVideoNode({ id: "linked", position: { x: 500, y: 0 } });
    linked.dramaStoryboardId = "board";
    linked.dramaShotId = "current";
    linked.generation.prompt = "current的视频词";
    linked.generation.seconds = "custom-draft";
    linked.execution = { phase: "failed", errorMessage: "提示词太长" };
    const image = createImageNode({ id: "image", position: { x: 500, y: 500 } });
    image.dramaStoryboardId = "board";
    image.dramaShotId = "current";
    image.generation.prompt = "尚未同步的用户图片草稿";
    return [board, linked, image];
}
function boardIn(nodes: CanvasNode[]): CanvasStoryboardNode {
    return nodes.find((node): node is CanvasStoryboardNode => node.kind === "storyboard")!;
}
function currentIn(nodes: CanvasNode[]) { return boardIn(nodes).storyboard.shots[1]; }
function editShot(nodes: CanvasNode[], patch: Partial<CanvasStoryboardShot>): CanvasNode[] {
    return nodes.map(node => node.kind === "storyboard" ? { ...node, storyboard: { ...node.storyboard, shots: node.storyboard.shots.map(item => item.id === "current" ? { ...item, ...patch } : item) } } : node);
}

test("rewrite changes only target video prompt and context mode, synchronizing expanded video", () => {
    const nodes = fixture();
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    const original = currentIn(nodes);
    const result = applyDramaShotPromptRewrite(nodes, snapshot, "  新的完整视频描述  ");
    assert.deepEqual(currentIn(result), { ...original, videoPrompt: "新的完整视频描述", videoPromptContextMode: "self-contained" });
    assert.equal(boardIn(result).storyboard.shots[0], boardIn(nodes).storyboard.shots[0]);
    const linked = result.find(node => node.id === "linked")!;
    assert.ok(linked.kind === "video");
    assert.equal(linked.generation.prompt, "新的完整视频描述");
    assert.equal(linked.generation.seconds, "custom-draft");
    assert.equal(result.find(node => node.id === "image"), nodes.find(node => node.id === "image"));
    assert.equal(currentIn(nodes), original);
});

test("late results reject prompt, scene, identity, adjacent plot edits and deleted shots", () => {
    const nodes = fixture();
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    for (const patch of [{ videoPrompt: "手动编辑" }, { visualDescription: "另一个场景" }, { image: { source: "/new-identity.png" } }]) {
        assert.throws(() => applyDramaShotPromptRewrite(editShot(nodes, patch), snapshot, "改写词"), /改写期间/);
    }
    const changedAsset = nodes.map(node => node.kind === "storyboard" ? { ...node, storyboard: { ...node.storyboard, assets: node.storyboard.assets.map(asset => ({ ...asset, description: "换了角色" })) } } : node);
    assert.throws(() => applyDramaShotPromptRewrite(changedAsset, snapshot, "改写词"), /改写期间/);
    const changedAdjacent = nodes.map(node => node.kind === "storyboard" ? { ...node, storyboard: { ...node.storyboard, shots: node.storyboard.shots.map(item => item.id === "before" ? { ...item, visualDescription: "前镜改了" } : item) } } : node);
    assert.throws(() => applyDramaShotPromptRewrite(changedAdjacent, snapshot, "改写词"), /改写期间/);
    assert.throws(() => applyDramaShotPromptRewrite(nodes.filter(node => node.kind !== "storyboard"), snapshot, "改写词"), /删除或替换/);
    const removed = nodes.map(node => node.kind === "storyboard" ? { ...node, storyboard: { ...node.storyboard, shots: [] } } : node);
    assert.throws(() => applyDramaShotPromptRewrite(removed, snapshot, "改写词"), /删除或替换/);
});

test("runtime video results and error updates do not invalidate the source snapshot", () => {
    const nodes = fixture();
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    const saved = editShot(nodes, { video: { source: "/new-result.mp4", storageKey: "new-key" } }).map(node => node.id === "linked" ? { ...node, execution: { phase: "failed" as const, errorMessage: "更新的任务错误" } } : node);
    const result = applyDramaShotPromptRewrite(saved, snapshot, "新的完整提示词");
    assert.equal(currentIn(result).video?.source, "/new-result.mp4");
});

test("blank source, blank output and unchanged output cannot alter the original prompt", () => {
    const nodes = fixture();
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    assert.throws(() => prepareDramaShotPromptRewrite(editShot(nodes, { videoPrompt: " " }), "board", "current"), /先填写/);
    assert.throws(() => applyDramaShotPromptRewrite(nodes, snapshot, "  "), /结果为空/);
    assert.throws(() => applyDramaShotPromptRewrite(nodes, snapshot, " " + snapshot.prompt + " "), /相同/);
});

test("active storyboard or linked video prevents preparation, application and undo", () => {
    const nodes = fixture();
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    for (const id of ["board", "linked"]) {
        const active = nodes.map(node => node.id === id ? { ...node, execution: { phase: "running" as const } } : node);
        assert.throws(() => prepareDramaShotPromptRewrite(active, "board", "current"), /正在生成/);
        assert.throws(() => applyDramaShotPromptRewrite(active, snapshot, "改写词"), /正在生成/);
    }
    const applied = applyDramaShotPromptRewrite(nodes, snapshot, "改写词");
    const active = applied.map(node => node.id === "linked" ? { ...node, execution: { phase: "running" as const } } : node);
    assert.throws(() => restoreDramaShotPromptRewrite(active, snapshot, "改写词"), /正在生成/);
});

test("undo restores only prompt fields, preserving subsequent unrelated edits and video results", () => {
    const nodes = fixture();
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    const applied = applyDramaShotPromptRewrite(nodes, snapshot, "改写词");
    const edited = editShot(applied, { imagePrompt: "后来编辑的图片词", cameraMovement: "后来编辑的运镜", durationSeconds: 15, video: { source: "/later-result.mp4" } });
    const restored = restoreDramaShotPromptRewrite(edited, snapshot, "改写词");
    assert.equal(currentIn(restored).videoPrompt, snapshot.originalVideoPrompt);
    assert.equal(Object.hasOwn(currentIn(restored), "videoPromptContextMode"), false);
    assert.equal(currentIn(restored).imagePrompt, "后来编辑的图片词");
    assert.equal(currentIn(restored).cameraMovement, "后来编辑的运镜");
    assert.equal(currentIn(restored).durationSeconds, 15);
    assert.equal(currentIn(restored).video?.source, "/later-result.mp4");
    const video = restored.find(node => node.id === "linked")!;
    assert.ok(video.kind === "video");
    assert.equal(video.generation.prompt, snapshot.originalVideoPrompt);
    assert.throws(() => restoreDramaShotPromptRewrite(editShot(applied, { videoPrompt: "再次手动编辑" }), snapshot, "改写词"), /再次修改/);
    assert.throws(() => restoreDramaShotPromptRewrite(editShot(applied, { videoPromptContextMode: undefined }), snapshot, "改写词"), /再次修改/);
});

test("undo preserves absence of original prompt and restores existing self-contained mode", () => {
    const nodes = editShot(fixture(), { videoPrompt: undefined, videoPromptContextMode: "self-contained" });
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    const restored = restoreDramaShotPromptRewrite(applyDramaShotPromptRewrite(nodes, snapshot, "改写词"), snapshot, "改写词");
    assert.equal(Object.hasOwn(currentIn(restored), "videoPrompt"), false);
    assert.equal(currentIn(restored).videoPromptContextMode, "self-contained");
    assert.equal(currentIn(restored).finalPrompt, "旧通用词");
});

test("context is bounded valid JSON with adjacent plot and metadata but no images or full story", () => {
    let nodes = fixture();
    const snapshot = prepareDramaShotPromptRewrite(nodes, "board", "current");
    assert.equal(snapshot.failureReason, "提示词太长");
    const context = JSON.parse(snapshot.storyboardContext);
    assert.equal(context.previousShot.id, "before");
    assert.equal(context.nextShot.id, "after");
    assert.equal(context.assets[0].name, "林岁安");
    assert.equal(snapshot.storyboardContext.includes("private.invalid"), false);
    assert.equal(snapshot.storyboardContext.includes("/shot.png"), false);
    assert.equal(snapshot.storyboardContext.includes("far的画面"), false);
    const huge = '\\\"巨长描述'.repeat(10000);
    nodes = nodes.map(node => node.kind === "storyboard" ? { ...node, content: { ...node.content, visualStyle: huge }, storyboard: { ...node.storyboard,
        assets: Array.from({ length: 100 }, (_, index) => ({ id: "asset-" + index, kind: "character" as const, name: huge, description: huge })),
        shots: node.storyboard.shots.map(item => ({ ...item, visualDescription: huge, videoPrompt: huge, assetIds: Array.from({ length: 100 }, (_, index) => "asset-" + index) })) } } : node);
    const bounded = prepareDramaShotPromptRewrite(nodes, "board", "current");
    assert.ok(bounded.storyboardContext.length <= 12000);
    assert.equal(JSON.parse(bounded.storyboardContext).omittedAssetCount, 80);
});
