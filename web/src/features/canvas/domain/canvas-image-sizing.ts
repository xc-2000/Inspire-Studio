import type { CanvasImageNode } from "../types";

const ASPECT_RATIO_EPSILON = 0.000001;

/** Fit legacy frames once; retain display scale when a replacement changes aspect ratio. */
export function fitCanvasImageToSource(node: CanvasImageNode, source: string, naturalWidth: number, naturalHeight: number): CanvasImageNode {
    if (!source || node.content.source !== source || node.grouping.isRoot || !isPositiveDimension(naturalWidth) || !isPositiveDimension(naturalHeight)) return node;

    const frame = node.frame;
    const naturalChanged = frame.naturalWidth !== naturalWidth || frame.naturalHeight !== naturalHeight;
    const sourceRatio = naturalWidth / naturalHeight;
    const frameRatio = frame.width / frame.height;
    const canFit = !frame.freeResize && isPositiveDimension(frame.width) && isPositiveDimension(frame.height);
    const sameRatio = sameAspectRatio(sourceRatio, frameRatio);
    if (!canFit || sameRatio) {
        return naturalChanged ? { ...node, frame: { ...frame, naturalWidth, naturalHeight } } : node;
    }

    const previousRatio = isPositiveDimension(frame.naturalWidth) && isPositiveDimension(frame.naturalHeight) ? frame.naturalWidth / frame.naturalHeight : null;
    const sourceRatioChanged = previousRatio !== null && !sameAspectRatio(sourceRatio, previousRatio);
    const longEdge = Math.max(frame.width, frame.height);
    const width = sourceRatioChanged ? (sourceRatio >= 1 ? longEdge : longEdge * sourceRatio) : sourceRatio >= frameRatio ? frame.width : frame.height * sourceRatio;
    const height = sourceRatioChanged ? (sourceRatio >= 1 ? longEdge / sourceRatio : longEdge) : sourceRatio >= frameRatio ? frame.width / sourceRatio : frame.height;
    return { ...node, frame: { ...frame, width, height, naturalWidth, naturalHeight,
        position: { x: frame.position.x + (frame.width - width) / 2, y: frame.position.y + (frame.height - height) / 2 },
    } };
}

function isPositiveDimension(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sameAspectRatio(first: number, second: number) {
    return Math.abs(first - second) <= Math.max(first, second) * ASPECT_RATIO_EPSILON;
}
