import type { VideoCompositionTask } from "@/services/api/video-composition";
import type { CanvasNode, CanvasVideoCompositionNode, CanvasVideoNode } from "../types";
import type { CanvasAgentToolResult } from "../utils/canvas-agent-tools";

export type StartedCanvasComposition = { taskId: string; resultId: string };

type Options = {
    nodeId: string;
    signal: AbortSignal;
    getNodes: () => CanvasNode[];
    start: (node: CanvasVideoCompositionNode) => Promise<StartedCanvasComposition | undefined>;
    wait: (taskId: string, options: { signal: AbortSignal; onProgress: (task: VideoCompositionTask) => void }) => Promise<VideoCompositionTask>;
    apply: (nodeId: string, resultId: string, task: VideoCompositionTask) => void;
    cancel: (taskId: string) => Promise<VideoCompositionTask>;
};

function persistedVideo(node: CanvasNode | undefined): node is CanvasVideoNode {
    return node?.kind === "video" && node.execution.phase === "succeeded"
        && Boolean(node.content.storageKey?.trim() && (node.content.objectStorage?.url || node.content.source)?.trim());
}

function failed(message: string): CanvasAgentToolResult {
    return { ok: false, message, data: { status: "error" } };
}

/** Wait for the existing composition service; a submitted task is never a finished film. */
export async function executeCanvasAgentComposition(options: Options): Promise<CanvasAgentToolResult> {
    const { nodeId, signal, getNodes } = options;
    signal.throwIfAborted();
    const node = getNodes().find(item => item.id === nodeId);
    if (node?.kind !== "videoComposition") return failed("找不到成片合成节点");
    const inputIds = node.composition.inputVideoNodeIds;
    if (inputIds.length < 2 || inputIds.length > 20 || new Set(inputIds).size !== inputIds.length
        || inputIds.some(id => !persistedVideo(getNodes().find(item => item.id === id)))) {
        return failed("请先完成并保存全部镜头视频，再按顺序合成");
    }
    const keysMatch = (current: CanvasVideoCompositionNode) => current.composition.inputStorageKeys?.length === current.composition.inputVideoNodeIds.length
        && current.composition.inputVideoNodeIds.every((id, index) => {
            const video = getNodes().find(item => item.id === id);
            return video?.kind === "video" && current.composition.inputStorageKeys?.[index] === video.content.storageKey;
        });
    const receipt = (taskId?: string): CanvasAgentToolResult => {
        const current = getNodes().find(item => item.id === nodeId);
        const result = current?.kind === "videoComposition"
            ? getNodes().find(item => item.id === current.composition.resultVideoNodeId) : undefined;
        if (current?.kind !== "videoComposition" || current.execution.phase !== "succeeded" || !keysMatch(current) || !persistedVideo(result)) {
            return failed(current?.execution.errorMessage || "视频合成尚未完成，已有镜头已保留");
        }
        return { ok: true, message: "成片已生成并保存", data: {
            nodeId: result.id, compositionNodeId: nodeId, taskId, status: "success",
            storageKey: result.content.storageKey, url: result.content.objectStorage?.url || result.content.source,
        } };
    };
    if (node.execution.phase === "succeeded" && keysMatch(node)) return receipt(node.execution.taskId);
    if (node.execution.phase === "running" && !keysMatch(node)) return failed("合成中的镜头来源已变化，请等当前任务结束后继续成片");
    let taskId: string | undefined;
    let resultId: string | undefined;
    try {
        const started = node.execution.phase === "running"
            ? { taskId: node.execution.taskId || "", resultId: node.composition.resultVideoNodeId || "" }
            : await options.start(node);
        taskId = started?.taskId;
        resultId = started?.resultId;
        signal.throwIfAborted();
        if (!taskId || !started?.resultId) return failed("合成任务未启动，已有视频已保留，请稍后继续成片");
        const task = await options.wait(taskId, {
            signal, onProgress: progress => options.apply(nodeId, started.resultId, progress),
        });
        signal.throwIfAborted();
        options.apply(nodeId, started.resultId, task);
        if (task.status !== "succeeded") return failed(task.errorMessage || (task.status === "canceled" ? "成片合成已取消" : "成片合成失败"));
        if (!task.resultData?.storageKey?.trim() || !task.resultData?.url?.trim()) return failed("合成接口未返回完整的成片文件");
        return receipt(task.id);
    } catch (error) {
        if (signal.aborted) {
            if (taskId && resultId) {
                const canceled = await options.cancel(taskId).catch(() => undefined);
                if (canceled) options.apply(nodeId, resultId, canceled);
            }
            signal.throwIfAborted();
        }
        return failed(error instanceof Error ? error.message : "成片合成失败");
    }
}
