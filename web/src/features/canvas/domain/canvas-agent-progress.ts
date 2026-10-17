export type CanvasAgentPlanTask = { status: string; message: string };
export type CanvasAgentPlanProgress = { taskCount: number; tasks: Record<string, CanvasAgentPlanTask> };

export function readCanvasAgentPlanProgress(value: unknown): CanvasAgentPlanProgress | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.taskCount !== "number" || !Number.isFinite(record.taskCount) || !record.tasks || typeof record.tasks !== "object" || Array.isArray(record.tasks)) return null;
    const tasks: Record<string, CanvasAgentPlanTask> = {};
    for (const [id, task] of Object.entries(record.tasks)) {
        if (!task || typeof task !== "object" || Array.isArray(task)) continue;
        const candidate = task as Record<string, unknown>;
        if (typeof candidate.status !== "string" || typeof candidate.message !== "string") continue;
        tasks[id] = { status: candidate.status, message: candidate.message };
    }
    return { taskCount: Math.max(0, Math.floor(record.taskCount)), tasks };
}

export function updateCanvasAgentPlanProgress(value: unknown, taskId: string, status: string, message: string): CanvasAgentPlanProgress {
    const previous = readCanvasAgentPlanProgress(value) || { taskCount: 0, tasks: {} };
    if (!taskId) return previous;
    // A late running/diagnostic event cannot undo a confirmed successful result.
    if (["succeeded", "success", "completed"].includes(previous.tasks[taskId]?.status)
        && !["succeeded", "success", "completed"].includes(status)) return previous;
    return { taskCount: previous.taskCount, tasks: { ...previous.tasks, [taskId]: { status, message } } };
}

export function countCompletedCanvasAgentTasks(progress: CanvasAgentPlanProgress): number {
    return Object.values(progress.tasks).filter((task) => ["succeeded", "success", "completed"].includes(task.status)).length;
}

export function summarizeCanvasAgentProgress(progress: CanvasAgentPlanProgress) {
    const tasks = Object.values(progress.tasks);
    const succeeded = countCompletedCanvasAgentTasks(progress);
    const failed = tasks.filter(task => task.status === "failed").length;
    const skipped = tasks.filter(task => task.status === "skipped").length;
    const canceled = tasks.filter(task => ["canceled", "cancelled"].includes(task.status)).length;
    const settled = Math.min(progress.taskCount, succeeded + failed + skipped + canceled);
    const parts = [`${settled}/${progress.taskCount} 已结束`, `成功 ${succeeded}`];
    if (failed) parts.push(`失败 ${failed}`);
    if (skipped) parts.push(`跳过 ${skipped}`);
    if (canceled) parts.push(`取消 ${canceled}`);
    return { succeeded, failed, skipped, canceled, settled, label: parts.join(" · ") };
}

export function canvasAgentTaskStatusLabel(status: string): string {
    return ({ queued: "排队中", pending: "待执行", running: "执行中", diagnosing: "诊断中",
        adjusting: "调整中", retrying: "重试中", succeeded: "成功", success: "成功", completed: "成功",
        failed: "失败", skipped: "已跳过", canceled: "已取消", cancelled: "已取消" } as Record<string, string>)[status] || "处理中";
}
