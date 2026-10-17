import type { CanvasDocument, CanvasNode } from "../types";

export type CanvasProjectCover = { kind: "image" | "video"; url: string; storageKey?: string };

/** Prefer durable media URLs; persisted blob URLs belong to a different page session. */
function mediaUrl(...values: Array<string | undefined>): string {
    return values.find(value => value && /^(https?:\/\/|data:image\/|\/(?!\/))/i.test(value)) || "";
}

/** Finished film → opening frame → storyboard → other project images/video. */
export function canvasProjectCovers(document: CanvasDocument): CanvasProjectCover[] {
    const { nodes, connections } = document.scene;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const candidates: CanvasProjectCover[] = [];
    const addImage = (url?: string) => { const usable = mediaUrl(url); if (usable) candidates.push({ kind: "image", url: usable }); };
    const addNode = (node?: CanvasNode) => {
        if (node?.kind !== "image" && node?.kind !== "video") return;
        const url = mediaUrl(node.content.objectStorage?.url, node.content.source);
        if (url) candidates.push({ kind: node.kind, url, storageKey: node.content.storageKey });
    };
    addImage(document.preferences.drama?.cover);
    nodes.filter(node => node.kind === "videoComposition").forEach(node => {
        const result = byId.get(node.composition.resultVideoNodeId || "");
        if (result?.execution.phase === "succeeded") addNode(result);
    });
    const sessions = [...document.conversation.sessions].sort((a, b) =>
        Number(b.id === document.conversation.activeSessionId) - Number(a.id === document.conversation.activeSessionId));
    sessions.forEach(session => session.infiniteAgent?.film?.workflow?.shots.forEach(shot => addNode(byId.get(shot.imageNodeId))));
    nodes.forEach(node => {
        if (node.kind !== "storyboard") return;
        node.storyboard.shots.forEach(shot => {
            addImage(shot.video?.poster);
            addImage(mediaUrl(shot.image?.objectStorage?.url, shot.image?.source));
        });
    });
    connections.forEach(edge => { if (byId.get(edge.target.nodeId)?.kind === "video") addNode(byId.get(edge.source.nodeId)); });
    nodes.filter(node => node.kind === "image").forEach(addNode);
    nodes.filter(node => node.kind === "video").forEach(addNode);
    const seen = new Set<string>();
    return candidates.filter(cover => { if (seen.has(cover.url)) return false; seen.add(cover.url); return true; });
}

export function canvasProjectMediaSummary(document: CanvasDocument) {
    const imageUrls = new Set<string>(), videoUrls = new Set<string>();
    for (const node of document.scene.nodes) {
        if (node.kind === "image" || node.kind === "video") {
            const url = mediaUrl(node.content.objectStorage?.url, node.content.source);
            if (url) (node.kind === "image" ? imageUrls : videoUrls).add(url);
        }
        if (node.kind === "storyboard") node.storyboard.shots.forEach(shot => {
            const image = mediaUrl(shot.image?.objectStorage?.url, shot.image?.source);
            const video = mediaUrl(shot.video?.objectStorage?.url, shot.video?.source);
            if (image) imageUrls.add(image);
            if (video) videoUrls.add(video);
        });
    }
    const completed = document.scene.nodes.some(node => node.kind === "videoComposition" &&
        document.scene.nodes.some(result => result.id === node.composition.resultVideoNodeId && result.kind === "video" && result.execution.phase === "succeeded" && (result.content.source || result.content.objectStorage?.url)));
    const images = imageUrls.size, videos = videoUrls.size;
    const videoProject = document.scene.nodes.some(node => ["video", "videoComposition", "storyboard"].includes(node.kind));
    return { images, videos, label: completed ? "已成片" : videoProject ? "视频创作" : images ? "图像创作" : document.scene.nodes.length ? "创作中" : "新项目" };
}
