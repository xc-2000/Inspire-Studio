import type { CanvasConnection, CanvasNode, CanvasPoint } from "../types";
import { expandBackgroundBoardsToMembers } from "./canvas-page-node";

export type CanvasArrangement = "dag" | "grid" | "left" | "centerX" | "right" | "top" | "centerY" | "bottom" | "distributeX" | "distributeY";
export const CANVAS_ARRANGEMENTS: Array<{ value: CanvasArrangement; label: string; minimum: number }> = [
    { value: "dag", label: "按连线自动布局", minimum: 2 }, { value: "grid", label: "网格排列", minimum: 2 },
    { value: "left", label: "左对齐", minimum: 2 }, { value: "centerX", label: "水平居中对齐", minimum: 2 }, { value: "right", label: "右对齐", minimum: 2 },
    { value: "top", label: "顶端对齐", minimum: 2 }, { value: "centerY", label: "垂直居中对齐", minimum: 2 }, { value: "bottom", label: "底端对齐", minimum: 2 },
    { value: "distributeX", label: "水平等距分布", minimum: 3 }, { value: "distributeY", label: "垂直等距分布", minimum: 3 },
];

export function expandCanvasSelection(nodes: CanvasNode[], ids: ReadonlySet<string>): Set<string> {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const result = new Set<string>();
    const visit = (id: string) => {
        if (result.has(id)) return;
        const node = byId.get(id);
        if (!node) return;
        result.add(id);
        const children = node.kind === "background" ? node.memberNodeIds : node.kind === "image" && node.grouping.isRoot ? node.grouping.childIds : [];
        children.forEach(visit);
    };
    ids.forEach(visit);
    return result;
}

export function canvasNodesBounds(nodes: CanvasNode[]) {
    if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(...nodes.map((node) => node.frame.position.x));
    const y = Math.min(...nodes.map((node) => node.frame.position.y));
    return { x, y, width: Math.max(...nodes.map((node) => node.frame.position.x + node.frame.width)) - x, height: Math.max(...nodes.map((node) => node.frame.position.y + node.frame.height)) - y };
}

function arrangementUnits(nodes: CanvasNode[], selected: ReadonlySet<string>) {
    const candidates = nodes.filter((node) => selected.has(node.id));
    // Boards and image batches move as one unit, even when their members are also selected.
    const ordered = [...candidates.filter((node) => node.kind === "background"), ...candidates.filter((node) => node.kind === "image" && node.grouping.isRoot), ...candidates];
    const claimed = new Set<string>();
    return ordered.flatMap((node) => {
        if (claimed.has(node.id)) return [];
        const members = expandCanvasSelection(nodes, new Set([node.id]));
        members.forEach((id) => claimed.add(id));
        return [{ id: node.id, members, ...canvasNodesBounds(nodes.filter((item) => members.has(item.id))) }];
    });
}

export function arrangeCanvasNodes(nodes: CanvasNode[], connections: CanvasConnection[], selected: ReadonlySet<string>, mode: CanvasArrangement): CanvasNode[] {
    const units = arrangementUnits(nodes, selected);
    const minimum = CANVAS_ARRANGEMENTS.find((item) => item.value === mode)?.minimum || 2;
    if (units.length < minimum) return nodes;
    const left = Math.min(...units.map((unit) => unit.x));
    const top = Math.min(...units.map((unit) => unit.y));
    const right = Math.max(...units.map((unit) => unit.x + unit.width));
    const bottom = Math.max(...units.map((unit) => unit.y + unit.height));
    const positions = new Map<string, CanvasPoint>();
    const ordered = [...units].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    if (mode === "dag" || mode === "grid") {
        const columns = new Map<number, typeof units>();
        if (mode === "grid") {
            const count = Math.ceil(Math.sqrt(units.length));
            ordered.forEach((unit, index) => columns.set(index % count, [...(columns.get(index % count) || []), unit]));
        } else {
            const owner = new Map<string, string>();
            units.forEach((unit) => unit.members.forEach((id) => owner.set(id, unit.id)));
            const outgoing = new Map(units.map((unit) => [unit.id, new Set<string>()]));
            const incoming = new Map(units.map((unit) => [unit.id, 0]));
            connections.forEach((edge) => {
                const source = owner.get(edge.source.nodeId), target = owner.get(edge.target.nodeId);
                if (!source || !target || source === target || outgoing.get(source)!.has(target)) return;
                outgoing.get(source)!.add(target);
                incoming.set(target, incoming.get(target)! + 1);
            });
            const ranks = new Map(units.map((unit) => [unit.id, 0]));
            const queue = ordered.filter((unit) => !incoming.get(unit.id)).map((unit) => unit.id);
            const visited = new Set<string>();
            for (let index = 0; index < queue.length; index++) {
                const id = queue[index];
                visited.add(id);
                outgoing.get(id)!.forEach((target) => {
                    ranks.set(target, Math.max(ranks.get(target)!, ranks.get(id)! + 1));
                    incoming.set(target, incoming.get(target)! - 1);
                    if (!incoming.get(target)) queue.push(target);
                });
            }
            // Invalid cyclic graphs still receive finite, non-overlapping positions.
            const cycleRank = Math.max(...ranks.values()) + 1;
            ordered.forEach((unit) => {
                const rank = visited.has(unit.id) ? ranks.get(unit.id)! : cycleRank;
                columns.set(rank, [...(columns.get(rank) || []), unit]);
            });
        }
        let x = left;
        for (const [, column] of [...columns.entries()].sort(([a], [b]) => a - b)) {
            let y = top;
            column.forEach((unit) => { positions.set(unit.id, { x, y }); y += unit.height + 80; });
            x += Math.max(...column.map((unit) => unit.width)) + 120;
        }
    } else if (mode === "distributeX" || mode === "distributeY") {
        const horizontal = mode === "distributeX";
        const sorted = [...units].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
        const totalSize = sorted.reduce((sum, unit) => sum + (horizontal ? unit.width : unit.height), 0);
        const gap = Math.max(0, ((horizontal ? right - left : bottom - top) - totalSize) / (units.length - 1));
        let cursor = horizontal ? left : top;
        sorted.forEach((unit) => {
            positions.set(unit.id, horizontal ? { x: cursor, y: unit.y } : { x: unit.x, y: cursor });
            cursor += (horizontal ? unit.width : unit.height) + gap;
        });
    } else {
        units.forEach((unit) => positions.set(unit.id, {
            x: mode === "left" ? left : mode === "right" ? right - unit.width : mode === "centerX" ? (left + right - unit.width) / 2 : unit.x,
            y: mode === "top" ? top : mode === "bottom" ? bottom - unit.height : mode === "centerY" ? (top + bottom - unit.height) / 2 : unit.y,
        }));
    }
    const deltas = new Map<string, CanvasPoint>();
    units.forEach((unit) => {
        const position = positions.get(unit.id)!;
        unit.members.forEach((id) => deltas.set(id, { x: position.x - unit.x, y: position.y - unit.y }));
    });
    let changed = false;
    const result = nodes.map((node) => {
        const delta = deltas.get(node.id);
        if (!delta || (!delta.x && !delta.y)) return node;
        changed = true;
        return { ...node, frame: { ...node.frame, position: { x: node.frame.position.x + delta.x, y: node.frame.position.y + delta.y } } };
    });
    return changed ? expandBackgroundBoardsToMembers(result) : nodes;
}
