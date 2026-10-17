import type { CanvasStoryboardAsset, CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";

export type DramaStoryRevision = {
    id: string;
    createdAt: string;
    sourceSignature: string;
    instruction: string;
    visualStyle: string;
    shots: CanvasStoryboardShot[];
    assets: CanvasStoryboardAsset[];
};

export class DramaStoryRevisionError extends Error {
    readonly code: "stale-draft" | "invalid-draft";
    constructor(code: "stale-draft" | "invalid-draft", message: string) { super(message); this.code = code; this.name = "DramaStoryRevisionError"; }
}

const canonicalName = (asset: Pick<CanvasStoryboardAsset, "kind" | "name">) => `${asset.kind}:${asset.name.normalize("NFKC").trim().replace(/\s+/g, "").toLocaleLowerCase()}`;
const clone = <T,>(value: T): T => structuredClone(value);

/** Includes active media and asset edits: a completed task must not be overwritten by an older draft. */
export function createDramaStorySourceSignature(board: CanvasStoryboardNode, scriptContent: string, projectAssets: CanvasStoryboardAsset[] = []): string {
    const serialized = JSON.stringify({ id: board.id, content: board.content, scriptContent, storyboard: board.storyboard,
        projectAssets: [...projectAssets].sort((a, b) => a.id.localeCompare(b.id)) });
    // Keep stored revision metadata bounded, rather than recursively embedding old signatures.
    let left = 2166136261, right = 2246822519;
    for (let index = 0; index < serialized.length; index++) {
        left = Math.imul(left ^ serialized.charCodeAt(index), 16777619);
        right = Math.imul(right ^ serialized.charCodeAt(index), 3266489917);
    }
    return `story:${serialized.length}:${(left >>> 0).toString(16)}:${(right >>> 0).toString(16)}`;
}

export function buildRevisedDramaShotPrompts(shot: CanvasStoryboardShot, visualStyle = ""): Pick<CanvasStoryboardShot, "finalPrompt" | "imagePrompt" | "videoPrompt"> {
    const c = shot.continuity;
    const visual = [shot.visualDescription.trim(), shot.shotSize && `景别：${shot.shotSize}`, shot.lightingAtmosphere.trim() && `光线氛围：${shot.lightingAtmosphere.trim()}`, visualStyle.trim() && `视觉风格：${visualStyle.trim()}`].filter(Boolean);
    const imagePrompt = [...visual, c?.openingState?.trim() && `画面起始状态：${c.openingState.trim()}`].filter(Boolean).join("\n");
    const transitionLabels = { establish: "建立场景", continue: "承接前镜连续动作", cut: "切换场景", "time-jump": "时间跳转", flashback: "进入回忆", return: "回到当前时间" };
    const videoPrompt = [...visual, `时长：${shot.durationSeconds}秒`,
        c?.sceneId?.trim() && `场景：${c.sceneId.trim()}`, c?.time?.trim() && `时间：${c.time.trim()}`,
        c?.transition && `转场：${transitionLabels[c.transition] || c.transition}`,
        c?.openingState?.trim() && `起始状态：${c.openingState.trim()}`, c?.closingState?.trim() && `结束状态：${c.closingState.trim()}`,
        c?.storyBeat?.trim() && `情节作用：${c.storyBeat.trim()}`,
        shot.cameraMovement.trim() && `镜头运动：${shot.cameraMovement.trim()}`,
        shot.dialogueVoiceover.trim() && `台词/旁白：${shot.dialogueVoiceover.trim()}`,
        shot.soundEffect.trim() && `声音：${shot.soundEffect.trim()}`,
    ].filter(Boolean).join("\n");
    return { finalPrompt: videoPrompt, imagePrompt, videoPrompt };
}

/** Apply a reviewed plan atomically. Fresh shot IDs keep old expanded nodes out of the new plan. */
export function applyDramaStoryRevision(input: {
    board: CanvasStoryboardNode;
    scriptContent: string;
    projectAssets?: CanvasStoryboardAsset[];
    expectedSourceSignature: string;
    generated: { shots: CanvasStoryboardShot[]; assets: CanvasStoryboardAsset[] };
    revisionId?: string;
    now?: string;
}): { board: CanvasStoryboardNode; assets: CanvasStoryboardAsset[]; revision: DramaStoryRevision; retiredShotIds: string[] } {
    const { board, scriptContent, expectedSourceSignature, generated } = input;
    const projectAssets = input.projectAssets || [];
    if (createDramaStorySourceSignature(board, scriptContent, projectAssets) !== expectedSourceSignature) {
        throw new DramaStoryRevisionError("stale-draft", "剧本、分镜或素材已经发生变化，请重新生成优化草稿后再应用。");
    }
    if (!generated.shots.length || generated.shots.some(shot => !shot.visualDescription?.trim() || !Number.isFinite(shot.durationSeconds) || shot.durationSeconds <= 0)) {
        throw new DramaStoryRevisionError("invalid-draft", "优化结果缺少有效镜头或时长，原分镜已保留。");
    }
    const revisionId = input.revisionId || crypto.randomUUID();
    const now = input.now || new Date().toISOString();
    const revision: DramaStoryRevision = { id: revisionId, createdAt: now, sourceSignature: expectedSourceSignature,
        instruction: board.content.instruction, visualStyle: board.content.visualStyle,
        shots: clone(board.storyboard.shots), assets: clone(board.storyboard.assets) };
    const pool = new Map(projectAssets.map(asset => [asset.id, clone(asset)]));
    board.storyboard.assets.forEach(asset => pool.set(asset.id, clone(asset)));
    const named = new Map<string, CanvasStoryboardAsset>();
    const chapterNames = new Set(board.storyboard.assets.map(canonicalName));
    // A chapter variant is an intentional identity choice, even before its image is generated.
    [...board.storyboard.assets, ...projectAssets].forEach(asset => {
        const key = canonicalName(asset), existing = named.get(key);
        if (!existing || (!chapterNames.has(key) && !existing.image?.source && asset.image?.source)) named.set(key, pool.get(asset.id)!);
    });
    const idMap = new Map<string, string>();
    const generatedIds = new Set<string>();
    generated.assets.forEach((asset, index) => {
        if (!asset.id || !asset.name.trim() || generatedIds.has(asset.id)) throw new DramaStoryRevisionError("invalid-draft", "优化结果中的资产标识重复或名称为空，原分镜已保留。");
        generatedIds.add(asset.id);
        // The planner preserves existing reference IDs. Do not collapse explicitly selected
        // same-name variants into another chapter's canonical identity during the merge.
        const existingById = pool.get(asset.id);
        const matched = existingById && canonicalName(existingById) === canonicalName(asset)
            ? existingById : named.get(canonicalName(asset));
        if (matched) { idMap.set(asset.id, matched.id); return; }
        const id = pool.has(asset.id) ? `revision:${revisionId}:asset:${index + 1}` : asset.id;
        const created = { ...clone(asset), id };
        // Generated plans describe assets; they must not inject stale output media.
        delete created.image;
        pool.set(id, created); named.set(canonicalName(created), created); idMap.set(asset.id, id);
    });
    const shots = [...generated.shots].sort((a, b) => a.shotNumber - b.shotNumber).map((source, index) => {
        const shot = clone(source);
        shot.id = `revision:${revisionId}:shot:${index + 1}`;
        shot.shotNumber = index + 1;
        shot.assetIds = [...new Set(shot.assetIds.map(id => idMap.get(id) || id))];
        if (shot.assetIds.some(id => !pool.has(id))) throw new DramaStoryRevisionError("invalid-draft", "优化结果引用了不存在的资产，原分镜已保留。");
        shot.assetReferenceVersion = 1;
        delete shot.image; delete shot.video;
        return { ...shot, ...buildRevisedDramaShotPrompts(shot, board.content.visualStyle) };
    });
    const usedAssets = new Set([...board.storyboard.assets.map(asset => asset.id), ...shots.flatMap(shot => shot.assetIds)]);
    const assets = [...pool.values()];
    const { assetGeneration: _assetGeneration, shotImageGeneration: _shotImageGeneration, projectAssetIds: _projectAssetIds, ...storyboard } = board.storyboard;
    const nextBoard: CanvasStoryboardNode = { ...clone(board), storyboard: { ...storyboard, shots,
        assets: assets.filter(asset => usedAssets.has(asset.id)), revisions: [revision, ...(board.storyboard.revisions || [])].slice(0, 5) } };
    return { board: nextBoard, assets, revision, retiredShotIds: board.storyboard.shots.map(shot => shot.id) };
}
