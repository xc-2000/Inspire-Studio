import type { CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { readDramaStoryQuality } from "./drama-story-quality";
import { captureDramaVideoShot, previousContinuousShot } from "./drama-video-continuity";

export type DramaVideoPreflightIssue = {
    shotId: string;
    message: string;
    prerequisiteShotIds: string[];
};

export type DramaVideoPreflight = {
    issues: DramaVideoPreflightIssue[];
    prerequisiteShotIds: string[];
};

type Settings = { model: string; size: string };

/** Reuse compatible boundary takes when opening a continuous-shot batch. */
export function readDramaVideoContinuationSettings(board: CanvasStoryboardNode, selectedShotIds: readonly string[]): { model?: string; size?: string } | undefined {
    const selected = new Set(selectedShotIds);
    const inferred: { model?: string; size?: string } = {};
    for (const shot of board.storyboard.shots) {
        if (!selected.has(shot.id)) continue;
        let current = shot;
        const visited = new Set<string>();
        while (!visited.has(current.id)) {
            visited.add(current.id);
            let previous: CanvasStoryboardShot | undefined;
            try { previous = previousContinuousShot(board.storyboard.shots, current.id); }
            catch { break; }
            if (!previous) break;
            let usable = false;
            if (!selected.has(previous.id)) {
                // The runtime snapshot checks the predecessor's saved media,
                // source signature and direct video dependency together.
                try { captureDramaVideoShot(board, current.id); usable = true; }
                catch { /* A missing or stale take must be regenerated first. */ }
            }
            if (usable) {
                for (const key of ["model", "size"] as const) {
                    const value = previous.video?.[key];
                    if (!value) continue;
                    if (inferred[key] && inferred[key] !== value) return undefined;
                    inferred[key] = value;
                }
                break;
            }
            current = previous;
        }
    }
    return inferred.model || inferred.size ? inferred : undefined;
}

/** Check the requested batch without changing its selection or starting media tasks. */
export function readDramaVideoPreflight(board: CanvasStoryboardNode, selectedShotIds: readonly string[], settings: Settings): DramaVideoPreflight {
    const ordered = [...board.storyboard.shots].sort((a, b) => a.shotNumber - b.shotNumber);
    const selected = new Set(selectedShotIds);
    const shotsById = new Map(ordered.map(shot => [shot.id, shot]));
    const qualityErrors = new Map<string, string>();
    for (const issue of readDramaStoryQuality(board.storyboard.shots)) {
        if (issue.severity === "error" && !qualityErrors.has(issue.shotId)) qualityErrors.set(issue.shotId, issue.message);
    }

    const structureIssue = (shot: CanvasStoryboardShot): string => {
        if (!shot.continuity) return `镜头 ${shot.shotNumber} 尚未规划时空和动作衔接，请先在短剧工作台使用「优化剧情分镜」`;
        const qualityError = qualityErrors.get(shot.id);
        if (qualityError) return qualityError;
        try { previousContinuousShot(board.storyboard.shots, shot.id); }
        catch (error) { return errorMessage(error); }
        return "";
    };

    // A selected predecessor will be replaced. Its old take cannot stand in for a
    // failed regeneration when checking a later shot in the same batch.
    const createWorkingBoard = (): CanvasStoryboardNode => ({
        ...board,
        storyboard: { ...board.storyboard, shots: board.storyboard.shots.map(shot => selected.has(shot.id) ? { ...shot, video: undefined } : shot) },
    });
    const working = createWorkingBoard();
    const issues: DramaVideoPreflightIssue[] = [];
    for (const shotId of selected) {
        if (!shotsById.has(shotId)) issues.push({ shotId, message: "所选镜头已发生变化，请重新选择", prerequisiteShotIds: [] });
    }
    for (const shot of ordered) {
        if (!selected.has(shot.id)) continue;
        const message = structureIssue(shot) || submissionIssue(working, shot.id, settings);
        if (!message) {
            predictCompletedShot(working, shot.id, settings);
            continue;
        }

        // Explore only this shot's direct predecessor chain. The caller can offer
        // these IDs explicitly; this function never adds them to the user's batch.
        const proposed = createWorkingBoard();
        const additions = new Set<string>();
        const completed = new Set<string>();
        const visiting = new Set<string>();
        const prepare = (shotId: string): boolean => {
            if (completed.has(shotId)) return true;
            const current = shotsById.get(shotId);
            if (!current || visiting.has(shotId) || structureIssue(current)) return false;
            visiting.add(shotId);
            const previous = previousContinuousShot(proposed.storyboard.shots, shotId);
            if (previous && (selected.has(previous.id) || submissionIssue(proposed, shotId, settings))) {
                if (!prepare(previous.id)) return false;
                if (!selected.has(previous.id)) additions.add(previous.id);
            }
            if (submissionIssue(proposed, shotId, settings)) return false;
            predictCompletedShot(proposed, shotId, settings);
            visiting.delete(shotId);
            completed.add(shotId);
            return true;
        };
        const prerequisiteShotIds = prepare(shot.id) ? ordered.filter(item => additions.has(item.id)).map(item => item.id) : [];
        issues.push({ shotId: shot.id, message, prerequisiteShotIds });
    }
    const prerequisites = new Set(issues.flatMap(issue => issue.prerequisiteShotIds));
    return { issues, prerequisiteShotIds: ordered.filter(shot => prerequisites.has(shot.id)).map(shot => shot.id) };
}

function submissionIssue(board: CanvasStoryboardNode, shotId: string, settings: Settings): string {
    try {
        captureDramaVideoShot(board, shotId);
        const previous = previousContinuousShot(board.storyboard.shots, shotId);
        if (previous?.video?.model && previous.video.model !== settings.model) return "连续场景的视频模型不一致，请沿用前镜模型或重新生成整个场景";
        if (previous?.video?.size && previous.video.size !== settings.size) return "连续场景的画幅不一致，请沿用前镜画幅或重新生成整个场景";
        return "";
    } catch (error) { return errorMessage(error); }
}

/** Model a successful earlier submission using the same snapshot as runtime. */
function predictCompletedShot(board: CanvasStoryboardNode, shotId: string, settings: Settings): void {
    const snapshot = captureDramaVideoShot(board, shotId);
    board.storyboard.shots = board.storyboard.shots.map(shot => shot.id === shotId ? {
        ...shot,
        video: { source: `preflight:${shotId}`, storageKey: `preflight:${shotId}`, model: settings.model, size: settings.size,
            sourceSignature: snapshot.signature, previousVideoStorageKey: snapshot.previousVideoStorageKey },
    } : shot);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "分镜视频暂不可生成，请检查镜头衔接";
}
