import type { CanvasStoryboardAsset, CanvasStoryboardShot } from "@/features/canvas/types";

/** Recover absent source objectIds using exact known names, never guessed pronouns or aliases. */
export function repairDramaShotAssetReferences(shot: CanvasStoryboardShot, assets: CanvasStoryboardAsset[]): CanvasStoryboardShot {
    if (shot.assetReferenceVersion === 1) return shot;
    if (shot.assetIds.length) return { ...shot, assetReferenceVersion: 1 };
    const byName = new Map<string, CanvasStoryboardAsset[]>();
    for (const asset of assets) {
        const name = asset.name.trim();
        if (!name) continue;
        const matches = byName.get(name) || [];
        if (!matches.some(item => item.id === asset.id)) matches.push(asset);
        byName.set(name, matches);
    }
    // imagePrompt is authoritative when present, including an intentional blank.
    const prompt = shot.imagePrompt ?? (shot.finalPrompt || shot.visualDescription);
    const found: Array<{ id: string; index: number; length: number }> = [];
    const markedRanges: Array<{ start: number; end: number }> = [];
    for (const match of prompt.matchAll(/@\[([^\]\r\n]+)\]/g)) {
        markedRanges.push({ start: match.index, end: match.index + match[0].length });
        const matches = byName.get(match[1].trim());
        if (matches?.length === 1) found.push({ id: matches[0].id, index: match.index, length: match[0].length });
    }
    for (const [name, matches] of byName) {
        if (matches.length !== 1 || name.length < 2) continue;
        let start = 0;
        while (start < prompt.length) {
            const index = prompt.indexOf(name, start);
            if (index < 0) break;
            start = index + name.length;
            if (markedRanges.some(range => index >= range.start && index < range.end)) continue;
            // Do not select a shorter known name embedded inside another known name.
            if ([...byName.keys()].some(other => other.length > name.length && other.includes(name) &&
                prompt.slice(Math.max(0, index - other.length + name.length), index + other.length).includes(other))) continue;
            // Latin IDs/names need token boundaries; Chinese prose has no word separators.
            if (/^[\w -]+$/.test(name) && (/[\w]/.test(prompt[index - 1] || "") || /[\w]/.test(prompt[index + name.length] || ""))) continue;
            found.push({ id: matches[0].id, index, length: name.length });
        }
    }
    found.sort((a, b) => a.index - b.index || b.length - a.length);
    return { ...shot, assetIds: [...new Set(found.map(item => item.id))], assetReferenceVersion: 1 };
}
