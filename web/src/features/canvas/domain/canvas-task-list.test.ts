import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createStoryboardNode, createVideoNode } from "../constants.ts";
import { canvasTaskRows } from "./canvas-task-list.ts";

test("任务面板包含其他章节任务，进行中和失败优先且忽略普通导入图片", () => {
    const imported = createImageNode({ id: "imported", position: { x: 0, y: 0 } });
    imported.execution.phase = "succeeded";
    const completed = createVideoNode({ id: "completed", position: { x: 0, y: 0 } });
    completed.execution = { phase: "succeeded", completedAt: "2026-09-30" };
    const failed = createImageNode({ id: "failed", position: { x: 0, y: 0 } });
    failed.execution = { phase: "failed", taskId: "failed-task", errorMessage: "引用无效" };
    const running = { ...createVideoNode({ id: "running", position: { x: 0, y: 0 } }), dramaChapterId: "chapter-other" };
    running.execution = { phase: "running", taskId: "video-task", progress: 42 };
    const rows = canvasTaskRows([imported, completed, failed, running]);
    assert.deepEqual(rows.map(row => row.nodeId), ["running", "failed", "completed"]);
    assert.equal(rows[1].error, "引用无效");
    assert.equal(rows[0].progress, 42);
});

test("镜头批次逐项展示已保存任务号，移除镜头不再展示幽灵任务", () => {
    const board = createStoryboardNode({ id: "board", title: "第二章", position: { x: 0, y: 0 } });
    board.storyboard.shots = [{ id: "shot", shotNumber: 4, durationSeconds: 5, visualDescription: "", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "", assetIds: [] }];
    board.storyboard.shotImageGeneration = { batchId: "batch", phase: "running", selectedShotIds: ["shot", "deleted"], tasks: { shot: { status: "running", taskId: "image-task", progress: 65 }, deleted: { status: "failed", progress: 0 } } };
    const rows = canvasTaskRows([board]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "第二章 · 镜头 4 图片");
    assert.equal(rows[0].taskId, "image-task");
    assert.equal(rows[0].itemId, "shot");
    assert.equal(rows[0].category, "shotImage");
});

test("资产批次不会同时显示重复的父节点失败记录", () => {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    board.execution = { phase: "failed", taskId: "", errorMessage: "部分资产失败" };
    board.storyboard.assets = [{ id: "actor", kind: "character", name: "主角", description: "" }];
    board.storyboard.assetGeneration = { phase: "failed", selectedAssetIds: ["actor"], statuses: { actor: "failed" }, taskIds: { actor: "task-actor" }, errors: { actor: "下载失败" }, progress: 100, settings: { model: "model", quality: "auto", imageResolution: "1k", size: "1:1" } };
    const rows = canvasTaskRows([board]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, "assetImage");
    assert.equal(rows[0].error, "下载失败");
});

test("历史失败视频显示参考图超时原因，并保留原任务记录", () => {
    const node = createVideoNode({ id: "saved-video", position: { x: 0, y: 0 } });
    const originalError = '参数 ref_image_0 URL地址不合法/不存在: Get "https://public.r2.dev/reference.png": net/http: timeout awaiting response headers';
    node.execution = { phase: "failed", taskId: "saved-task", errorMessage: originalError };
    const [row] = canvasTaskRows([node]);
    assert.equal(row.error, "视频渠道读取参考图片超时，请重试");
    assert.equal(row.taskId, "saved-task");
    assert.equal(row.phase, "failed");
    assert.equal(node.execution.errorMessage, originalError);
});
