import type { CanvasNodeFrame, CanvasViewTransform } from "../types";

/** Use the rendered width for both sizing and clamping, including narrow canvases. */
export function canvasPromptPanelLayout({ canvasWidth, canvasHeight, frame, viewport, panelHeight, preferredWidth = 580, gap = 16, bottomInset = 88 }: {
    canvasWidth: number; canvasHeight: number; frame: CanvasNodeFrame; viewport: CanvasViewTransform;
    panelHeight: number; preferredWidth?: number; gap?: number; bottomInset?: number;
}) {
    const margin = Math.min(gap, Math.max(0, canvasWidth) / 2);
    const width = Math.max(0, Math.min(preferredWidth, canvasWidth - margin * 2));
    const anchorLeft = viewport.x + (frame.position.x + frame.width / 2) * viewport.k - width / 2;
    const anchorTop = viewport.y + (frame.position.y + frame.height) * viewport.k + gap;
    return {
        width,
        left: Math.max(margin, Math.min(canvasWidth - width - margin, anchorLeft)),
        top: Math.max(gap, Math.min(canvasHeight - panelHeight - bottomInset, anchorTop)),
    };
}
