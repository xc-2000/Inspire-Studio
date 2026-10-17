import type { CanvasStoryboardAssetImage, CanvasStoryboardShotImageGenerationState, CanvasStoryboardShotImageTask } from "@/features/canvas/types";

type ImageTask = { id: string; status: string; progress?: number; errorMessage?: string };
type ShotImageBatchState = CanvasStoryboardShotImageGenerationState;
export type ShotImageTaskRunner = <T>(work: () => Promise<T>, signal: AbortSignal) => Promise<T>;

function normalizeConcurrency(value = 3) {
    return Number.isFinite(value) ? Math.max(1, Math.min(6, Math.floor(value))) : 3;
}

/** Share one instance across boards to limit complete shot jobs throughout a project. */
export function createShotImageConcurrencyLimiter(concurrency = 3) {
    let limit = normalizeConcurrency(concurrency);
    let active = 0;
    type QueuedJob = { signal: AbortSignal; start: () => void; cancel: () => void };
    const queue: QueuedJob[] = [];
    const drain = () => {
        while (active < limit && queue.length) {
            const job = queue.shift()!;
            if (job.signal.aborted) job.cancel();
            else job.start();
        }
    };
    const runTask: ShotImageTaskRunner = <T>(work: () => Promise<T>, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const onAbort = () => {
            const index = queue.indexOf(job);
            if (index < 0) return;
            queue.splice(index, 1);
            job.cancel();
            drain();
        };
        const job: QueuedJob = {
            signal,
            cancel: () => {
                signal.removeEventListener("abort", onAbort);
                reject(new DOMException("Aborted", "AbortError"));
            },
            start: () => {
                signal.removeEventListener("abort", onAbort);
                active += 1;
                // Active work handles its signal so an accepted task can still save its ID.
                void Promise.resolve().then(work).then(resolve, reject).finally(() => { active -= 1; drain(); });
            },
        };
        signal.addEventListener("abort", onAbort, { once: true });
        queue.push(job);
        drain();
    });
    return {
        runTask,
        setLimit(value: number) { limit = normalizeConcurrency(value); drain(); },
        get activeCount() { return active; },
        get queuedCount() { return queue.length; },
    };
}

export function createShotImageBatch(batchId: string, shotIds: string[], previous?: CanvasStoryboardShotImageGenerationState): CanvasStoryboardShotImageGenerationState {
    const selectedShotIds = [...new Set(shotIds)];
    return {
        batchId, phase: "running", selectedShotIds,
        tasks: Object.fromEntries(selectedShotIds.map(id => [id, {
            ...(previous?.tasks[id]?.status === "failed" && previous.tasks[id].taskId ? { taskId: previous.tasks[id].taskId } : {}),
            status: "pending", progress: 0, requestVersion: (previous?.tasks[id]?.requestVersion || 0) + 1,
        }])),
    };
}

/** Append explicit requests while preserving active work and retry reconciliation IDs. */
export function appendShotImageBatch(state: ShotImageBatchState, shotIds: string[]): ShotImageBatchState {
    const additions = [...new Set(shotIds)].filter(id => state.tasks[id]?.status !== "pending" && state.tasks[id]?.status !== "running");
    if (!additions.length) return state;
    const tasks = { ...state.tasks };
    for (const id of additions) {
        const previous = state.tasks[id];
        tasks[id] = {
            ...(previous?.status === "failed" && previous.taskId ? { taskId: previous.taskId } : {}),
            status: "pending", progress: 0, requestVersion: (previous?.requestVersion || 0) + 1,
        };
    }
    return { ...state, phase: "running", selectedShotIds: [...new Set([...state.selectedShotIds, ...additions])], tasks };
}

export function shotImageBatchSummary(state?: CanvasStoryboardShotImageGenerationState) {
    const items = state?.selectedShotIds.map(id => state.tasks[id]) || [];
    const succeeded = items.filter(item => item?.status === "succeeded").length;
    const queued = items.filter(item => item?.status === "pending").length;
    const running = items.filter(item => item?.status === "running").length;
    const failedIds = state?.selectedShotIds.filter(id => state.tasks[id]?.status === "failed") || [];
    const finished = succeeded + failedIds.length;
    const progress = items.length ? Math.round(items.reduce((total, item) => total +
        (item?.status === "succeeded" || item?.status === "failed" ? 100 : item?.progress || 0), 0) / items.length) : 0;
    return { total: items.length, succeeded, queued, running, failedIds, finished, progress };
}

export function interruptShotImageBatch(state: CanvasStoryboardShotImageGenerationState, error: string): CanvasStoryboardShotImageGenerationState {
    return { ...state, phase: "failed", tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) =>
        [id, task.status === "succeeded" || task.status === "failed" ? task : { ...task, status: "failed", progress: 100, error }])) };
}

/** The task ID is committed before polling; recovery never submits a new task. */
export async function runShotImageBatch<Task extends ImageTask>(options: {
    state: CanvasStoryboardShotImageGenerationState;
    signal: AbortSignal;
    concurrency?: number;
    readState?: () => ShotImageBatchState | undefined;
    subscribeToChanges?: (listener: () => void) => () => void;
    runTask?: ShotImageTaskRunner;
    createTask?: (shotId: string) => Promise<Task>;
    getTask: (taskId: string) => Promise<Task>;
    waitTask: (taskId: string, onProgress: (task: Task) => void) => Promise<Task>;
    readImage: (task: Task) => CanvasStoryboardAssetImage;
    commit: (state: CanvasStoryboardShotImageGenerationState, result?: { shotId: string; image: CanvasStoryboardAssetImage }, durable?: boolean) => Promise<void>;
}): Promise<CanvasStoryboardShotImageGenerationState> {
    let state = options.state;
    let detached = false;
    let commitTail = Promise.resolve();
    const concurrency = normalizeConcurrency(options.concurrency);
    const completedVersions = new Map<string, number>();
    const active = new Map<string, Promise<void>>();
    let fatalError: unknown;
    const versionOf = (task?: CanvasStoryboardShotImageTask) => task?.requestVersion || 0;
    const readLatest = () => {
        if (!options.readState) return state;
        const latest = options.readState();
        if (!latest || latest.batchId !== options.state.batchId) { detached = true; return undefined; }
        state = latest;
        return state;
    };
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
        const pending = commitTail.then(work);
        commitTail = pending.then(() => undefined, () => undefined);
        return pending;
    };
    const patch = (shotId: string, version: number, values: Partial<CanvasStoryboardShotImageTask>, kind: "accepted" | "progress" | "result" | "failure", image?: CanvasStoryboardAssetImage, expectedTaskId?: string) => serialize(async () => {
        const latest = readLatest();
        const preserveAcceptedId = kind === "accepted" && options.signal.aborted;
        // An aborted submission still reaches the caller's commit/cancellation guard.
        if (!latest && !preserveAcceptedId) return;
        const current = state.tasks[shotId];
        if (!preserveAcceptedId && versionOf(current) !== version) return;
        if (kind === "progress" || kind === "result") {
            if (options.signal.aborted || current?.status === "succeeded" || current?.status === "failed" || current?.taskId !== expectedTaskId) return;
        }
        if (kind === "failure" && (current?.status === "succeeded" || (expectedTaskId && current?.taskId && current.taskId !== expectedTaskId))) return;
        if (kind === "accepted" && current?.status === "succeeded" && !preserveAcceptedId) return;
        const next = { ...state, tasks: { ...state.tasks, [shotId]: { ...current, ...values, requestVersion: version } } };
        state = next;
        await options.commit(next, image ? { shotId, image } : undefined, kind !== "progress");
    });
    const executeShot = async (shotId: string, version: number) => {
        if (options.signal.aborted || !readLatest() || detached) return;
        const saved = state.tasks[shotId];
        if (versionOf(saved) !== version || saved?.status === "succeeded" || saved?.status === "failed") return;
        let task: Task | undefined;
        try {
            if (saved?.taskId) task = await options.getTask(saved.taskId);
            if (options.signal.aborted || detached) return;
            if (task && task.status !== "success" && task.status !== "pending" && task.status !== "running") {
                if (!options.createTask) throw new Error(task.errorMessage || "图片生成失败，请重试该镜头");
                task = undefined;
            }
            if (task?.status === "success" && options.createTask) {
                try { options.readImage(task); } catch { task = undefined; }
            }
            if (!task) {
                if (!options.createTask) throw new Error("刷新前尚未提交该镜头，请重试失败项");
                task = await options.createTask(shotId);
            }
            // Even when unmounting, the commit can retain the newly accepted task ID.
            await patch(shotId, version, { taskId: task.id, status: "running", progress: task.progress || 0, error: undefined }, "accepted");
            if (options.signal.aborted || detached) return;
            const pollingTaskId = task.id;
            if (task.status !== "success") task = await options.waitTask(pollingTaskId, current => {
                if (!options.signal.aborted) void patch(shotId, version, { progress: Math.max(0, Math.min(99, current.progress || 0)) }, "progress", undefined, pollingTaskId).catch(() => undefined);
            });
            if (options.signal.aborted || detached) return;
            await patch(shotId, version, { status: "succeeded", progress: 100, error: undefined }, "result", options.readImage(task), pollingTaskId);
        } catch (error) {
            if (options.signal.aborted || detached) return;
            await patch(shotId, version, { status: "failed", progress: 100, error: error instanceof Error ? error.message : "图片生成失败" }, "failure", undefined, task?.id);
        }
    };
    const pendingIds = () => state.selectedShotIds.filter(shotId => {
        const saved = state.tasks[shotId];
        return !active.has(shotId) && saved?.status !== "succeeded" && saved?.status !== "failed"
            && completedVersions.get(shotId) !== versionOf(saved);
    });
    let wake: () => void = () => {};
    let change: Promise<void>;
    const resetChange = () => { change = new Promise<void>(resolve => { wake = resolve; }); };
    resetChange();
    const notify = () => wake();
    const unsubscribe = options.subscribeToChanges?.(notify);
    options.signal.addEventListener("abort", notify);
    try {
        while (true) {
            readLatest();
            if (!options.signal.aborted && !detached && !fatalError) {
                for (const shotId of pendingIds()) {
                    if (active.size >= concurrency) break;
                    const version = versionOf(state.tasks[shotId]);
                    const work = () => executeShot(shotId, version);
                    const promise = (options.runTask ? options.runTask(work, options.signal) : work()).then(
                        () => { completedVersions.set(shotId, version); },
                        error => { if (!options.signal.aborted) fatalError ||= error; },
                    ).finally(() => { active.delete(shotId); });
                    active.set(shotId, promise);
                }
            }
            if (active.size) {
                await Promise.race([...active.values(), change!]);
                resetChange();
                continue;
            }
            await commitTail;
            if (fatalError) throw fatalError;
            if (options.signal.aborted || detached) { readLatest(); return state; }
            await serialize(async () => {
                if (!readLatest() || options.signal.aborted || pendingIds().length) return;
                state = { ...state, phase: shotImageBatchSummary(state).failedIds.length ? "failed" : "succeeded" };
                await options.commit(state, undefined, true);
            });
            // A request may arrive while the final durable save is pending.
            readLatest();
            if (options.signal.aborted || detached || !pendingIds().length) return state;
        }
    } finally {
        unsubscribe?.();
        options.signal.removeEventListener("abort", notify);
    }
}
