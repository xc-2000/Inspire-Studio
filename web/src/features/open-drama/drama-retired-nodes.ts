import type { CanvasConnection, CanvasNode, CanvasStoryboardNode } from "@/features/canvas/types";

type Options = { protectedNodeIds?: ReadonlySet<string> };

/** Find obsolete shot subgraphs, never arbitrary unassigned user nodes. Media files remain untouched. */
export function collectRetiredDramaNodeIds(nodes: readonly CanvasNode[], connections: readonly CanvasConnection[], chapterId: string, options: Options = {}): string[] {
    const boards = nodes.filter((node): node is CanvasStoryboardNode => node.kind === "storyboard" && node.dramaChapterId === chapterId);
    const active = new Map(boards.map(board => [board.id, new Set(board.storyboard.shots.map(shot => shot.id))]));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const current = (node: CanvasNode) => Boolean(node.dramaStoryboardId && node.dramaShotId && active.get(node.dramaStoryboardId)?.has(node.dramaShotId));
    const eligible = (node: CanvasNode) => node.dramaChapterId === chapterId && !current(node) && !["running", "queued"].includes(node.execution.phase);
    const candidates = new Set<string>();
    for (const node of nodes) {
        if (!eligible(node) || !["text", "image", "video"].includes(node.kind)) continue;
        const retiredLink = node.dramaStoryboardId && node.dramaShotId && active.has(node.dramaStoryboardId) && !active.get(node.dramaStoryboardId)!.has(node.dramaShotId);
        // Older revisions cleared ownership and prefixed the title, but kept these stable IDs.
        const legacy = !node.dramaStoryboardId && !node.dramaShotId && node.title.startsWith("历史 · ") && boards.some(board => {
            const prefix = `${board.id}:`;
            if (!node.id.startsWith(prefix)) return false;
            const match = node.id.slice(prefix.length).match(/^(.*):(prompt|image|video)$/);
            return match && !active.get(board.id)!.has(match[1]);
        });
        if (retiredLink || legacy) candidates.add(node.id);
    }
    // Include outputs derived solely from obsolete nodes, including their old composition.
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of nodes) {
            if (candidates.has(node.id) || !eligible(node) || !["image", "video", "videoComposition"].includes(node.kind)) continue;
            if (node.dramaShotId || node.dramaStoryboardId) continue;
            const inputIds = new Set(connections.filter(edge => edge.target.nodeId === node.id).map(edge => edge.source.nodeId));
            if (node.kind === "videoComposition") [...node.composition.inputVideoNodeIds, ...(node.composition.editingSourceNodeIds || [])].forEach(id => inputIds.add(id));
            for (const source of nodes) if (source.kind === "videoComposition" && source.composition.resultVideoNodeId === node.id) inputIds.add(source.id);
            if (inputIds.size && [...inputIds].every(id => candidates.has(id))) { candidates.add(node.id); changed = true; }
        }
    }
    const references: Array<[string, string]> = connections.map(edge => [edge.source.nodeId, edge.target.nodeId]);
    const protectedIds = new Set(options.protectedNodeIds);
    for (const node of nodes) {
        if (node.kind === "videoComposition") {
            [...node.composition.inputVideoNodeIds, ...(node.composition.editingSourceNodeIds || [])].forEach(id => references.push([id, node.id]));
            if (node.composition.resultVideoNodeId) references.push([node.id, node.composition.resultVideoNodeId]);
        }
        if (node.kind === "background") node.memberNodeIds.forEach(id => protectedIds.add(id));
        if (node.kind === "image") [node.grouping.rootId, node.grouping.primaryImageId, ...node.grouping.childIds].filter(Boolean).forEach(id => { protectedIds.add(id!); protectedIds.add(node.id); });
        if (node.workflowCondition) { protectedIds.add(node.workflowCondition.sourceId); protectedIds.add(node.id); }
    }
    // Preserve the whole dependency chain when any member is still used in another workflow.
    changed = true;
    while (changed) {
        changed = false;
        for (const id of [...candidates]) if (protectedIds.has(id)) { candidates.delete(id); changed = true; }
        for (const [source, target] of references) {
            const sourceRemoved = candidates.has(source), targetRemoved = candidates.has(target);
            if (sourceRemoved === targetRemoved) continue;
            if (!sourceRemoved && targetRemoved && active.has(source)) continue; // shared storyboard input
            if (!byId.has(source) || !byId.has(target)) continue;
            candidates.delete(sourceRemoved ? source : target); changed = true;
        }
    }
    return nodes.filter(node => candidates.has(node.id)).map(node => node.id);
}

export function removeRetiredDramaNodes(nodes: CanvasNode[], connections: CanvasConnection[], chapterId: string, options?: Options) {
    const removedIds = collectRetiredDramaNodeIds(nodes, connections, chapterId, options);
    if (!removedIds.length) return { nodes, connections, removedIds };
    const removed = new Set(removedIds);
    return { nodes: nodes.filter(node => !removed.has(node.id)), connections: connections.filter(edge => !removed.has(edge.source.nodeId) && !removed.has(edge.target.nodeId)), removedIds };
}
