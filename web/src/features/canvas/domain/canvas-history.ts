import type { CanvasConnection, CanvasNode } from "../types";

/** Ignore referential changes from restored/normalized JSON snapshots. */
export function sameCanvasHistoryValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameCanvasHistoryValue(value, right[index]));
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length && keys.every((key) => Object.hasOwn(b, key) && sameCanvasHistoryValue(a[key], b[key]));
}

type CanvasEditingHistory = {
    nodes: CanvasNode[];
    connections: CanvasConnection[];
    backgroundMode: unknown;
    showImageInfo: boolean;
};

/** Conversations and asynchronous task updates belong to live state, not edit history. */
export function sameCanvasEditingHistoryValue(left: CanvasEditingHistory, right: CanvasEditingHistory): boolean {
    if (!sameCanvasHistoryValue(left.connections, right.connections)
        || left.backgroundMode !== right.backgroundMode || left.showImageInfo !== right.showImageInfo
        || left.nodes.length !== right.nodes.length) return false;
    return left.nodes.every((node, index) => {
        const next = right.nodes[index];
        if (node.id !== next.id || node.kind !== next.kind) return false;
        const runtimeMutation = isTaskRuntimeMutation(node, next);
        const rebased = mergeTaskRuntime(node, next, runtimeMutation);
        if (runtimeMutation && node.execution.phase !== next.execution.phase) {
            rebased.frame = { ...rebased.frame, width: next.frame.width, height: next.frame.height };
        }
        return sameCanvasHistoryValue(editableNode(rebased), editableNode(next));
    });
}

export function rememberCanvasTaskRuntime(registry: Map<string, CanvasNode>, nodes: readonly CanvasNode[]): void {
    nodes.forEach((node) => {
        if (node.execution.phase !== "idle" || node.execution.taskId || hasStoryboardTask(node)) registry.set(node.id, node);
    });
}

/** Save the canceled state before React batches deletion, so undo cannot revive it. */
export function rememberInterruptedCanvasTaskRuntime(registry: Map<string, CanvasNode>, nodes: readonly CanvasNode[], removedOrAffectedIds: ReadonlySet<string>): void {
    rememberCanvasTaskRuntime(registry, nodes);
    nodes.forEach((node) => {
        if (!removedOrAffectedIds.has(node.id) || node.execution.phase !== "running") return;
        registry.set(node.id, { ...node, execution: { ...node.execution, phase: "failed", errorMessage: "任务节点已删除，生成已停止，请重新生成。" } });
    });
}

/** Undo edits without rewinding tasks or dropping their running result nodes. */
export function restoreCanvasHistoryScene(target: Pick<CanvasEditingHistory, "nodes" | "connections">, current: Pick<CanvasEditingHistory, "nodes" | "connections">, registry: ReadonlyMap<string, CanvasNode>) {
    const currentById = new Map(current.nodes.map((node) => [node.id, node]));
    const restored = target.nodes.map((node) => {
        const live = currentById.get(node.id) || registry.get(node.id);
        if (!live || live.kind !== node.kind) return node;
        const merged = mergeTaskRuntime(node, live, isTaskRuntimeMutation(node, live));
        if (currentById.has(node.id) || !isRunningCanvasTask(merged)) return merged;
        // A deleted task has no mounted monitor. Restoring it must not invent a live run.
        const interrupted = { ...merged, execution: merged.execution.phase === "running"
            ? { ...merged.execution, phase: "failed" as const, errorMessage: "任务节点曾被删除，请重新生成。" } : merged.execution };
        if (interrupted.kind !== "storyboard") return interrupted;
        return { ...interrupted, storyboard: { ...interrupted.storyboard,
            ...(interrupted.storyboard.assetGeneration?.phase === "running" ? { assetGeneration: { ...interrupted.storyboard.assetGeneration, phase: "failed" as const, errorMessage: "任务节点曾被删除，请重新生成。" } } : {}),
            ...(interrupted.storyboard.shotImageGeneration?.phase === "running" ? { shotImageGeneration: { ...interrupted.storyboard.shotImageGeneration, phase: "failed" as const } } : {}),
        } };
    });
    const targetIds = new Set(restored.map((node) => node.id));
    const retained = current.nodes.filter((node) => !targetIds.has(node.id) && isRunningCanvasTask(node));
    const nodes = [...restored, ...retained];
    const nodeIds = new Set(nodes.map((node) => node.id));
    const retainedIds = new Set(retained.map((node) => node.id));
    const connections = [...target.connections, ...current.connections.filter((connection) =>
        !target.connections.some((entry) => entry.id === connection.id)
        && (retainedIds.has(connection.source.nodeId) || retainedIds.has(connection.target.nodeId)))]
        .filter((connection) => nodeIds.has(connection.source.nodeId) && nodeIds.has(connection.target.nodeId));
    return { nodes, connections, retainedRunningNodeCount: retained.length };
}

function hasStoryboardTask(node: CanvasNode): boolean {
    return node.kind === "storyboard" && Boolean(node.storyboard.assetGeneration || node.storyboard.shotImageGeneration);
}

function isRunningCanvasTask(node: CanvasNode): boolean {
    return node.execution.phase === "running" || (node.kind === "storyboard"
        && (node.storyboard.assetGeneration?.phase === "running" || node.storyboard.shotImageGeneration?.phase === "running"));
}

function isTaskRuntimeMutation(node: CanvasNode, live: CanvasNode): boolean {
    return (node.execution.phase === "running" || live.execution.phase === "running"
        || !sameCanvasHistoryValue(node.execution, live.execution))
        && (node.execution.phase !== "idle" || live.execution.phase !== "idle" || Boolean(node.execution.taskId || live.execution.taskId));
}

function editableNode(node: CanvasNode): unknown {
    const { execution: _execution, ...editable } = node;
    if (node.kind !== "storyboard") return editable;
    const { assetGeneration: _assetGeneration, shotImageGeneration: _shotImageGeneration, ...storyboard } = node.storyboard;
    return { ...editable, storyboard };
}

function mergeTaskRuntime(node: CanvasNode, live: CanvasNode, includeOutput: boolean): CanvasNode {
    if (node.kind !== live.kind) return node;
    const base = { ...node, execution: live.execution };
    if (node.kind === "image" && live.kind === "image") return { ...base, kind: "image", content: includeOutput ? live.content : node.content, generation: node.generation, grouping: node.grouping, frame: includeOutput ? resultFrame(node, live) : node.frame };
    if (node.kind === "video" && live.kind === "video") return { ...base, kind: "video", content: includeOutput ? live.content : node.content, generation: node.generation, frame: includeOutput ? resultFrame(node, live) : node.frame };
    if (node.kind === "text" && live.kind === "text") return { ...base, kind: "text", content: { ...node.content, text: includeOutput ? live.content.text : node.content.text } };
    if (node.kind === "videoComposition" && live.kind === "videoComposition") return { ...base, kind: "videoComposition", composition: { ...node.composition, ...(includeOutput ? { resultVideoNodeId: live.composition.resultVideoNodeId, inputStorageKeys: live.composition.inputStorageKeys } : {}) } };
    if (node.kind === "storyboard" && live.kind === "storyboard") {
        // Batch image updates and main-task progress must not overwrite script edits.
        const replaceGeneratedStoryboard = includeOutput && live.execution.phase === "succeeded"
            && (node.execution.phase !== live.execution.phase || node.execution.taskId !== live.execution.taskId || node.execution.startedAt !== live.execution.startedAt);
        const assetTaskChanged = !sameCanvasHistoryValue(node.storyboard.assetGeneration, live.storyboard.assetGeneration)
            || node.storyboard.assetGeneration?.phase === "running" || live.storyboard.assetGeneration?.phase === "running";
        const shotTaskChanged = !sameCanvasHistoryValue(node.storyboard.shotImageGeneration, live.storyboard.shotImageGeneration)
            || node.storyboard.shotImageGeneration?.phase === "running" || live.storyboard.shotImageGeneration?.phase === "running";
        const assetsById = new Map(live.storyboard.assets.map((asset) => [asset.id, asset]));
        const shotsById = new Map(live.storyboard.shots.map((shot) => [shot.id, shot]));
        return { ...base, kind: "storyboard", content: node.content, storyboard: { ...node.storyboard,
            assets: replaceGeneratedStoryboard ? live.storyboard.assets : assetTaskChanged ? node.storyboard.assets.map((asset) => ({ ...asset, image: assetsById.get(asset.id)?.image || asset.image })) : node.storyboard.assets,
            shots: replaceGeneratedStoryboard ? live.storyboard.shots : shotTaskChanged ? node.storyboard.shots.map((shot) => ({ ...shot, image: shotsById.get(shot.id)?.image || shot.image })) : node.storyboard.shots,
            assetGeneration: live.storyboard.assetGeneration,
            shotImageGeneration: live.storyboard.shotImageGeneration,
        } };
    }
    return base;
}

function resultFrame(node: CanvasNode, live: CanvasNode) {
    return { ...node.frame, naturalWidth: live.frame.naturalWidth, naturalHeight: live.frame.naturalHeight };
}
