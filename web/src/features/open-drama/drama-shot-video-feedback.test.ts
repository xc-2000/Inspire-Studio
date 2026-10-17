import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasNode, CanvasVideoNode } from "@/features/canvas/types";
import { readDramaShotVideoFeedback } from "./drama-shot-video-feedback";

const shot = { id: "six" };
function video(id: string, execution: CanvasVideoNode["execution"], extra: Partial<CanvasVideoNode> = {}): CanvasVideoNode {
    return { id, kind: "video", dramaStoryboardId: "board", dramaShotId: "six", content: { source: "" }, execution, ...extra } as CanvasVideoNode;
}

test("shows the precise latest failure on the linked shot only", () => {
    const nodes = [video("attempt", { phase: "failed", errorMessage: "请先完成镜头 5 并保存视频" }), video("other", { phase: "failed", errorMessage: "其他章节错误" }, { dramaStoryboardId: "other-board" })];
    assert.deepEqual(readDramaShotVideoFeedback(nodes, "board", shot), { state: "failed", label: "视频未完成", error: "请先完成镜头 5 并保存视频", nodeId: "attempt" });
    assert.equal(readDramaShotVideoFeedback(nodes, "board", { id: "seven" }).state, "idle");
});

test("a later successful attempt suppresses old failure, including without legacy timestamps", () => {
    const nodes = [video("failed", { phase: "failed", errorMessage: "旧错误" }), video("success", { phase: "succeeded" }, { content: { source: "/new.mp4" } })];
    assert.equal(readDramaShotVideoFeedback(nodes, "board", shot).error, undefined);
    assert.equal(readDramaShotVideoFeedback(nodes, "board", { ...shot, video: { source: "/new.mp4" } }).state, "ready");
});

test("timestamped task order follows attempts even when old failure finishes late", () => {
    const nodes = [video("new", { phase: "succeeded", startedAt: "2026-10-07T10:10:00Z" }), video("old", { phase: "failed", startedAt: "2026-10-07T10:00:00Z", completedAt: "2026-10-07T10:20:00Z", errorMessage: "旧错误" })];
    assert.equal(readDramaShotVideoFeedback(nodes, "board", shot).error, undefined);
});

test("ready shots ignore old failure but show the newest active regeneration", () => {
    const ready = { ...shot, video: { source: "/saved.mp4" } };
    const nodes = [video("old", { phase: "failed", errorMessage: "旧错误" })];
    assert.equal(readDramaShotVideoFeedback(nodes, "board", ready).state, "ready");
    nodes.push(video("queued", { phase: "running" }));
    assert.equal(readDramaShotVideoFeedback(nodes, "board", ready).state, "queued");
    nodes.push(video("active", { phase: "running", progress: 35, taskId: "task" }));
    assert.equal(readDramaShotVideoFeedback(nodes, "board", ready).label, "视频生成中 35%");
});

test("newer success overrides stale running; empty idle nodes do not mask failures", () => {
    assert.equal(readDramaShotVideoFeedback([video("old", { phase: "running" }), video("new", { phase: "succeeded" })], "board", shot).state, "idle");
    assert.equal(readDramaShotVideoFeedback([video("failure", { phase: "failed" }), video("empty", { phase: "idle" })], "board", shot).state, "failed");
    assert.equal(readDramaShotVideoFeedback([{ ...video("image", { phase: "failed" }), kind: "image" } as unknown as CanvasNode], "board", shot).state, "idle");
});
