import type { CanvasNode, CanvasStoryboardShot, CanvasVideoNode } from "@/features/canvas/types";

export type DramaShotVideoFeedback = {
    state: "idle" | "queued" | "running" | "failed" | "ready";
    label: string;
    error?: string;
    nodeId?: string;
};

function attemptTime(node: CanvasVideoNode): number {
    // Prefer start time: an old request completing late must not replace a newer attempt.
    return Date.parse(node.execution.startedAt || node.execution.completedAt || "") || 0;
}

export function readDramaShotVideoFeedback(
    nodes: CanvasNode[], boardId: string, shot: Pick<CanvasStoryboardShot, "id" | "video">,
): DramaShotVideoFeedback {
    let latest: CanvasVideoNode | undefined;
    for (const node of nodes) {
        if (node.kind !== "video" || node.dramaStoryboardId !== boardId || node.dramaShotId !== shot.id) continue;
        if (node.execution.phase === "idle" && !node.content.source) continue;
        const previousTime = latest ? attemptTime(latest) : 0;
        const nextTime = attemptTime(node);
        // Legacy tasks have no timestamp. New attempts are appended to the canvas.
        if (!latest || !previousTime || !nextTime || nextTime >= previousTime) latest = node;
    }
    if (latest?.execution.phase === "running") {
        const progress = Number.isFinite(latest.execution.progress) ? Math.min(100, Math.max(0, Math.round(latest.execution.progress!))) : 0;
        const submitted = Boolean(latest.execution.taskId) || progress > 0;
        return { state: submitted ? "running" : "queued", label: submitted ? `视频生成中${progress ? ` ${progress}%` : ""}` : "视频排队中", nodeId: latest.id };
    }
    if (shot.video?.source) return { state: "ready", label: "视频就绪" };
    if (latest?.execution.phase === "failed") {
        return { state: "failed", label: "视频未完成", error: latest.execution.errorMessage?.trim() || "视频生成失败，请检查生成条件后重试", nodeId: latest.id };
    }
    return { state: "idle", label: "待生成视频" };
}
