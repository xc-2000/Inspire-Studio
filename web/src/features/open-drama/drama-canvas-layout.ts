import type { CanvasConnection, CanvasNode, CanvasPoint, CanvasStoryboardNode } from "@/features/canvas/types";
import { chapterAssemblyResultNodeId } from "./drama-chapter-assembly";

const GAP = 120;
const KINDS = ["text", "image", "video"] as const;
type RowKind = typeof KINDS[number];
type ShotRow = { boardId: string; nodes: Record<RowKind, CanvasNode[]> };
const dimension = (value: number) => Number.isFinite(value) && value > 0 ? value : 1;

/** Arrange one chapter by shot, moving positions only and preserving every take. */
export function arrangeDramaChapterNodes(nodes: CanvasNode[], chapterId: string, connections: readonly CanvasConnection[] = []): CanvasNode[] {
    if (!chapterId) return nodes;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const boards = nodes.filter((node): node is CanvasStoryboardNode => node.kind === "storyboard" && node.dramaChapterId === chapterId);
    const boardIds = new Set(boards.map(board => board.id));
    const scriptIds = new Set(connections.filter(edge => boardIds.has(edge.target.nodeId) && byId.get(edge.source.nodeId)?.kind === "text")
        .map(edge => edge.source.nodeId));
    const compositionIds = new Set(nodes.filter(node => node.kind === "videoComposition" && node.dramaChapterId === chapterId).map(node => node.id));
    const outputIds = new Set(nodes.flatMap(node => node.kind === "videoComposition" && compositionIds.has(node.id) && node.composition.resultVideoNodeId ? [node.composition.resultVideoNodeId] : []));
    outputIds.add(chapterAssemblyResultNodeId(chapterId));
    connections.filter(edge => compositionIds.has(edge.source.nodeId)).forEach(edge => outputIds.add(edge.target.nodeId));
    const scoped = nodes.filter(node => {
        if (node.dramaChapterId && node.dramaChapterId !== chapterId) return false;
        const linkedBoard = node.dramaStoryboardId ? byId.get(node.dramaStoryboardId) : undefined;
        if (linkedBoard?.dramaChapterId && linkedBoard.dramaChapterId !== chapterId) return false;
        return node.dramaChapterId === chapterId || Boolean(node.dramaStoryboardId && boardIds.has(node.dramaStoryboardId)) || scriptIds.has(node.id) || outputIds.has(node.id);
    });
    if (!scoped.length) return nodes;
    const eligible = new Set(scoped.map(node => node.id));
    const scripts = scoped.filter(node => scriptIds.has(node.id) && !node.dramaShotId);
    const compositions = scoped.filter(node => node.kind === "videoComposition");
    const outputs = scoped.filter(node => outputIds.has(node.id) && node.kind !== "videoComposition");
    const claimed = new Set([...boards, ...scripts, ...compositions, ...outputs].filter(node => eligible.has(node.id)).map(node => node.id));
    const rows: ShotRow[] = [];
    for (const board of boards) {
        const ordered = board.storyboard.shots.map((shot, index) => ({ shot, index }))
            .sort((a, b) => {
                const first = Number.isFinite(a.shot.shotNumber) && a.shot.shotNumber > 0 ? a.shot.shotNumber : Infinity;
                const second = Number.isFinite(b.shot.shotNumber) && b.shot.shotNumber > 0 ? b.shot.shotNumber : Infinity;
                return first === second ? a.index - b.index : first - second;
            });
        for (const { shot } of ordered) {
            const row: ShotRow = { boardId: board.id, nodes: { text: [], image: [], video: [] } };
            for (const node of scoped) {
                if (claimed.has(node.id) || node.dramaStoryboardId !== board.id || node.dramaShotId !== shot.id || !KINDS.includes(node.kind as RowKind)) continue;
                row.nodes[node.kind as RowKind].push(node);
                claimed.add(node.id);
            }
            if (KINDS.some(kind => row.nodes[kind].length)) rows.push(row);
        }
    }

    const left = Math.min(...scoped.map(node => node.frame.position.x));
    const top = Math.min(...scoped.map(node => node.frame.position.y));
    const positions = new Map<string, CanvasPoint>();
    const maxWidth = (items: CanvasNode[], fallback = 0) => Math.max(fallback, ...items.map(node => dimension(node.frame.width)));
    const placeColumn = (items: CanvasNode[], x: number, startY = top) => {
        let y = startY;
        for (const node of items) {
            positions.set(node.id, { x, y });
            y += dimension(node.frame.height) + GAP;
        }
        return items.length ? y - GAP : startY;
    };
    const scriptBottom = placeColumn(scripts, left);
    const boardX = left + (scripts.length ? maxWidth(scripts) + GAP : 0);
    let cursorX = boardX + (boards.length ? maxWidth(boards) + GAP : 0);
    const columnPositions: Record<RowKind, number[]> = { text: [], image: [], video: [] };
    for (const kind of KINDS) {
        const count = rows.length ? Math.max(1, ...rows.map(row => row.nodes[kind].length)) : 0;
        for (let index = 0; index < count; index++) {
            columnPositions[kind].push(cursorX);
            const items = rows.flatMap(row => row.nodes[kind][index] ? [row.nodes[kind][index]] : []);
            cursorX += maxWidth(items, kind === "text" ? 320 : kind === "image" ? 510 : 630) + GAP;
        }
    }
    let rowY = top;
    for (const board of boards) {
        positions.set(board.id, { x: boardX, y: rowY });
        const sectionTop = rowY;
        const boardRows = rows.filter(row => row.boardId === board.id);
        for (const row of boardRows) {
            const members = KINDS.flatMap(kind => row.nodes[kind]);
            for (const kind of KINDS) row.nodes[kind].forEach((node, index) => positions.set(node.id, { x: columnPositions[kind][index], y: rowY }));
            rowY += Math.max(...members.map(node => dimension(node.frame.height))) + GAP;
        }
        rowY = Math.max(rowY, sectionTop + dimension(board.frame.height) + GAP);
    }
    const compositionBottom = placeColumn(compositions, cursorX);
    const outputX = cursorX + (compositions.length ? maxWidth(compositions) + GAP : 0);
    const outputBottom = placeColumn(outputs, outputX);
    const orphans = scoped.filter(node => !claimed.has(node.id));
    placeColumn(orphans, left, Math.max(rowY, scripts.length ? scriptBottom + GAP : top,
        compositions.length ? compositionBottom + GAP : top, outputs.length ? outputBottom + GAP : top));

    let changed = false;
    const arranged = nodes.map(node => {
        const position = positions.get(node.id);
        if (!position || position.x === node.frame.position.x && position.y === node.frame.position.y) return node;
        changed = true;
        return { ...node, frame: { ...node.frame, position } };
    });
    return changed ? arranged : nodes;
}
