import type { CanvasDocument, CanvasNode, CanvasStoryboardShotVideo } from "@/features/canvas/types";
import type { ObjectStorageFile } from "@/shared/types/object-storage";
import { readDramaContinuityReport } from "./drama-continuity";
import type { DramaVideoSelection } from "./drama-chapter-assembly";

export interface StoredDramaVideoMedia {
    url: string;
    storageKey: string;
    mimeType?: string;
    objectStorage?: ObjectStorageFile;
}

export interface DramaVideoPreparationOptions {
    selection?: DramaVideoSelection;
    signal?: AbortSignal;
    store: (source: string) => Promise<StoredDramaVideoMedia>;
    onVideo: (boardId: string, shotId: string, originalSource: string, media: CanvasStoryboardShotVideo) => Promise<void>;
}

/** Persist composition inputs one at a time; each successful write survives a later interruption. */
export async function prepareDramaVideoMedia(document: CanvasDocument, nodes: CanvasNode[], options: DramaVideoPreparationOptions): Promise<void> {
    options.signal?.throwIfAborted();
    const report = readDramaContinuityReport(document, nodes);
    if (!options.selection && !report.canPreview) {
        const issue = report.issues.find(issue => issue.severity === "error");
        throw new Error(`无法准备完整短剧：${issue?.message || "尚无可用镜头"}`);
    }
    const selection = options.selection;
    const selected = selection ? report.orderedShots.filter(item => item.chapter.id === selection.chapterId && selection.shotIds.includes(item.shot.id)) : report.orderedShots;
    if (selection && (!selected.length || new Set(selection.shotIds).size !== selection.shotIds.length || selected.length !== selection.shotIds.length || selected.some(item => !item.shot.video?.source.trim()))) throw new Error("所选镜头已变化或缺少视频，请重新合成");
    const storedBySource = new Map<string, StoredDramaVideoMedia>();
    for (const { chapter, board, shot } of selected) {
        options.signal?.throwIfAborted();
        const video = shot.video!;
        if (video.storageKey?.trim()) continue;
        const originalSource = video.source;
        const source = originalSource.trim();
        let stored = storedBySource.get(source);
        if (!stored) {
            try {
                options.signal?.throwIfAborted();
                stored = await options.store(source);
                if (!stored.url?.trim() || !stored.storageKey?.trim()) throw new Error("存储服务未返回视频地址或存储标识");
                storedBySource.set(source, stored);
            } catch (error) {
                if (error instanceof Error && error.name === "AbortError") throw error;
                options.signal?.throwIfAborted();
                throw new Error(`${chapter.title} · 镜头 ${shot.shotNumber} 视频保存失败：${error instanceof Error ? error.message : "请稍后重试"}`);
            }
        }
        const media: CanvasStoryboardShotVideo = {
            ...video,
            source: stored.url,
            storageKey: stored.storageKey,
            mimeType: stored.mimeType || video.mimeType,
            // Never associate an old provider URL's storage metadata with the new file.
            objectStorage: stored.objectStorage,
        };
        try {
            options.signal?.throwIfAborted();
            await options.onVideo(board.id, shot.id, originalSource, media);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            options.signal?.throwIfAborted();
            throw new Error(`${chapter.title} · 镜头 ${shot.shotNumber} 记录保存失败：${error instanceof Error ? error.message : "请稍后重试"}`);
        }
    }
    options.signal?.throwIfAborted();
}
