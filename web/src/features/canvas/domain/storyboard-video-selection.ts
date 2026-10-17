import type { CanvasStoryboardShot } from "../types";

/** An explicit selection is a fixed scope; an omitted selection opens the whole storyboard. */
export function readStoryboardVideoSelection(shots: CanvasStoryboardShot[], requestedShotIds?: readonly string[]) {
    const requestedIds = requestedShotIds === undefined ? undefined : new Set(requestedShotIds);
    const seenIds = new Set<string>();
    const scopedShots = shots.filter((shot) => {
        if ((requestedIds && !requestedIds.has(shot.id)) || seenIds.has(shot.id)) return false;
        seenIds.add(shot.id);
        return true;
    });
    const selectedShotIds = scopedShots.filter((shot) =>
        (requestedIds !== undefined || !shot.video?.source)
        && Boolean((shot.videoPrompt ?? shot.finalPrompt).trim())
        && Number.isSafeInteger(shot.durationSeconds)
        && shot.durationSeconds > 0,
    ).map((shot) => shot.id);
    return { shots: scopedShots, selectedShotIds };
}
