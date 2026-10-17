import type { CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import type { ReferenceImage } from "@/features/generation/types/image";

/** A take is tied to its script, staging, identities and current reference image. */
export function dramaShotVideoSignature(shot: CanvasStoryboardShot, board?: CanvasStoryboardNode): string {
    const value = JSON.stringify([shot.visualDescription, shot.videoPrompt ?? shot.finalPrompt, shot.durationSeconds,
        shot.shotSize, shot.cameraMovement, shot.lightingAtmosphere, shot.dialogueVoiceover, shot.soundEffect,
        shot.continuity, shot.assetIds, shot.image?.storageKey || shot.image?.source, board?.content.visualStyle,
        board?.storyboard.assets.filter(asset => shot.assetIds.includes(asset.id)).map(asset => [asset.id, asset.kind, asset.name, asset.description, asset.image?.storageKey || asset.image?.source]),
        ...(shot.videoPromptContextMode === "self-contained" ? ["video-prompt-context:self-contained"] : [])]);
    let hash = BigInt("14695981039346656037");
    for (let i = 0; i < value.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * BigInt("1099511628211"));
    return hash.toString(16);
}

export function previousContinuousShot(shots: CanvasStoryboardShot[], shotId: string): CanvasStoryboardShot | undefined {
    const ordered = [...shots].sort((a, b) => a.shotNumber - b.shotNumber);
    const index = ordered.findIndex(shot => shot.id === shotId);
    const shot = ordered[index];
    if (shot?.continuity?.transition !== "continue") return undefined;
    const previous = ordered[index - 1];
    if (!previous || !shot.continuity.sceneId.trim() || !shot.continuity.time.trim()
        || previous.continuity?.sceneId !== shot.continuity.sceneId || previous.continuity.time !== shot.continuity.time) {
        throw new Error(`镜头 ${shot.shotNumber} 的连续动作缺少同一时空的前镜，请先优化分镜或改为明确转场`);
    }
    return previous;
}

export type DramaVideoShotSnapshot = {
    boardId: string;
    shotId: string;
    signature: string;
    previousVideoStorageKey?: string;
};

/** Check only the stored direct dependency; the whole-story report visits every shot. */
export function readDramaVideoDependencyIssue(board: CanvasStoryboardNode, shot: CanvasStoryboardShot): string | null {
    const expected = shot.video?.previousVideoStorageKey;
    if (!expected) return null;
    let previous: CanvasStoryboardShot | undefined;
    try { previous = previousContinuousShot(board.storyboard.shots, shot.id); }
    catch { return `镜头 ${shot.shotNumber} 原来衔接的前镜或时空已改变，请重新生成本镜`; }
    if (!previous?.video?.source || previous.video.storageKey !== expected) {
        return `镜头 ${shot.shotNumber} 衔接的前镜视频已替换或移除，请重新生成本镜以使用最新尾帧`;
    }
    return null;
}

/** Capture immediately before submission, after earlier shots in this scene have completed. */
export function captureDramaVideoShot(board: CanvasStoryboardNode, shotId: string): DramaVideoShotSnapshot {
    const shot = board.storyboard.shots.find(item => item.id === shotId);
    if (!shot) throw new Error("分镜已被替换，请从当前分镜重新生成视频");
    const previous = previousContinuousShot(board.storyboard.shots, shotId);
    if (previous) {
        if (!previous.video?.source || !previous.video.storageKey) throw new Error(`请先完成镜头 ${previous.shotNumber} 并保存视频，后续镜头需要它的尾帧衔接`);
        if (previous.video.sourceSignature && previous.video.sourceSignature !== dramaShotVideoSignature(previous, board)) {
            throw new Error(`镜头 ${previous.shotNumber} 的剧情或参考图已修改，请先重新生成前镜`);
        }
        const dependencyIssue = readDramaVideoDependencyIssue(board, previous);
        if (dependencyIssue) throw new Error(dependencyIssue);
    }
    return { boardId: board.id, shotId, signature: dramaShotVideoSignature(shot, board),
        ...(previous?.video?.storageKey ? { previousVideoStorageKey: previous.video.storageKey } : {}) };
}

/** A late result must not overwrite an edited shot or a take based on a replaced predecessor. */
export function assertDramaVideoShotUnchanged(snapshot: DramaVideoShotSnapshot, board: CanvasStoryboardNode | undefined): void {
    if (!board || board.id !== snapshot.boardId) throw new Error("生成期间所属分镜已删除或替换，结果未写回当前分镜");
    const latest = captureDramaVideoShot(board, snapshot.shotId);
    if (latest.signature !== snapshot.signature) throw new Error("生成期间分镜或参考素材已修改，旧任务结果未写回，请按最新分镜重新生成");
    if (latest.previousVideoStorageKey !== snapshot.previousVideoStorageKey) {
        throw new Error("生成期间前镜视频已替换，旧任务使用的尾帧已失效，请重新生成本镜");
    }
}

export async function prepareDramaVideoReferences(
    board: CanvasStoryboardNode, shotId: string, references: ReferenceImage[], settings: { model: string; size: string },
    extractTail: (storageKey: string) => Promise<{ coverUrl: string; coverStorageKey: string }>,
): Promise<ReferenceImage[]> {
    captureDramaVideoShot(board, shotId);
    const previous = previousContinuousShot(board.storyboard.shots, shotId);
    if (!previous) return references;
    const video = previous.video;
    if (!video?.storageKey || !video.source) throw new Error(`请先完成镜头 ${previous.shotNumber} 并保存视频，后续镜头需要它的尾帧衔接`);
    if (video.sourceSignature && video.sourceSignature !== dramaShotVideoSignature(previous, board)) {
        throw new Error(`镜头 ${previous.shotNumber} 的剧情或参考图已修改，请先重新生成前镜`);
    }
    if (video.model && video.model !== settings.model) throw new Error(`连续场景的视频模型不一致，请沿用前镜模型或重新生成整个场景`);
    if (video.size && video.size !== settings.size) throw new Error(`连续场景的画幅不一致，请沿用前镜画幅或重新生成整个场景`);
    const tail = await extractTail(video.storageKey);
    if (!tail.coverUrl || !tail.coverStorageKey) throw new Error("前镜尾帧提取失败，请重试；本镜尚未提交生成");
    // A single true starting frame also works with models that accept only one image.
    return [{ id: `tail:${previous.id}`, name: `镜头 ${previous.shotNumber} 实际尾帧（本镜起始画面）`, type: "image/jpeg",
        dataUrl: tail.coverUrl, url: tail.coverUrl, storageKey: tail.coverStorageKey }];
}

/** Independent scenes run concurrently; each continuous action waits for its predecessor. */
export async function runDramaVideoSequence<T extends { shot: CanvasStoryboardShot }>(
    items: T[], run: (item: T) => Promise<boolean>, blocked: (item: T, message: string) => void,
): Promise<boolean[]> {
    const ordered = [...items].sort((a, b) => a.shot.shotNumber - b.shot.shotNumber);
    const groups: T[][] = [];
    for (const item of ordered) {
        const group = groups.at(-1);
        const previous = group?.at(-1)?.shot;
        const link = item.shot.continuity;
        if (group && previous && link?.transition === "continue" && link.sceneId === previous.continuity?.sceneId && link.time === previous.continuity.time) group.push(item);
        else groups.push([item]);
    }
    const result = new Map<T, boolean>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(5, groups.length) }, async () => {
        while (next < groups.length) {
            const group = groups[next++];
            let successful = true;
            for (const item of group) {
                if (!successful) {
                    blocked(item, "前镜生成失败，本镜已暂停；修复前镜后可重试衔接");
                    result.set(item, false);
                    continue;
                }
                try { successful = await run(item); }
                catch (error) { successful = false; blocked(item, error instanceof Error ? error.message : "视频生成失败"); }
                result.set(item, successful);
            }
        }
    }));
    return items.map(item => result.get(item) === true);
}
