import type { CanvasDocument } from "../types";
import { canvasProjectCovers, canvasProjectMediaSummary, type CanvasProjectCover } from "./canvas-project-cover";

export type CanvasProjectSummary = {
    identity: CanvasDocument["identity"];
    nodeCount: number;
    connectionCount: number;
    media: ReturnType<typeof canvasProjectMediaSummary>;
    covers: CanvasProjectCover[];
};

export function summarizeCanvasProject(document: CanvasDocument): CanvasProjectSummary {
    const covers = canvasProjectCovers(document).filter(cover => cover.url.length <= 2048 && !cover.url.startsWith("data:"));
    return {
        identity: document.identity,
        nodeCount: document.scene.nodes.length,
        connectionCount: document.scene.connections.length,
        media: canvasProjectMediaSummary(document),
        // Library thumbnails should not download videos when an image is available.
        covers: [...covers.filter(c => c.kind === "image"), ...covers.filter(c => c.kind === "video")].slice(0, 3),
    };
}
