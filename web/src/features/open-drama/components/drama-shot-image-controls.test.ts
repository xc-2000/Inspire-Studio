import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasStoryboardShot, CanvasStoryboardShotImageTask } from "@/features/canvas/types";
import { dramaShotImageTaskLabel, failedDramaShotImageIds, isDramaShotImageActive, missingDramaShotImageIds } from "./drama-shot-image-controls";

const shot = (id: string, source?: string) => ({ id, ...(source ? { image: { source } } : {}) }) as CanvasStoryboardShot;
const task = (status: CanvasStoryboardShotImageTask["status"], progress = 0): CanvasStoryboardShotImageTask => ({ status, progress });

test("pending and running block only their target shots", () => {
    assert.equal(isDramaShotImageActive(task("pending")), true);
    assert.equal(isDramaShotImageActive(task("running", 45)), true);
    assert.equal(isDramaShotImageActive(task("failed")), false);
    assert.equal(isDramaShotImageActive(task("succeeded")), false);
    assert.equal(isDramaShotImageActive(undefined), false);
});

test("fill missing images excludes active shots while accepting new and failed shots", () => {
    const shots = [shot("queued"), shot("running"), shot("failed"), shot("new"), shot("ready", "/ready.png")];
    const tasks = { queued: task("pending"), running: task("running"), failed: task("failed") };
    assert.deepEqual(missingDramaShotImageIds(shots, tasks), ["failed", "new"]);
    assert.equal(shots.length, 5);
    assert.equal(tasks.running.status, "running");
});

test("retry selects current failed shots even while other shots are running", () => {
    const shots = [shot("working"), shot("failed-old", "/old.png"), shot("queued"), shot("failed-new"), shot("done")];
    const tasks = { working: task("running"), "failed-old": task("failed"), queued: task("pending"), "failed-new": task("failed"), done: task("succeeded"), removed: task("failed") };
    assert.deepEqual(failedDramaShotImageIds(shots, tasks), ["failed-old", "failed-new"]);
});

test("queue and running progress have explicit labels", () => {
    assert.match(dramaShotImageTaskLabel(task("pending")), /排队.*准备参考素材/);
    assert.equal(dramaShotImageTaskLabel(task("running", 38)), "图片处理中 · 38%");
    assert.equal(dramaShotImageTaskLabel(task("running", 140)), "图片处理中 · 100%");
    assert.equal(dramaShotImageTaskLabel(task("failed")), "");
});
