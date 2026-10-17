import type { PublishTask, PublishTaskUpdate } from "@/services/api/server";

export const isPublishing = (task: Pick<PublishTask, "status">) => task.status === "queued" || task.status === "running";

/** Preserve the list order and object identity, and never regress an already finished task. */
export function mergePublishTaskStatuses(tasks: PublishTask[], updates: PublishTaskUpdate[]): PublishTask[] {
    const byId = new Map(updates.map((update) => [update.id, update]));
    let changed = false;
    const next = tasks.map((task) => {
        const update = byId.get(task.id);
        if (!update || !isPublishing(task)) return task;
        if (task.status === update.status && task.errorMessage === update.errorMessage
            && task.startedAt === update.startedAt && task.finishedAt === update.finishedAt
            && JSON.stringify(task.resultData) === JSON.stringify(update.resultData)) return task;
        changed = true;
        return { ...task, ...update };
    });
    return changed ? next : tasks;
}

/** One request at a time; no full-list loading state, no polling after completion. */
export function watchPublishTaskStatuses(options: {
    getTasks: () => PublishTask[];
    fetch: (ids: string[]) => Promise<PublishTaskUpdate[]>;
    onUpdate: (updates: PublishTaskUpdate[]) => void;
    onError: (error: boolean) => void;
    isVisible: () => boolean;
    schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
    const schedule = options.schedule ?? setTimeout;
    const cancel = options.cancel ?? clearTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let busy = false;
    let failures = 0;
    const pendingIds = () => options.getTasks().filter(isPublishing).map((task) => task.id);
    const clear = () => { if (timer !== undefined) { cancel(timer); timer = undefined; } };
    const queue = () => {
        clear();
        if (!disposed && options.isVisible() && pendingIds().length) {
            timer = schedule(() => { void poll(); }, Math.min(30_000, 8_000 * (failures + 1)));
        }
    };
    const poll = async () => {
        clear();
        const ids = pendingIds();
        if (disposed || busy || !options.isVisible() || !ids.length) return;
        busy = true;
        try {
            const updates = await options.fetch(ids);
            if (!disposed) { failures = 0; options.onError(false); options.onUpdate(updates); }
        } catch {
            if (!disposed) { failures++; options.onError(true); }
        } finally {
            busy = false;
            queue();
        }
    };
    queue();
    return {
        wake: () => { void poll(); },
        dispose: () => { disposed = true; clear(); },
    };
}
