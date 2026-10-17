export type CanvasImageRefinementMode = "mask" | "outpaint" | "light" | "angle";

/** Scale the full output once, then fit the source inside it without zero-size axes. */
export function canvasImageRefinementGeometry(
    naturalWidth: number,
    naturalHeight: number,
    mode: CanvasImageRefinementMode,
    padding: number,
    maxSide = 2048,
) {
    if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) {
        throw new Error("原图尺寸无效");
    }
    if (!Number.isFinite(padding) || padding < 0 || !Number.isInteger(maxSide) || maxSide < 1) {
        throw new Error("图片编辑尺寸无效");
    }
    const factor = mode === "outpaint" ? 1 + padding / 50 : 1;
    const scale = Math.min(1, maxSide / Math.max(naturalWidth * factor, naturalHeight * factor));
    const dimension = (value: number, maximum: number) => Math.min(maximum, Math.max(1, Math.round(value)));
    const width = dimension(naturalWidth * factor * scale, maxSide);
    const height = dimension(naturalHeight * factor * scale, maxSide);
    const sourceWidth = dimension(naturalWidth * scale, width);
    const sourceHeight = dimension(naturalHeight * scale, height);
    return {
        width,
        height,
        sourceWidth,
        sourceHeight,
        sourceX: Math.round((width - sourceWidth) / 2),
        sourceY: Math.round((height - sourceHeight) / 2),
    };
}

/** One shared preview box keeps the source and painting layer at the same aspect ratio. */
export function canvasImageRefinementPreviewWidth(width: number, height: number, maxHeight = 384) {
    return Math.min(width, (width / height) * maxHeight);
}
