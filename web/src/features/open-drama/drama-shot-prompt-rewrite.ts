import type { CanvasNode, CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { readDramaShotVideoFeedback } from "./drama-shot-video-feedback";
import { reconcileDramaNodes } from "./drama-workspace";

export type DramaShotPromptRewriteSnapshot = {
    boardId: string;
    shotId: string;
    shotNumber: number;
    prompt: string;
    failureReason: string;
    storyboardContext: string;
    signature: string;
    originalVideoPrompt?: string;
    originalContextMode?: "self-contained";
};

function findShot(nodes: CanvasNode[], boardId: string, shotId: string) {
    const board = nodes.find((node): node is CanvasStoryboardNode => node.kind === "storyboard" && node.id === boardId);
    const shot = board?.storyboard.shots.find(item => item.id === shotId);
    if (!board || !shot) throw new Error("镜头已删除或替换，请重新选择当前镜头");
    if (board.execution.phase === "running" || nodes.some(node => node.kind === "video" && node.dramaStoryboardId === boardId && node.dramaShotId === shotId && node.execution.phase === "running")) {
        throw new Error("镜头正在生成，请等待当前任务结束后再改写提示词");
    }
    return { board, shot };
}

function adjacentContext(shot?: CanvasStoryboardShot) {
    return shot ? { id: shot.id, shotNumber: shot.shotNumber, visualDescription: shot.visualDescription, continuity: shot.continuity } : null;
}

function sourceContext(board: CanvasStoryboardNode, shot: CanvasStoryboardShot) {
    const ordered = [...board.storyboard.shots].sort((a, b) => a.shotNumber - b.shotNumber);
    const index = ordered.findIndex(item => item.id === shot.id);
    return {
        visualStyle: board.content.visualStyle,
        previousShot: adjacentContext(ordered[index - 1]),
        nextShot: adjacentContext(ordered[index + 1]),
        assets: board.storyboard.assets.filter(asset => shot.assetIds.includes(asset.id)),
    };
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
    return value;
}

function sourceSignature(board: CanvasStoryboardNode, shot: CanvasStoryboardShot): string {
    const { video: _runtimeVideo, ...shotInputs } = shot;
    const serialized = JSON.stringify(stableValue({ shot: shotInputs, ...sourceContext(board, shot) }));
    let hash = BigInt("14695981039346656037");
    for (let index = 0; index < serialized.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(serialized.charCodeAt(index))) * BigInt("1099511628211"));
    return hash.toString(16);
}

function clipStrings(value: unknown, limit: number): unknown {
    if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
    if (Array.isArray(value)) return value.map(item => clipStrings(item, limit));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipStrings(item, limit)]));
    return value;
}

function boundedContext(board: CanvasStoryboardNode, shot: CanvasStoryboardShot): string {
    const context = sourceContext(board, shot);
    const input = {
        currentShot: { id: shot.id, shotNumber: shot.shotNumber, visualDescription: shot.visualDescription, videoPrompt: shot.videoPrompt ?? shot.finalPrompt,
            cameraMovement: shot.cameraMovement, durationSeconds: shot.durationSeconds, shotSize: shot.shotSize,
            dialogueVoiceover: shot.dialogueVoiceover, lightingAtmosphere: shot.lightingAtmosphere, soundEffect: shot.soundEffect, continuity: shot.continuity, assetIds: shot.assetIds.slice(0, 20) },
        visualStyle: context.visualStyle,
        assets: context.assets.slice(0, 20).map(asset => ({ id: asset.id, kind: asset.kind, name: asset.name, description: asset.description })),
        omittedAssetCount: Math.max(0, context.assets.length - 20),
        previousShot: context.previousShot,
        nextShot: context.nextShot,
    };
    let stringLimit = 3000;
    let result = JSON.stringify(clipStrings(input, stringLimit));
    while (result.length > 12000) {
        stringLimit = Math.max(1, Math.floor(stringLimit / 2));
        result = JSON.stringify(clipStrings(input, stringLimit));
    }
    return result;
}

export function prepareDramaShotPromptRewrite(nodes: CanvasNode[], boardId: string, shotId: string): DramaShotPromptRewriteSnapshot {
    const { board, shot } = findShot(nodes, boardId, shotId);
    const prompt = (shot.videoPrompt ?? shot.finalPrompt).trim();
    if (!prompt) throw new Error("请先填写当前镜头的视频提示词");
    return { boardId, shotId, shotNumber: shot.shotNumber, prompt,
        failureReason: (readDramaShotVideoFeedback(nodes, boardId, { id: shotId }).error || "").slice(0, 1500),
        storyboardContext: boundedContext(board, shot), signature: sourceSignature(board, shot),
        originalVideoPrompt: shot.videoPrompt, originalContextMode: shot.videoPromptContextMode };
}

function updatePrompt(nodes: CanvasNode[], boardId: string, shotId: string, updater: (shot: CanvasStoryboardShot) => CanvasStoryboardShot): CanvasNode[] {
    const updated = nodes.map(node => node.id === boardId && node.kind === "storyboard"
        ? { ...node, storyboard: { ...node.storyboard, shots: node.storyboard.shots.map(shot => shot.id === shotId ? updater(shot) : shot) } } : node);
    const reconciled = new Map(reconcileDramaNodes(nodes, updated).map(node => [node.id, node]));
    // Reconcile the linked video prompt while preserving unrelated draft/node settings.
    return updated.map(node => {
        const next = reconciled.get(node.id);
        return node.kind === "video" && node.dramaStoryboardId === boardId && node.dramaShotId === shotId && next?.kind === "video" && node.generation.prompt !== next.generation.prompt
            ? { ...node, generation: { ...node.generation, prompt: next.generation.prompt } } : node;
    });
}

export function applyDramaShotPromptRewrite(nodes: CanvasNode[], snapshot: DramaShotPromptRewriteSnapshot, rewritten: string): CanvasNode[] {
    const { board, shot } = findShot(nodes, snapshot.boardId, snapshot.shotId);
    if (sourceSignature(board, shot) !== snapshot.signature) throw new Error("改写期间镜头、参考素材或相邻剧情已修改，结果未覆盖当前内容，请重新改写");
    const prompt = rewritten.trim();
    if (!prompt) throw new Error("改写结果为空，原提示词已保留");
    if (prompt === (shot.videoPrompt ?? shot.finalPrompt).trim()) throw new Error("改写结果与当前提示词相同，原提示词已保留");
    return updatePrompt(nodes, snapshot.boardId, snapshot.shotId, current => ({ ...current, videoPrompt: prompt, videoPromptContextMode: "self-contained" }));
}

export function restoreDramaShotPromptRewrite(nodes: CanvasNode[], snapshot: DramaShotPromptRewriteSnapshot, rewritten: string): CanvasNode[] {
    const { shot } = findShot(nodes, snapshot.boardId, snapshot.shotId);
    if (shot.videoPrompt !== rewritten.trim() || shot.videoPromptContextMode !== "self-contained") throw new Error("提示词已再次修改，无法撤销旧改写；当前内容已保留");
    return updatePrompt(nodes, snapshot.boardId, snapshot.shotId, current => {
        const restored = { ...current };
        if (snapshot.originalVideoPrompt === undefined) delete restored.videoPrompt;
        else restored.videoPrompt = snapshot.originalVideoPrompt;
        if (snapshot.originalContextMode === undefined) delete restored.videoPromptContextMode;
        else restored.videoPromptContextMode = snapshot.originalContextMode;
        return restored;
    });
}
