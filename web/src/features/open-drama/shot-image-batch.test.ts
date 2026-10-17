import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { CanvasStoryboardShotImageGenerationState } from "@/features/canvas/types";
import { appendShotImageBatch, createShotImageBatch, createShotImageConcurrencyLimiter, interruptShotImageBatch, runShotImageBatch, shotImageBatchSummary } from "./shot-image-batch";

type Task = { id: string; status: string; progress?: number; url?: string; errorMessage?: string };
const image = (task: Task) => ({ source: task.url || "/result.webp" });

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitUntil(condition: () => boolean, message: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (condition()) return;
        await setImmediate();
    }
    assert.fail(message);
}

test("逐镜头保存任务号后再轮询，失败镜头不覆盖已成功结果", async () => {
    const events: string[] = [];
    const results: string[] = [];
    const state = await runShotImageBatch<Task>({
        state: createShotImageBatch("batch", ["one", "two"]), signal: new AbortController().signal,
        createTask: async id => { events.push(`create:${id}`); return { id, status: "pending" }; },
        getTask: async () => assert.fail("新批次不查询旧任务"),
        waitTask: async (id, progress) => { events.push(`poll:${id}`); progress({ id, status: "running", progress: 40 }); if (id === "two") throw new Error("模型失败"); return { id, status: "success" }; },
        readImage: image,
        commit: async (next, result, durable) => { if (durable && next.tasks.one.taskId) events.push("saved:one"); if (result) results.push(result.shotId); },
    });
    assert.ok(events.indexOf("saved:one") < events.indexOf("poll:one"));
    assert.deepEqual(results, ["one"]);
    assert.equal(state.tasks.two.error, "模型失败");
    assert.equal(state.phase, "failed");
    assert.deepEqual(shotImageBatchSummary(state).failedIds, ["two"]);
});

test("刷新恢复只续接已有任务，完成项跳过，未提交项明确失败且不付费提交", async () => {
    const queried: string[] = [];
    const results: string[] = [];
    const saved: CanvasStoryboardShotImageGenerationState = {
        batchId: "batch", phase: "running", selectedShotIds: ["finished", "active", "queued"],
        tasks: { finished: { taskId: "t0", status: "succeeded", progress: 100 }, active: { taskId: "t1", status: "running", progress: 30 }, queued: { status: "pending", progress: 0 } },
    };
    const state = await runShotImageBatch<Task>({
        state: JSON.parse(JSON.stringify(saved)), signal: new AbortController().signal,
        getTask: async id => { queried.push(id); return { id, status: "running" }; },
        waitTask: async id => ({ id, status: "success" }), readImage: image,
        commit: async (_state, result) => { if (result) results.push(result.shotId); },
    });
    assert.deepEqual(queried, ["t1"]);
    assert.deepEqual(results, ["active"]);
    assert.match(state.tasks.queued.error!, /尚未提交/);
    assert.equal(state.tasks.finished.status, "succeeded");
});

test("只重试失败项时先对账已完成的原任务，避免网络错误导致重复生图", async () => {
    const previous: CanvasStoryboardShotImageGenerationState = { batchId: "old", phase: "failed", selectedShotIds: ["ok", "failed"], tasks: {
        ok: { status: "succeeded", progress: 100, taskId: "ok-task" }, failed: { status: "failed", progress: 100, taskId: "accepted-task", error: "连接中断" },
    } };
    const selected = shotImageBatchSummary(previous).failedIds;
    const queried: string[] = [];
    const state = await runShotImageBatch<Task>({
        state: createShotImageBatch("retry", selected, previous), signal: new AbortController().signal,
        createTask: async () => assert.fail("原任务已成功，不应再提交"),
        getTask: async id => { queried.push(id); return { id, status: "success" }; },
        waitTask: async () => assert.fail("完成任务不再轮询"), readImage: image, commit: async () => {},
    });
    assert.deepEqual(queried, ["accepted-task"]);
    assert.deepEqual(state.selectedShotIds, ["failed"]);
    assert.equal(state.phase, "succeeded");
});

test("刷新发生在提交返回时仍保存任务号，停止轮询供下次恢复", async () => {
    const controller = new AbortController();
    let persisted: CanvasStoryboardShotImageGenerationState | undefined;
    await runShotImageBatch<Task>({
        state: createShotImageBatch("batch", ["shot"]), signal: controller.signal,
        createTask: async () => { controller.abort(); return { id: "accepted-task", status: "pending" }; },
        getTask: async () => assert.fail("不查询"), waitTask: async () => assert.fail("卸载后不轮询"), readImage: image,
        commit: async state => { persisted = state; },
    });
    assert.equal(persisted?.tasks.shot.taskId, "accepted-task");
    assert.equal(persisted?.phase, "running");
});

test("首个镜头轮询期间取消后停止提交后续镜头，并保留已保存任务号供恢复", async () => {
    const controller = new AbortController();
    const submitted: string[] = [];
    let persisted: CanvasStoryboardShotImageGenerationState | undefined;
    const state = await runShotImageBatch<Task>({
        state: createShotImageBatch("batch", ["one", "two"]), signal: controller.signal, concurrency: 1,
        createTask: async id => { submitted.push(id); return { id: `accepted-${id}`, status: "pending" }; },
        getTask: async () => assert.fail("新批次不查询旧任务"),
        waitTask: async id => {
            assert.equal(id, "accepted-one");
            assert.equal(persisted?.tasks.one.taskId, id, "轮询前已保存被接受的任务号");
            controller.abort();
            throw new DOMException("Aborted", "AbortError");
        },
        readImage: () => assert.fail("取消后不读取生成结果"),
        commit: async next => { persisted = next; },
    });
    assert.deepEqual(submitted, ["one"]);
    assert.equal(state.phase, "running");
    assert.equal(state.tasks.one.taskId, "accepted-one");
    assert.equal(state.tasks.one.status, "running");
    assert.equal(persisted?.tasks.one.taskId, "accepted-one");
    assert.equal(state.tasks.two.status, "pending");
    assert.equal(state.tasks.two.taskId, undefined);
});

test("保存或连接失败中断批次后保留已接受的任务号与成功项以便安全重试", () => {
    const saved: CanvasStoryboardShotImageGenerationState = { batchId: "batch", phase: "running", selectedShotIds: ["ok", "active", "queued"], tasks: {
        ok: { status: "succeeded", progress: 100 }, active: { taskId: "accepted", status: "running", progress: 30 }, queued: { status: "pending", progress: 0 },
    } };
    const failed = interruptShotImageBatch(saved, "保存连接中断");
    assert.equal(failed.phase, "failed");
    assert.equal(failed.tasks.ok.status, "succeeded");
    assert.equal(failed.tasks.active.taskId, "accepted");
    assert.deepEqual(shotImageBatchSummary(failed).failedIds, ["active", "queued"]);
    assert.equal(saved.tasks.active.status, "running");
});

test("追加镜头去重并保留运行项，成功项显式重生，失败项保留旧任务号供对账", () => {
    const saved: CanvasStoryboardShotImageGenerationState = {
        batchId: "batch", phase: "failed", selectedShotIds: ["ok", "active", "queued", "failed"],
        tasks: {
            ok: { taskId: "ok-task", status: "succeeded", progress: 100 },
            active: { taskId: "active-task", status: "running", progress: 35 },
            queued: { status: "pending", progress: 0 },
            failed: { taskId: "accepted-task", status: "failed", progress: 100, error: "连接中断" },
        },
    };
    const state = appendShotImageBatch(saved, ["active", "queued", "ok", "failed", "new", "new"]);
    assert.equal(state.batchId, "batch");
    assert.equal(state.phase, "running");
    assert.deepEqual(state.selectedShotIds, ["ok", "active", "queued", "failed", "new"]);
    assert.equal(state.tasks.ok.status, "pending");
    assert.equal(state.tasks.ok.progress, 0);
    assert.equal(state.tasks.ok.taskId, undefined, "成功项显式重生应提交新任务");
    assert.ok((state.tasks.ok.requestVersion || 0) > (saved.tasks.ok.requestVersion || 0));
    assert.deepEqual(state.tasks.active, saved.tasks.active);
    assert.deepEqual(state.tasks.queued, saved.tasks.queued);
    assert.equal(state.tasks.failed.taskId, "accepted-task");
    assert.equal(state.tasks.failed.status, "pending");
    assert.equal(state.tasks.failed.progress, 0);
    assert.equal(state.tasks.failed.error, undefined);
    assert.equal(state.tasks.new.status, "pending");
    assert.equal(state.tasks.new.progress, 0);
    assert.equal(saved.tasks.failed.status, "failed", "追加不修改传入快照");
});

for (const { concurrency, expected, label } of [
    { concurrency: undefined, expected: 3, label: "默认同时运行三个镜头" },
    { concurrency: 100, expected: 6, label: "单批次并发最多六个镜头" },
]) {
    test(`${label}，轮询未完成前不会启动额外镜头`, async () => {
        const ids = Array.from({ length: 8 }, (_, index) => `shot-${index}`);
        const gates = new Map(ids.map(id => [id, deferred<Task>()]));
        const started: string[] = [];
        let active = 0;
        let peak = 0;
        const running = runShotImageBatch<Task>({
            state: createShotImageBatch("batch", ids), signal: new AbortController().signal,
            concurrency,
            createTask: async id => ({ id, status: "pending" }),
            getTask: async () => assert.fail("新批次不查询旧任务"),
            waitTask: async id => {
                started.push(id);
                active += 1;
                peak = Math.max(peak, active);
                try { return await gates.get(id)!.promise; } finally { active -= 1; }
            },
            readImage: image, commit: async () => {},
        });
        try {
            await waitUntil(() => started.length >= expected, "没有在首个镜头完成前启动要求的并发数");
            await setImmediate();
            assert.equal(started.length, expected);
            gates.get(started[0])!.resolve({ id: started[0], status: "success" });
            await waitUntil(() => started.length === expected + 1, "完成一个镜头后没有填补空闲槽位");
            assert.equal(peak, expected);
        } finally {
            for (const id of ids) gates.get(id)!.resolve({ id, status: "success" });
        }
        const state = await running;
        assert.equal(state.phase, "succeeded");
        assert.equal(shotImageBatchSummary(state).succeeded, ids.length);
        assert.equal(peak, expected);
    });
}

test("共享限流器限制跨批次完整镜头执行，结果保存完成后才释放槽位", async () => {
    const limiter = createShotImageConcurrencyLimiter(2);
    const ids = ["a1", "a2", "b1", "b2"];
    const gates = new Map(ids.map(id => [id, deferred<Task>()]));
    const saveGate = deferred<void>();
    const saving = deferred<void>();
    const started: string[] = [];
    let heldShot: string | undefined;
    const runBatch = (batchId: string, selected: string[]) => runShotImageBatch<Task>({
        state: createShotImageBatch(batchId, selected), signal: new AbortController().signal,
        concurrency: 3, runTask: limiter.runTask,
        createTask: async id => ({ id, status: "pending" }),
        getTask: async () => assert.fail("新批次不查询旧任务"),
        waitTask: async id => { started.push(id); return gates.get(id)!.promise; },
        readImage: image,
        commit: async (_state, result) => {
            if (result && result.shotId === heldShot) { saving.resolve(undefined); await saveGate.promise; }
        },
    });
    const batches = [runBatch("a", ["a1", "a2"]), runBatch("b", ["b1", "b2"])];
    try {
        await waitUntil(() => started.length === 2, "跨批次没有共享两个执行槽位");
        await setImmediate();
        assert.equal(limiter.activeCount, 2);
        assert.equal(limiter.queuedCount, 2);
        heldShot = started[0];
        gates.get(heldShot)!.resolve({ id: heldShot, status: "success" });
        await saving.promise;
        await setImmediate();
        assert.equal(started.length, 2, "轮询完成但结果未保存时仍占用全局槽位");
        assert.equal(limiter.activeCount, 2);
        saveGate.resolve(undefined);
        await waitUntil(() => started.length === 3, "保存结果后没有启动另一个批次的排队镜头");
    } finally {
        saveGate.resolve(undefined);
        for (const id of ids) gates.get(id)!.resolve({ id, status: "success" });
    }
    const states = await Promise.all(batches);
    assert.ok(states.every(state => state.phase === "succeeded"));
    assert.equal(limiter.activeCount, 0);
    assert.equal(limiter.queuedCount, 0);
});

test("共享限流器降额等待在途镜头结束，升额立即调度排队镜头", async () => {
    const limiter = createShotImageConcurrencyLimiter(2);
    const ids = ["one", "two", "three", "four"];
    const gates = new Map(ids.map(id => [id, deferred<string>()]));
    const started: string[] = [];
    const works = ids.map(id => limiter.runTask(async () => {
        started.push(id);
        return gates.get(id)!.promise;
    }, new AbortController().signal));
    try {
        await waitUntil(() => started.length === 2, "初始限流没有启动两个任务");
        limiter.setLimit(1);
        gates.get("one")!.resolve("one");
        await works[0];
        await setImmediate();
        assert.deepEqual(started, ["one", "two"]);
        assert.equal(limiter.activeCount, 1);
        assert.equal(limiter.queuedCount, 2);
        gates.get("two")!.resolve("two");
        await works[1];
        await waitUntil(() => started.length === 3, "降额后没有以一个槽位继续工作");
        assert.equal(limiter.activeCount, 1);
        limiter.setLimit(3);
        await waitUntil(() => started.length === 4, "升额没有立即启动排队任务");
        assert.equal(limiter.activeCount, 2);
    } finally {
        for (const id of ids) gates.get(id)!.resolve(id);
    }
    assert.deepEqual(await Promise.all(works), ids);
    assert.equal(limiter.activeCount, 0);
    assert.equal(limiter.queuedCount, 0);
});

test("运行中追加重叠镜头动态纳入批次，已有进度和成功结果不会被覆盖", async () => {
    let latest = createShotImageBatch("batch", ["one", "two"]);
    const ids = ["one", "two", "three", "four"];
    const gates = new Map(ids.map(id => [id, deferred<Task>()]));
    const started: string[] = [];
    const results: string[] = [];
    let changeListener: (() => void) | undefined;
    const running = runShotImageBatch<Task>({
        state: latest, readState: () => latest, concurrency: 2, signal: new AbortController().signal,
        subscribeToChanges: listener => { changeListener = listener; return () => { changeListener = undefined; }; },
        createTask: async id => { started.push(id); return { id, status: "pending" }; },
        getTask: async () => assert.fail("运行中重叠追加不应对账或重复提交旧镜头"),
        waitTask: async id => gates.get(id)!.promise, readImage: image,
        commit: async (next, result) => { latest = next; if (result) results.push(result.shotId); },
    });
    try {
        await waitUntil(() => started.length === 2, "初始两个镜头没有并发启动");
        latest = appendShotImageBatch(latest, ["one", "two", "three", "three"]);
        changeListener?.();
        gates.get("one")!.resolve({ id: "one", status: "success" });
        await waitUntil(() => started.includes("three"), "运行批次没有读取追加的镜头");
        assert.equal(latest.tasks.one.status, "succeeded");
        assert.equal(latest.tasks.two.taskId, "two");
        latest = appendShotImageBatch(latest, ["three", "four"]);
        changeListener?.();
        gates.get("two")!.resolve({ id: "two", status: "success" });
        await waitUntil(() => started.includes("four"), "第二次追加没有被纳入运行批次");
        assert.equal(latest.tasks.one.status, "succeeded");
        assert.equal(latest.tasks.two.status, "succeeded");
    } finally {
        for (const id of ids) gates.get(id)!.resolve({ id, status: "success" });
    }
    const state = await running;
    assert.deepEqual(started, ids);
    assert.deepEqual(state.selectedShotIds, ids);
    assert.deepEqual([...results].sort(), [...ids].sort());
    assert.equal(state.phase, "succeeded");
    assert.equal(shotImageBatchSummary(latest).succeeded, 4);
});

test("运行中追加镜头有空闲槽位时立即启动，完成后清理状态订阅", async () => {
    let latest = createShotImageBatch("batch", ["one"]);
    const gates = new Map(["one", "two"].map(id => [id, deferred<Task>()]));
    const submitted: string[] = [];
    let changeListener: (() => void) | undefined;
    let unsubscribed = 0;
    const running = runShotImageBatch<Task>({
        state: latest, readState: () => latest, concurrency: 3, signal: new AbortController().signal,
        subscribeToChanges: listener => {
            changeListener = listener;
            return () => { changeListener = undefined; unsubscribed += 1; };
        },
        createTask: async id => { submitted.push(id); return { id, status: "pending" }; },
        getTask: async () => assert.fail("新批次不查询旧任务"),
        waitTask: async id => gates.get(id)!.promise, readImage: image,
        commit: async next => { latest = next; },
    });
    try {
        await waitUntil(() => latest.tasks.one.taskId === "one", "首个镜头没有保存任务号");
        latest = appendShotImageBatch(latest, ["one", "two", "two"]);
        assert.ok(changeListener, "动态批次应订阅状态变化");
        changeListener!();
        await waitUntil(() => submitted.includes("two"), "已有镜头仍在轮询时没有立即调度追加镜头");
        assert.equal(latest.tasks.one.status, "running", "追加镜头启动时原镜头尚未完成");
        assert.deepEqual(submitted, ["one", "two"]);
    } finally {
        for (const id of ["one", "two"]) gates.get(id)!.resolve({ id, status: "success" });
    }
    const state = await running;
    assert.equal(state.phase, "succeeded");
    assert.equal(unsubscribed, 1);
    assert.equal(changeListener, undefined);
});

test("追加失败镜头重试先对账原任务，原任务成功时不产生重复提交", async () => {
    const saved: CanvasStoryboardShotImageGenerationState = {
        batchId: "batch", phase: "failed", selectedShotIds: ["ok", "failed"],
        tasks: {
            ok: { taskId: "ok-task", status: "succeeded", progress: 100 },
            failed: { taskId: "accepted-task", status: "failed", progress: 100, error: "连接中断" },
        },
    };
    const queried: string[] = [];
    const results: string[] = [];
    const state = await runShotImageBatch<Task>({
        state: appendShotImageBatch(saved, ["failed", "failed"]), signal: new AbortController().signal,
        createTask: async () => assert.fail("原任务已成功，不应再次提交"),
        getTask: async id => { queried.push(id); return { id, status: "success" }; },
        waitTask: async () => assert.fail("完成任务不再轮询"), readImage: image,
        commit: async (_next, result) => { if (result) results.push(result.shotId); },
    });
    assert.deepEqual(queried, ["accepted-task"]);
    assert.deepEqual(results, ["failed"]);
    assert.equal(state.tasks.ok.status, "succeeded");
    assert.equal(state.phase, "succeeded");
});

test("刷新恢复保留历史失败原因，只续接已接受任务且未授权项只失败一次", async () => {
    const saved: CanvasStoryboardShotImageGenerationState = {
        batchId: "batch", phase: "running", selectedShotIds: ["failed", "active", "queued"],
        tasks: {
            failed: { taskId: "failed-task", status: "failed", progress: 100, error: "保留历史失败原因" },
            active: { taskId: "accepted-task", status: "running", progress: 30 },
            queued: { status: "pending", progress: 0 },
        },
    };
    const queried: string[] = [];
    const submissions: string[] = [];
    const polled: string[] = [];
    const state = await runShotImageBatch<Task>({
        state: saved, signal: new AbortController().signal,
        createTask: async id => { submissions.push(id); throw new Error("恢复不能提交未授权的新镜头"); },
        getTask: async id => { queried.push(id); return { id, status: "running" }; },
        waitTask: async id => { polled.push(id); return { id, status: "success" }; },
        readImage: image, commit: async () => {},
    });
    assert.deepEqual(queried, ["accepted-task"]);
    assert.deepEqual(polled, ["accepted-task"]);
    assert.deepEqual(submissions, ["queued"]);
    assert.deepEqual(state.tasks.failed, saved.tasks.failed);
    assert.equal(state.tasks.active.status, "succeeded");
    assert.equal(state.tasks.active.taskId, "accepted-task");
    assert.equal(state.tasks.queued.status, "failed");
    assert.equal(state.tasks.queued.error, "恢复不能提交未授权的新镜头");
    assert.equal(state.phase, "failed");
});

test("取消时移除共享限流器中的排队镜头，不提交后续任务", async () => {
    const limiter = createShotImageConcurrencyLimiter(1);
    const controller = new AbortController();
    const polling = deferred<Task>();
    const submitted: string[] = [];
    let pollingStarted = false;
    const running = runShotImageBatch<Task>({
        state: createShotImageBatch("batch", ["one", "two", "three"]),
        signal: controller.signal, concurrency: 3, runTask: limiter.runTask,
        createTask: async id => { submitted.push(id); return { id: `accepted-${id}`, status: "pending" }; },
        getTask: async () => assert.fail("新批次不查询旧任务"),
        waitTask: async () => { pollingStarted = true; return polling.promise; },
        readImage: () => assert.fail("取消后不读取图片"), commit: async () => {},
    });
    try {
        await waitUntil(() => limiter.queuedCount === 2 && pollingStarted, "首个镜头未开始轮询或后续镜头没有排队");
        controller.abort();
        polling.reject(new DOMException("Aborted", "AbortError"));
        const state = await running;
        assert.deepEqual(submitted, ["one"]);
        assert.equal(state.phase, "running");
        assert.equal(state.tasks.one.taskId, "accepted-one");
        assert.equal(state.tasks.two.status, "pending");
        assert.equal(state.tasks.three.status, "pending");
        assert.equal(limiter.activeCount, 0);
        assert.equal(limiter.queuedCount, 0);
    } finally {
        controller.abort();
        polling.resolve({ id: "accepted-one", status: "success" });
    }
});

test("并发镜头失败只影响自身，其他镜头继续保存成功结果并补充空闲槽位", async () => {
    const gates = new Map(["failed", "ok", "next"].map(id => [id, deferred<Task>()]));
    const started: string[] = [];
    const results: string[] = [];
    const running = runShotImageBatch<Task>({
        state: createShotImageBatch("batch", ["failed", "ok", "next"]),
        signal: new AbortController().signal, concurrency: 2,
        createTask: async id => ({ id, status: "pending" }),
        getTask: async () => assert.fail("新批次不查询旧任务"),
        waitTask: async id => { started.push(id); return gates.get(id)!.promise; }, readImage: image,
        commit: async (_next, result) => { if (result) results.push(result.shotId); },
    });
    try {
        await waitUntil(() => started.length === 2, "两个镜头没有并发轮询");
        gates.get("failed")!.reject(new Error("该镜头生成失败"));
        await waitUntil(() => started.includes("next"), "失败镜头未释放槽位供剩余镜头继续执行");
    } finally {
        gates.get("failed")!.resolve({ id: "failed", status: "success" });
        gates.get("ok")!.resolve({ id: "ok", status: "success" });
        gates.get("next")!.resolve({ id: "next", status: "success" });
    }
    const state = await running;
    assert.deepEqual([...results].sort(), ["next", "ok"]);
    assert.equal(state.tasks.failed.taskId, "failed");
    assert.equal(state.tasks.failed.error, "该镜头生成失败");
    assert.equal(state.tasks.ok.status, "succeeded");
    assert.equal(state.tasks.next.status, "succeeded");
    assert.deepEqual(shotImageBatchSummary(state).failedIds, ["failed"]);
    assert.equal(state.phase, "failed");
});

test("终态保存后的迟到进度回调不覆盖成功状态和完成进度", async () => {
    let progress: ((task: Task) => void) | undefined;
    const commits: CanvasStoryboardShotImageGenerationState[] = [];
    let latest = createShotImageBatch("batch", ["shot"]);
    const state = await runShotImageBatch<Task>({
        state: latest, readState: () => latest, signal: new AbortController().signal,
        createTask: async () => ({ id: "task", status: "pending" }),
        getTask: async () => assert.fail("新批次不查询旧任务"),
        waitTask: async (_id, onProgress) => { progress = onProgress; onProgress({ id: "task", status: "running", progress: 40 }); return { id: "task", status: "success" }; },
        readImage: image, commit: async next => { latest = next; commits.push(next); },
    });
    const terminal = commits.findIndex(next => next.tasks.shot.status === "succeeded");
    assert.ok(terminal >= 0);
    progress!({ id: "task", status: "running", progress: 5 });
    await setImmediate();
    assert.equal(state.tasks.shot.status, "succeeded");
    assert.equal(latest.tasks.shot.status, "succeeded");
    assert.equal(latest.tasks.shot.progress, 100);
    assert.ok(commits.slice(terminal).every(next => next.tasks.shot.status === "succeeded" && next.tasks.shot.progress === 100));
});

test("成功镜头保存期间显式重生同镜头，旧进度不能覆盖新版本且继续执行新请求", async () => {
    let latest = createShotImageBatch("batch", ["shot"]);
    const firstSave = deferred<void>();
    const saveGate = deferred<void>();
    const secondPolling = deferred<Task>();
    const callbacks = new Map<string, (task: Task) => void>();
    const submitted: string[] = [];
    const results: string[] = [];
    const running = runShotImageBatch<Task>({
        state: latest, readState: () => latest, signal: new AbortController().signal, concurrency: 1,
        createTask: async () => {
            const id = `task-${submitted.length + 1}`;
            submitted.push(id);
            return { id, status: "pending" };
        },
        getTask: async () => assert.fail("成功镜头重生不能续接原成功任务"),
        waitTask: async (id, progress) => {
            callbacks.set(id, progress);
            if (id === "task-1") return { id, status: "success" };
            progress({ id, status: "running", progress: 60 });
            return secondPolling.promise;
        },
        readImage: image,
        commit: async (next, result) => {
            latest = next;
            if (result) {
                results.push(result.shotId);
                if (results.length === 1) { firstSave.resolve(undefined); await saveGate.promise; }
            }
        },
    });
    try {
        await firstSave.promise;
        const oldVersion = latest.tasks.shot.requestVersion || 0;
        latest = appendShotImageBatch(latest, ["shot", "shot"]);
        const newVersion = latest.tasks.shot.requestVersion || 0;
        assert.ok(newVersion > oldVersion);
        assert.equal(latest.tasks.shot.status, "pending");
        assert.equal(latest.tasks.shot.taskId, undefined);
        callbacks.get("task-1")!({ id: "task-1", status: "running", progress: 5 });
        await setImmediate();
        assert.equal(latest.tasks.shot.status, "pending");
        assert.equal(latest.tasks.shot.progress, 0);
        assert.equal(latest.tasks.shot.requestVersion, newVersion);
        saveGate.resolve(undefined);
        await waitUntil(() => callbacks.has("task-2"), "旧任务保存完成后没有执行新版本请求");
        await waitUntil(() => latest.tasks.shot.progress === 60, "新任务进度没有被保存");
        callbacks.get("task-1")!({ id: "task-1", status: "running", progress: 1 });
        await setImmediate();
        assert.equal(latest.tasks.shot.taskId, "task-2");
        assert.equal(latest.tasks.shot.progress, 60);
        assert.equal(latest.tasks.shot.requestVersion, newVersion);
    } finally {
        saveGate.resolve(undefined);
        secondPolling.resolve({ id: "task-2", status: "success" });
    }
    const state = await running;
    assert.deepEqual(submitted, ["task-1", "task-2"]);
    assert.equal(results.length, 2);
    assert.equal(state.tasks.shot.taskId, "task-2");
    assert.equal(state.tasks.shot.status, "succeeded");
    assert.equal(state.phase, "succeeded");
});

test("最终状态保存等待期间追加镜头，返回前重新调度追加请求", async () => {
    let latest = createShotImageBatch("batch", ["one"]);
    const savingFinal = deferred<void>();
    const finalSaveGate = deferred<void>();
    const submitted: string[] = [];
    let finalSaveHeld = false;
    const running = runShotImageBatch<Task>({
        state: latest, readState: () => latest, signal: new AbortController().signal,
        createTask: async id => { submitted.push(id); return { id, status: "success" }; },
        getTask: async () => assert.fail("新镜头不查询旧任务"),
        waitTask: async () => assert.fail("成功任务不轮询"), readImage: image,
        commit: async (next, result) => {
            latest = next;
            if (next.phase === "succeeded" && !result && !finalSaveHeld) {
                finalSaveHeld = true;
                savingFinal.resolve(undefined);
                await finalSaveGate.promise;
            }
        },
    });
    try {
        await savingFinal.promise;
        latest = appendShotImageBatch(latest, ["two", "two"]);
        finalSaveGate.resolve(undefined);
        const state = await running;
        assert.deepEqual(submitted, ["one", "two"]);
        assert.deepEqual(state.selectedShotIds, ["one", "two"]);
        assert.equal(state.tasks.one.status, "succeeded");
        assert.equal(state.tasks.two.status, "succeeded");
        assert.equal(state.phase, "succeeded");
    } finally {
        finalSaveGate.resolve(undefined);
    }
});

for (const missing of ["undefined", "foreign"] as const) {
    test(`运行批次最新状态为 ${missing} 时停止提交和保存旧批次`, async () => {
        let latest: CanvasStoryboardShotImageGenerationState | undefined = createShotImageBatch("batch", ["one", "two"]);
        const polling = deferred<Task>();
        const submitted: string[] = [];
        const committed: CanvasStoryboardShotImageGenerationState[] = [];
        const running = runShotImageBatch<Task>({
            state: latest, readState: () => latest, signal: new AbortController().signal, concurrency: 1,
            createTask: async id => { submitted.push(id); return { id, status: "pending" }; },
            getTask: async () => assert.fail("新批次不查询旧任务"),
            waitTask: async () => polling.promise, readImage: image,
            commit: async next => { latest = next; committed.push(next); },
        });
        try {
            await waitUntil(() => committed.some(next => next.tasks.one.taskId === "one"), "在途镜头任务号未保存");
            latest = missing === "undefined" ? undefined : createShotImageBatch("another-batch", ["foreign-shot"]);
            const savedCount = committed.length;
            polling.resolve({ id: "one", status: "success" });
            await running;
            assert.deepEqual(submitted, ["one"]);
            assert.equal(committed.length, savedCount, "旧批次不应覆盖已经移除或替换的最新状态");
            assert.equal(latest?.batchId, missing === "undefined" ? undefined : "another-batch");
        } finally {
            polling.resolve({ id: "one", status: "success" });
        }
    });
}
