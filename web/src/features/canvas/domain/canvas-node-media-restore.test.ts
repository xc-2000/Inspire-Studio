import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createVideoNode } from "../constants.ts";
import { resetInterruptedCanvasNodes } from "./canvas-page-node.ts";
import { canvasTaskRows } from "./canvas-task-list.ts";
import { restoreCanvasNodeMedia } from "./canvas-node-media-restore.ts";

for (const phase of ["failed", "running", "succeeded"] as const) {
    test(`恢复内嵌图片的归档上传保留 ${phase} 任务状态与完整执行元数据`, () => {
        const node = createImageNode({ id: `image-${phase}`, position: { x: 40, y: 60 } });
        node.content.source = "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E";
        node.execution = { phase, taskId: `task-${phase}`, progress: 42, errorMessage: "原生成错误", startedAt: "2026-09-30T00:00:00Z", completedAt: "2026-09-30T00:00:05Z" };
        const restored = restoreCanvasNodeMedia(resetInterruptedCanvasNodes([node])[0], {
            status: "success", content: "/stored.svg", storageKey: "image:stored", mimeType: "image/svg+xml", bytes: 256, naturalWidth: 512, naturalHeight: 320,
            taskId: "upload-task", progress: 100, errorDetails: "", completedAt: "upload-time",
        });
        assert.equal(restored.kind, "image");
        if (restored.kind !== "image") return;
        assert.equal(restored.content.source, "/stored.svg");
        assert.equal(restored.content.storageKey, "image:stored");
        assert.equal(restored.frame.naturalWidth, 512);
        assert.deepEqual(restored.execution, node.execution);
        assert.equal(restored.execution, node.execution);
        assert.equal(node.content.storageKey, undefined);
        const [row] = canvasTaskRows([restored]);
        assert.equal(row.phase, phase);
        assert.equal(row.taskId, `task-${phase}`);
        assert.equal(row.error, "原生成错误");
    });

    test(`视频媒体与音频引用地址恢复保留 ${phase} 任务状态`, () => {
        const node = createVideoNode({ id: `video-${phase}`, position: { x: 0, y: 0 } });
        node.content = { source: "/old.mp4", storageKey: "video:stored", durationMilliseconds: 5000 };
        node.execution = { phase, taskId: `video-task-${phase}`, progress: 65, errorMessage: "视频任务错误" };
        const media = restoreCanvasNodeMedia(node, { status: "success", content: "/resolved.mp4", storageKey: "video:stored", mimeType: "video/mp4", durationMs: 5000 });
        const restored = restoreCanvasNodeMedia(media, { audioReferences: [{ id: "audio", name: "配音", url: "/resolved.mp3", type: "audio/mpeg", storageKey: "audio:stored" }] });
        assert.equal(restored.content.source, "/resolved.mp4");
        assert.equal(restored.generation.audioReferences?.[0].url, "/resolved.mp3");
        assert.equal(restored.execution, node.execution);
        assert.equal(canvasTaskRows([restored])[0].phase, phase);
    });
}

test("九张有旧图片的失败节点归档后任务列表仍保留九条失败记录", () => {
    const nodes = Array.from({ length: 9 }, (_, index) => {
        const node = createImageNode({ id: `image-${index}`, position: { x: index * 600, y: 550 } });
        node.content.source = "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E";
        node.execution = { phase: "failed", taskId: `task-${index}`, errorMessage: "模拟失败记录" };
        return restoreCanvasNodeMedia(node, { status: "success", content: `/uploaded-${index}.svg`, storageKey: `image:${index}` });
    });
    const rows = canvasTaskRows(nodes);
    assert.equal(rows.length, 9);
    assert.ok(rows.every(row => row.phase === "failed" && row.taskId && row.error === "模拟失败记录"));
});
