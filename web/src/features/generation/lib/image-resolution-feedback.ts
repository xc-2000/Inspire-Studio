/** Compare the file's pixel dimensions with this round's requested output size. */
export function imageResolutionWarning(width: number | undefined, height: number | undefined, resolution?: string, size?: string): string {
    if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
    const normalizedSize = size?.trim().toLowerCase() || "";
    if (!normalizedSize || normalizedSize === "auto") return "";
    const pixels = /^(\d+)x(\d+)$/.exec(normalizedSize);
    let targetWidth: number;
    let targetHeight: number;
    let label: string;
    if (pixels) {
        targetWidth = Number(pixels[1]);
        targetHeight = Number(pixels[2]);
        label = `${targetWidth}×${targetHeight}`;
    } else {
        const longSide = { "1K": 1024, "2K": 2048, "4K": 4096 }[resolution?.toUpperCase() || ""];
        const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(normalizedSize);
        if (!longSide || !ratio) return "";
        const w = Number(ratio[1]), h = Number(ratio[2]);
        if (w <= 0 || h <= 0) return "";
        const shortSide = Math.max(16, Math.round(longSide / (w >= h ? w / h : h / w) / 16) * 16);
        [targetWidth, targetHeight] = w >= h ? [longSide, shortSide] : [shortSide, longSide];
        label = resolution!.toUpperCase();
    }
    if (targetWidth <= 0 || targetHeight <= 0) return "";
    // Allow the small alignment adjustments used by image providers.
    if (Math.abs(width - targetWidth) <= 16 && Math.abs(height - targetHeight) <= 16) return "";
    return `已请求 ${label}（${targetWidth}×${targetHeight}），实际返回 ${width}×${height}。当前模型未按所选尺寸输出。`;
}
