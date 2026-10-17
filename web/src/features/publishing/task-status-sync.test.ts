import assert from "node:assert/strict";
import test from "node:test";
import type { PublishTask, PublishTaskUpdate } from "@/services/api/server";
import { mergePublishTaskStatuses, watchPublishTaskStatuses } from "./task-status-sync";

const task = (id: string, status: PublishTask["status"]): PublishTask => ({ id, status, platform: "toutiao", mediaType: "video", title: "测试", description: "", mediaUrls: [], topics: [], publishMode: "publish", createdAt: "2026-10-12" });

test("unchanged polls retain references; updates affect only the active row without sorting or regressing terminal results", () => {
    const tasks = [task("done", "success"), task("active", "running"), task("failed", "failed")];
    assert.equal(mergePublishTaskStatuses(tasks, [{ id: "active", status: "running" }]), tasks);
    const next = mergePublishTaskStatuses(tasks, [{ id: "active", status: "success", resultData: { message: "已发布" } }, { id: "done", status: "running" }, { id: "new", status: "queued" }]);
    assert.deepEqual(next.map((row) => row.id), ["done", "active", "failed"]);
    assert.equal(next[0], tasks[0]);
    assert.equal(next[2], tasks[2]);
    assert.equal(next[1].status, "success");
});

test("slow status requests never overlap and completion stops further polling", async () => {
    let rows = [task("1", "queued"), task("2", "success")];
    let scheduled: (() => void) | undefined;
    let resolve!: (value: PublishTaskUpdate[]) => void;
    let calls = 0;
    const watcher = watchPublishTaskStatuses({ getTasks: () => rows, isVisible: () => true,
        fetch: async (ids) => { calls++; assert.deepEqual(ids, ["1"]); return new Promise((done) => { resolve = done; }); },
        onUpdate: (updates) => { rows = mergePublishTaskStatuses(rows, updates); }, onError: () => {},
        schedule: (callback) => { scheduled = callback; return 1 as unknown as ReturnType<typeof setTimeout>; }, cancel: () => { scheduled = undefined; },
    });
    scheduled!(); watcher.wake(); watcher.wake();
    assert.equal(calls, 1);
    resolve([{ id: "1", status: "success" }]);
    await new Promise((done) => setImmediate(done));
    assert.equal(rows[0].status, "success");
    assert.equal(scheduled, undefined);
    watcher.wake(); assert.equal(calls, 1);
    watcher.dispose();
});

test("hidden pages pause, failures back off quietly, and navigation discards late responses", async () => {
    let visible = false, calls = 0, updates = 0;
    let scheduled: (() => void) | undefined;
    let delay = 0;
    let resolve!: (value: PublishTaskUpdate[]) => void;
    const errors: boolean[] = [];
    const watcher = watchPublishTaskStatuses({ getTasks: () => [task("1", "running")], isVisible: () => visible,
        fetch: async () => { calls++; if (calls === 1) throw new Error("offline"); return new Promise((done) => { resolve = done; }); },
        onUpdate: () => { updates++; }, onError: (error) => errors.push(error),
        schedule: (callback, ms) => { scheduled = callback; delay = ms; return 1 as unknown as ReturnType<typeof setTimeout>; }, cancel: () => { scheduled = undefined; },
    });
    watcher.wake(); assert.equal(calls, 0); assert.equal(scheduled, undefined);
    visible = true; watcher.wake();
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(errors, [true]); assert.equal(delay, 16_000);
    scheduled!(); watcher.dispose(); resolve([{ id: "1", status: "success" }]);
    await new Promise((done) => setImmediate(done));
    assert.equal(updates, 0); assert.equal(scheduled, undefined);
});
