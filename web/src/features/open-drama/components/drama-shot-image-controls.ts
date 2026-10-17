import type { CanvasStoryboardShot, CanvasStoryboardShotImageTask } from "@/features/canvas/types";

export function isDramaShotImageActive(task?: CanvasStoryboardShotImageTask) {
    return task?.status === "pending" || task?.status === "running";
}

/** Buttons may append eligible shots while other pictures are running. */
export function missingDramaShotImageIds(shots: readonly CanvasStoryboardShot[], tasks: Record<string, CanvasStoryboardShotImageTask> = {}) {
    return shots.filter(shot => !shot.image?.source && !isDramaShotImageActive(tasks[shot.id])).map(shot => shot.id);
}

export function failedDramaShotImageIds(shots: readonly CanvasStoryboardShot[], tasks: Record<string, CanvasStoryboardShotImageTask> = {}) {
    return shots.filter(shot => tasks[shot.id]?.status === "failed").map(shot => shot.id);
}

export function dramaShotImageTaskLabel(task?: CanvasStoryboardShotImageTask) {
    if (task?.status === "pending") return "排队等待 / 准备参考素材";
    if (task?.status === "running") return `图片处理中 · ${Math.max(0, Math.min(100, Math.round(task.progress || 0)))}%`;
    return "";
}
