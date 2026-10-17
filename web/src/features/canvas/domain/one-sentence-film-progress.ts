import type { CanvasConnection, CanvasNode } from "../types";
import { finishOneSentenceFilm, readFilmWorkflow, type OneSentenceFilm } from "../infinite-agent/one-sentence-film";

export type OneSentenceFilmRun = OneSentenceFilm;

export type OneSentenceFilmStage = {
    id: "script" | "image" | "video" | "film";
    label: string;
    total: number;
    completed: number;
    failed: number;
    running: number;
    nodeId?: string;
};

export type OneSentenceFilmShotStep = {
    kind: "text" | "image" | "video";
    label: string;
    status: "missing" | "pending" | "running" | "completed" | "failed";
    nodeId?: string;
};

export type OneSentenceFilmShotProgress = {
    id: string;
    label: string;
    steps: OneSentenceFilmShotStep[];
};

/** Check persisted data at the UI boundary; stale memory is never evidence of a finished video. */
export function readOneSentenceFilmRun(value: unknown): OneSentenceFilmRun | undefined {
    if (!value || typeof value !== "object") return undefined;
    const run = value as Record<string, unknown>;
    if (typeof run.brief !== "string" || !Array.isArray(run.nodeIds)
        || !["running", "interrupted", "completed"].includes(String(run.status))) return undefined;
    const workflow = readFilmWorkflow(run.workflow);
    return {
        brief: run.brief,
        nodeIds: [...new Set(run.nodeIds.filter((id): id is string => typeof id === "string" && Boolean(id)))],
        status: run.status as OneSentenceFilmRun["status"],
        ...(typeof run.resultNodeId === "string" && run.resultNodeId ? { resultNodeId: run.resultNodeId } : {}),
        ...(run.pipelineMode === "full" || run.pipelineMode === "existing-clips" ? { pipelineMode: run.pipelineMode } : {}),
        ...(workflow ? { workflow } : {}),
    };
}

export function buildOneSentenceFilmMessage(text: string, enabled: boolean): string {
    const trimmed = text.trim();
    return enabled && trimmed && !trimmed.startsWith("【一句话成片】") ? `【一句话成片】\n${trimmed}` : trimmed;
}

export function summarizeOneSentenceFilmProgress(run: OneSentenceFilmRun, nodes: CanvasNode[], connections: CanvasConnection[] = []) {
    const ids = new Set(run.nodeIds);
    const ownNodes = nodes.filter((node) => ids.has(node.id));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const fullPipeline = run.pipelineMode === "full";
    const workflow = fullPipeline ? run.workflow : undefined;
    const plannedIds = workflow ? [...new Set([workflow.scriptNodeId, ...(workflow.assets || []).map(asset => asset.imageNodeId), ...workflow.shots.flatMap(shot => [shot.textNodeId, shot.imageNodeId, shot.videoNodeId]),
        ...(workflow.compositionNodeId ? [workflow.compositionNodeId] : []), ...(run.resultNodeId ? [run.resultNodeId] : [])])] : run.nodeIds;
    const progressNodes = workflow ? plannedIds.flatMap(id => byId.get(id) ? [byId.get(id)!] : []) : ownNodes;
    // Reuse execution's full validation: a persisted completed flag can become stale after edits.
    const verified = run.status === "completed" ? finishOneSentenceFilm(run, nodes, connections).film : undefined;
    const resultId = verified?.status === "completed" ? verified.resultNodeId : run.resultNodeId;
    const result = ownNodes.find((node) => node.id === resultId);
    const completed = (node: CanvasNode) => {
        if (node.execution.phase === "failed" || node.execution.phase === "running") return false;
        if (node.kind === "text") return (!fullPipeline || node.execution.phase === "succeeded") && Boolean(node.content.text.trim());
        if (node.kind !== "image" && node.kind !== "video") return false;
        const url = node.content.objectStorage?.url || node.content.source;
        return node.execution.phase === "succeeded" && Boolean(url)
            && (!fullPipeline || Boolean(node.content.storageKey?.trim() && /^(?:https?:\/\/|\/(?!\/))/.test(url)));
    };
    const stage = (id: OneSentenceFilmStage["id"], label: string, items: CanvasNode[], minimumTotal = 0): OneSentenceFilmStage => ({
        id, label, total: Math.max(minimumTotal, items.length),
        completed: items.filter(completed).length,
        failed: items.filter((node) => node.execution.phase === "failed").length,
        running: items.filter((node) => node.execution.phase === "running").length,
        nodeId: items.find((node) => node.execution.phase === "failed")?.id || items.find(completed)?.id || items[0]?.id,
    });
    const plannedNodes = (nodeIds: string[], kind: CanvasNode["kind"]) => [...new Set(nodeIds)].flatMap(id => {
        const node = byId.get(id);
        return node?.kind === kind ? [node] : [];
    });
    const compositionNodes = progressNodes.filter((node) => node.kind === "videoComposition");
    const stages = [
        stage("script", fullPipeline ? "剧本文字" : "剧本", workflow ? plannedNodes([workflow.scriptNodeId, ...workflow.shots.map(shot => shot.textNodeId)], "text") : fullPipeline ? [] : ownNodes.filter((node) => node.kind === "text"), workflow ? workflow.shots.length + 1 : fullPipeline ? 1 : 0),
        stage("image", workflow?.productionVersion ? "参考与分镜图" : fullPipeline ? "分镜图" : "图片", workflow ? plannedNodes([...(workflow.assets || []).map(asset => asset.imageNodeId), ...workflow.shots.map(shot => shot.imageNodeId)], "image") : fullPipeline ? [] : ownNodes.filter((node) => node.kind === "image"), workflow ? workflow.shots.length + new Set((workflow.assets || []).map(asset => asset.imageNodeId)).size : 0),
        stage("video", fullPipeline ? "镜头视频" : "片段", workflow ? plannedNodes(workflow.shots.map(shot => shot.videoNodeId), "video") : fullPipeline ? [] : ownNodes.filter((node) => node.kind === "video" && node.id !== resultId), workflow?.shots.length || 0),
        stage("film", "成片", result?.kind === "video" ? [result] : [], 1),
    ];
    const film = stages[3];
    if (verified?.status !== "completed") film.completed = 0;
    if (!film.completed && compositionNodes.length) {
        film.running = Math.max(film.running, compositionNodes.some((node) => node.execution.phase === "running") ? 1 : 0);
        film.failed = Math.max(film.failed, compositionNodes.some((node) => node.execution.phase === "failed") ? 1 : 0);
        film.nodeId ||= compositionNodes.find((node) => node.execution.phase === "failed")?.id || compositionNodes[0]?.id;
    }
    const failedNodes = progressNodes.filter((node) => node.execution.phase === "failed");
    if (result?.execution.phase === "failed" && !ids.has(result.id)) failedNodes.push(result);
    const missing = plannedIds.filter((id) => !byId.has(id)).length;
    const ready = film.completed === 1;
    const activeStage = stages.find((item) => item.running > 0);
    const shots: OneSentenceFilmShotProgress[] = (workflow?.shots || []).map((shot, index) => {
        const textNode = byId.get(shot.textNodeId);
        const steps: OneSentenceFilmShotStep[] = ([
            { kind: "text", label: "文字", id: shot.textNodeId },
            { kind: "image", label: "分镜图", id: shot.imageNodeId },
            { kind: "video", label: "视频", id: shot.videoNodeId },
        ] as const).map((step) => {
            const candidate = byId.get(step.id);
            const node = candidate?.kind === step.kind ? candidate : undefined;
            return { kind: step.kind, label: step.label, nodeId: node?.id,
                status: !node ? "missing" : node.execution.phase === "failed" ? "failed" : node.execution.phase === "running" ? "running" : completed(node) ? "completed" : "pending" };
        });
        return { id: shot.textNodeId, label: textNode?.title || `镜头 ${index + 1}`, steps };
    });
    return {
        stages, shots, fullPipeline, ready, missing, failed: failedNodes.length,
        failedNodeId: failedNodes[0]?.id,
        resultNodeId: ready ? result?.id : undefined,
        label: ready ? "成片已就绪" : failedNodes.length ? "部分任务未完成" : run.status === "running" ? (activeStage ? `正在制作${activeStage.label}` : "正在自动制作") : "等待继续制作",
    };
}
