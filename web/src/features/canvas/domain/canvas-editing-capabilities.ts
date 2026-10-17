import type { CanvasNode } from "../types";

/** Contextual actions are available only for a compatible selection. */
export function canvasEditingCapabilities(nodes: readonly CanvasNode[], selectedIds: ReadonlySet<string>) {
    const selected = nodes.filter((node) => selectedIds.has(node.id));
    const count = selected.length === 1 && selected[0].kind === "background" ? selected[0].memberNodeIds.length : selected.length;
    const videos = selected.filter((node) => node.kind === "video" && Boolean(node.content.source));
    return {
        selected,
        selectionCount: count,
        canArrange: count >= 2 || (!selected.length && nodes.filter((node) => node.kind !== "background").length >= 2),
        canDuplicate: selected.length > 0,
        canRefine: selected.length === 1 && selected[0].kind === "image" && Boolean(selected[0].content.source),
        canEditVideo: videos.length > 0,
        canCompare: selected.length === 2 && videos.length === 2,
    };
}
