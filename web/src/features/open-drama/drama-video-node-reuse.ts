import type { CanvasConnection, CanvasNode, CanvasStoryboardNode, CanvasVideoNode } from "@/features/canvas/types";

type Options = { protectedNodeIds?: ReadonlySet<string> };

function protectedReferences(nodes: readonly CanvasNode[], options?: Options): Set<string> {
    const ids = new Set(options?.protectedNodeIds);
    for (const node of nodes) {
        if (node.kind === "background") node.memberNodeIds.forEach(id => ids.add(id));
        if (node.kind === "image") {
            node.grouping.childIds.forEach(id => ids.add(id));
            if (node.grouping.rootId) ids.add(node.grouping.rootId);
            if (node.grouping.primaryImageId) ids.add(node.grouping.primaryImageId);
        }
        if (node.kind === "videoComposition") {
            node.composition.inputVideoNodeIds.forEach(id => ids.add(id));
            node.composition.editingSourceNodeIds?.forEach(id => ids.add(id));
            if (node.composition.resultVideoNodeId) ids.add(node.composition.resultVideoNodeId);
        }
    }
    return ids;
}

function safeFailedNodes(nodes: readonly CanvasNode[], connections: readonly CanvasConnection[], options?: Options): CanvasVideoNode[] {
    const protectedIds = protectedReferences(nodes, options);
    const boards = new Map(nodes.filter((node): node is CanvasStoryboardNode => node.kind === "storyboard").map(node => [node.id, node]));
    return nodes.filter((node): node is CanvasVideoNode => {
        if (node.kind !== "video" || node.execution.phase !== "failed" || node.content.source || node.content.storageKey || node.content.objectStorage?.url) return false;
        if (!node.dramaStoryboardId || !node.dramaShotId || protectedIds.has(node.id) || node.workflowCondition) return false;
        const shot = boards.get(node.dramaStoryboardId)?.storyboard.shots.find(item => item.id === node.dramaShotId);
        if (!shot || node.generation.prompt.trim() !== (shot.videoPrompt ?? shot.finalPrompt).trim()) return false;
        const incoming = connections.filter(connection => connection.target.nodeId === node.id);
        // Preserve manually disconnected nodes and any node that participates in another workflow.
        return incoming.length > 0 && incoming.every(connection => connection.source.nodeId === node.dramaStoryboardId)
            && !connections.some(connection => connection.source.nodeId === node.id);
    });
}

function latestAttempt(nodes: readonly CanvasVideoNode[]): CanvasVideoNode | undefined {
    return nodes.reduce<CanvasVideoNode | undefined>((latest, node) => {
        if (!latest) return node;
        const before = Date.parse(latest.execution.startedAt || latest.execution.completedAt || "") || 0;
        const after = Date.parse(node.execution.startedAt || node.execution.completedAt || "") || 0;
        // Historical tasks were appended without timestamps.
        return !before || !after || after >= before ? node : latest;
    }, undefined);
}

/** Reuse the empty failed placeholder without overwriting media or a manual workflow. */
export function findReusableDramaVideoNode(
    nodes: readonly CanvasNode[], connections: readonly CanvasConnection[], boardId: string, shotId: string, options?: Options,
): CanvasVideoNode | undefined {
    return latestAttempt(safeFailedNodes(nodes, connections, options).filter(node => node.dramaStoryboardId === boardId && node.dramaShotId === shotId));
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
    return value;
}

/** Only older, identical, unreferenced failures are redundant. Keep one failure per setting. */
export function collectRedundantFailedDramaVideoNodeIds(
    nodes: readonly CanvasNode[], connections: readonly CanvasConnection[], options?: Options & { boardId?: string },
): string[] {
    const groups = new Map<string, CanvasVideoNode[]>();
    for (const node of safeFailedNodes(nodes, connections, options)) {
        if (options?.boardId && node.dramaStoryboardId !== options.boardId) continue;
        const key = JSON.stringify([node.dramaStoryboardId, node.dramaShotId, stableValue(node.generation)]);
        const group = groups.get(key) || [];
        group.push(node);
        groups.set(key, group);
    }
    const redundantIds = new Set<string>();
    for (const group of groups.values()) {
        const latest = latestAttempt(group);
        group.filter(node => node.id !== latest?.id).forEach(node => redundantIds.add(node.id));
    }
    return nodes.filter(node => redundantIds.has(node.id)).map(node => node.id);
}
