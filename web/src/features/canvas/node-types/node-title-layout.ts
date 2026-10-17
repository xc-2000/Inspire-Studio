/** Keep node captions within their screen footprint while retaining a usable selected/editing target. */
export function canvasNodeTitleLayout(nodeWidth: number, zoom: number, selected: boolean, editing = false) {
    const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const screenWidth = Math.max(0, Number.isFinite(nodeWidth) ? nodeWidth : 0) * safeZoom;
    return {
        visible: editing || selected || screenWidth >= 64,
        width: editing ? 280 : Math.min(240, Math.max(selected ? 64 : 1, screenWidth)),
        fontSize: 10 + 2 * Math.min(1, safeZoom),
        paddingInline: safeZoom < 0.65 ? 6 : 8,
        // The title and its editor stay below the hover toolbar, whose bottom is 42px above the node.
        offset: editing ? 8 : Math.max(2, Math.min(8, 8 * safeZoom)),
    };
}
