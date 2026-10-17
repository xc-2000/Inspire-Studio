import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode, createVideoNode } from "@/features/canvas/constants";
import { applyCanvasNodeAttributes } from "@/features/canvas/domain/canvas-node";
import type { CanvasStoryboardNode, CanvasStoryboardShot, CanvasVideoNode } from "@/features/canvas/types";
import { assertDramaVideoShotUnchanged, captureDramaVideoShot, dramaShotVideoSignature } from "./drama-video-continuity";
import { reconcileDramaNodes } from "./drama-workspace";

function fixture() {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    board.dramaChapterId = "chapter";
    board.storyboard.assets = [{ id: "hero", kind: "character", name: "林夏", description: "蓝色衣服", image: { source: "/hero-blue.png" } }];
    const first: CanvasStoryboardShot = { id: "first", shotNumber: 1, durationSeconds: 8, visualDescription: "人物走到桌前", shotSize: "中景",
        lightingAtmosphere: "白天", dialogueVoiceover: "", soundEffect: "", cameraMovement: "固定", finalPrompt: "走到桌前", assetIds: [],
        continuity: { sceneId: "房间", time: "午后", transition: "establish", openingState: "站在门边", closingState: "停在桌旁", storyBeat: "发现信件" },
        video: { source: "/first.mp4", storageKey: "video:first" } };
    const next: CanvasStoryboardShot = { ...first, id: "next", shotNumber: 2, visualDescription: "人物拿起信件", finalPrompt: "拿起信件", assetIds: ["hero"],
        continuity: { ...first.continuity!, transition: "continue", openingState: "停在桌旁", closingState: "信件拿在手上", storyBeat: "阅读消息" }, video: undefined };
    board.storyboard.shots = [first, next];
    first.video!.sourceSignature = dramaShotVideoSignature(first, board);
    const plan = captureDramaVideoShot(board, next.id);
    const node = createVideoNode({ id: "expanded-video", position: { x: 600, y: 0 } });
    node.dramaChapterId = "chapter";
    node.dramaStoryboardId = board.id;
    node.dramaShotId = next.id;
    node.dramaVideoPlan = plan;
    node.execution = { phase: "running", taskId: "task-original", progress: 50 };
    node.generation = { ...node.generation, prompt: next.finalPrompt, seconds: "8", model: "model-A", size: "16:9" };
    return { board, first, next, plan, node };
}

test("applyCanvasNodeAttributes写入视频结果时保留提交时的完整dramaVideoPlan", () => {
    const { node, plan } = fixture();
    const updated = applyCanvasNodeAttributes(node, { content: "/result.mp4", storageKey: "video:result", status: "success", progress: 100 });
    assert.equal(updated.kind, "video");
    if (updated.kind !== "video") return;
    assert.deepEqual(updated.dramaVideoPlan, plan);
    assert.equal(updated.dramaVideoPlan?.previousVideoStorageKey, "video:first");
    assert.equal(updated.dramaShotId, "next");
    assert.equal(updated.content.source, "/result.mp4");
    assert.equal(node.content.source, "", "原始运行中节点保持不变");
});

test("reconcile写回视频时使用原始plan签名和前镜依赖，不将过期结果盖为当前签名", () => {
    const { board, next, node, plan } = fixture();
    const changedBoard: CanvasStoryboardNode = { ...board, storyboard: { ...board.storyboard,
        assets: board.storyboard.assets.map(asset => ({ ...asset, description: "用户改为红色衣服", image: { source: "/hero-red.png" } })) } };
    const completed = applyCanvasNodeAttributes(node, { content: "/old-input-result.mp4", storageKey: "video:old-result", status: "success" });
    const updated = reconcileDramaNodes([board, node], [changedBoard, completed]);
    const updatedBoard = updated.find(item => item.id === board.id) as CanvasStoryboardNode;
    const savedShot = updatedBoard.storyboard.shots.find(shot => shot.id === next.id)!;
    assert.equal(savedShot.video?.sourceSignature, plan.signature);
    assert.equal(savedShot.video?.previousVideoStorageKey, plan.previousVideoStorageKey);
    assert.notEqual(savedShot.video?.sourceSignature, dramaShotVideoSignature(savedShot, updatedBoard));
    assert.deepEqual((updated.find(item => item.id === node.id) as CanvasVideoNode).dramaVideoPlan, plan);
});

test("刷新序列化后仍以原始plan核对，拒绝期间改剧情或替换前镜的晚到结果", () => {
    for (const change of ["story", "previous-video"] as const) {
        const { board, node, plan } = fixture();
        const saved = JSON.parse(JSON.stringify({ board, node })) as { board: CanvasStoryboardNode; node: CanvasVideoNode };
        assert.deepEqual(saved.node.dramaVideoPlan, plan);
        assert.doesNotThrow(() => assertDramaVideoShotUnchanged(saved.node.dramaVideoPlan!, saved.board));
        if (change === "story") saved.board.storyboard.shots[1].visualDescription = "改为撕碎信件";
        else saved.board.storyboard.shots[0].video = { ...saved.board.storyboard.shots[0].video!, source: "/first-new.mp4", storageKey: "video:first-new" };
        assert.throws(() => assertDramaVideoShotUnchanged(saved.node.dramaVideoPlan!, saved.board), /分镜或参考素材已修改|前镜视频已替换/);
        assert.deepEqual(saved.node.dramaVideoPlan, plan, "拒绝时不得用新状态重写旧plan");
    }
});
