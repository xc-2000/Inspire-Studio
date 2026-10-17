import type { CanvasNode } from "../types.ts";
import { formatGenerationError } from "@/shared/lib/generation-error";

export type CanvasTaskRow = {
    id: string;
    nodeId: string;
    title: string;
    category: "node" | "shotImage" | "assetImage";
    phase: "running" | "succeeded" | "failed";
    stage: string;
    progress?: number;
    error?: string;
    taskId?: string;
    itemId?: string;
};

/** Read persisted tasks across chapters without mounting their media. */
export function canvasTaskRows(nodes: CanvasNode[]): CanvasTaskRow[] {
    const rows: CanvasTaskRow[] = [];
    for (const node of nodes) {
        const assetBatch = node.kind === "storyboard" ? node.storyboard.assetGeneration : undefined;
        const shotBatch = node.kind === "storyboard" ? node.storyboard.shotImageGeneration : undefined;
        if (node.execution.phase !== "idle" && node.kind !== "background" && node.kind !== "audio" &&
            (node.execution.phase !== "succeeded" || node.execution.taskId || node.execution.startedAt || node.execution.completedAt) &&
            !(assetBatch && node.execution.taskId === "")) {
            rows.push({ id: `node:${node.id}`, nodeId: node.id, title: node.title || "未命名节点", category: "node", phase: node.execution.phase,
                stage: node.execution.phase === "running" ? "生成中" : node.execution.phase === "failed" ? "失败" : "已完成", progress: node.execution.progress,
                error: node.execution.errorMessage ? formatGenerationError(node.execution.errorMessage) : undefined, taskId: node.execution.taskId });
        }
        if (node.kind !== "storyboard") continue;
        if (shotBatch) for (const shotId of shotBatch.selectedShotIds) {
            const task = shotBatch.tasks[shotId];
            const shot = node.storyboard.shots.find(item => item.id === shotId);
            if (!task || !shot) continue;
            rows.push({ id: `shot:${node.id}:${shotId}`, nodeId: node.id, itemId: shotId, title: `${node.title} · 镜头 ${shot.shotNumber} 图片`, category: "shotImage",
                phase: task.status === "pending" ? "running" : task.status, stage: task.status === "pending" ? "待提交" : task.status === "running" ? "生成与存储中" : task.status === "failed" ? "失败" : "已完成",
                progress: task.progress, error: task.error, taskId: task.taskId });
        }
        if (assetBatch) for (const assetId of assetBatch.selectedAssetIds) {
            const asset = node.storyboard.assets.find(item => item.id === assetId);
            const status = assetBatch.statuses[assetId];
            if (!asset || !status) continue;
            rows.push({ id: `asset:${node.id}:${assetId}`, nodeId: node.id, itemId: assetId, title: `${node.title} · ${asset.name}`, category: "assetImage",
                phase: status === "pending" ? "running" : status, stage: status === "pending" ? "待提交" : status === "running" ? "生成与存储中" : status === "failed" ? "失败" : "已完成",
                error: assetBatch.errors[assetId], taskId: assetBatch.taskIds[assetId] });
        }
    }
    const order = { running: 0, failed: 1, succeeded: 2 };
    return rows.sort((a, b) => order[a.phase] - order[b.phase]);
}
