import { applyCanvasNodeAttributes, type CanvasNodeAttributes } from "./canvas-node.ts";
import type { CanvasNode } from "../types.ts";

/** Archiving or resolving stored media changes its location, never the generation outcome. */
export function restoreCanvasNodeMedia<Node extends CanvasNode>(node: Node, attributes: CanvasNodeAttributes): Node {
    const mediaAttributes = { ...attributes, status: undefined, taskId: undefined, errorDetails: undefined,
        progress: undefined, startedAt: undefined, completedAt: undefined };
    return { ...applyCanvasNodeAttributes(node, mediaAttributes), execution: node.execution } as Node;
}
