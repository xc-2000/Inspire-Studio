import type { CanvasDocument, CanvasDramaProject, CanvasNode, CanvasStoryboardAsset, CanvasStoryboardAssetImage, CanvasStoryboardNode, CanvasStoryboardShot, CanvasVideoGenerationSettings } from "@/features/canvas/types";
import type { ObjectStorageFile } from "@/shared/types/object-storage";
import type { OpenDramaProject } from "./types";
import { createImageNode, createTextNode, createVideoNode } from "@/features/canvas/constants";
import type { CanvasConnection } from "@/features/canvas/types";
import { repairDramaShotAssetReferences } from "./drama-asset-references";
import { dramaShotVideoSignature } from "./drama-video-continuity";
import { arrangeDramaChapterNodes } from "./drama-canvas-layout";

const isStoryboard = (node: CanvasNode): node is CanvasStoryboardNode => node.kind === "storyboard";
const fingerprint = (asset: CanvasStoryboardAsset) => JSON.stringify([asset.kind, asset.name, asset.description, asset.image || null]);

/** Accept only the supported marker with an explicit rewritten video prompt. */
function normalizeShotPromptContext(shot: CanvasStoryboardShot): CanvasStoryboardShot {
    if (shot.videoPromptContextMode === undefined || (shot.videoPromptContextMode === "self-contained" && typeof shot.videoPrompt === "string" && shot.videoPrompt.trim())) return shot;
    const { videoPromptContextMode: _invalidContextMode, ...rest } = shot;
    return rest;
}

/** The same source id with different content is a separate, editable variant. */
export function collectDramaAssets(nodes: CanvasNode[], base: CanvasStoryboardAsset[] = []): CanvasStoryboardAsset[] {
    const assets = new Map(base.map(asset => [asset.id, asset]));
    nodes.filter(isStoryboard).forEach(node => node.storyboard.assets.forEach(asset => assets.set(asset.id, asset)));
    return [...assets.values()];
}

export function isLegacyDramaDocument(document: CanvasDocument): boolean {
    return !document.preferences.drama && document.scene.nodes.some(node => isStoryboard(node) &&
        (node.storyboard.assets.some(asset => asset.image?.source.includes("/open-drama/")) ||
         node.storyboard.shots.some(shot => shot.image?.source.includes("/open-drama/"))));
}

/** Upgrade a snapshot without mutating it; edited variants and all nodes/media survive. */
export function upgradeDramaDocument(document: CanvasDocument, source?: OpenDramaProject): CanvasDocument {
    if (document.preferences.drama) return document;
    const variants = new Map<string, Map<string, string>>();
    const assets = new Map<string, CanvasStoryboardAsset>();
    const chapters: CanvasDramaProject["chapters"] = [];
    const nodeChapters = new Map<string, string>();
    const nodes = document.scene.nodes.map(node => {
        if (!isStoryboard(node)) return node;
        const chapterId = `chapter:${node.id}`;
        const scriptId = document.scene.connections.find(edge => edge.target.nodeId === node.id && document.scene.nodes.some(n => n.id === edge.source.nodeId && n.kind === "text"))?.source.nodeId;
        chapters.push({ id: chapterId, title: node.title, scriptNodeId: scriptId, storyboardNodeId: node.id });
        nodeChapters.set(node.id, chapterId);
        if (scriptId) nodeChapters.set(scriptId, chapterId);
        const remap = new Map<string, string>();
        node.storyboard.assets.forEach(asset => {
            const versions = variants.get(asset.id) || new Map<string, string>();
            const signature = fingerprint(asset);
            const id = versions.get(signature) || (versions.size ? `${asset.id}:variant:${node.id}` : asset.id);
            versions.set(signature, id);
            variants.set(asset.id, versions);
            assets.set(id, { ...asset, id });
            remap.set(asset.id, id);
        });
        const chapterSort = Number(node.title.match(/^(\d+)\./)?.[1] || node.title.match(/第\s*(\d+)\s*章/)?.[1]);
        const sourceChapter = source?.chapters.find(item => item.sort === chapterSort)
            || source?.chapters.find(item => item.name === node.title);
        const shots = node.storyboard.shots.map(shot => {
            const original = sourceChapter?.shots.find(item => item.sort === shot.shotNumber);
            // A changed final prompt is a user edit, and takes precedence over source data.
            const unchanged = original && [original.imagePrompt, original.videoPrompt, original.description].includes(shot.finalPrompt);
            return repairDramaShotAssetReferences({ ...normalizeShotPromptContext(shot),
                imagePrompt: shot.imagePrompt ?? (unchanged ? original.imagePrompt || shot.finalPrompt : shot.finalPrompt),
                videoPrompt: shot.videoPrompt ?? (unchanged ? original.videoPrompt || shot.finalPrompt : shot.finalPrompt),
                assetIds: shot.assetIds.map(id => remap.get(id) || id),
            }, [...new Set(remap.values())].map(id => assets.get(id)!));
        });
        const used = new Set(shots.flatMap(shot => shot.assetIds));
        // Unused originals and edited variants remain in the project pool without fake chapter references.
        const chapterAssets = [...new Set(remap.values())].filter(id => used.has(id)).map(id => assets.get(id)!);
        return { ...node, dramaChapterId: chapterId, storyboard: { ...node.storyboard, shots, assets: chapterAssets } };
    });
    // Existing downstream generated nodes retain their chapter association.
    for (let pass = 0; pass < nodes.length; pass++) {
        let changed = false;
        for (const edge of document.scene.connections) {
            const chapterId = nodeChapters.get(edge.source.nodeId);
            if (chapterId && !nodeChapters.has(edge.target.nodeId)) { nodeChapters.set(edge.target.nodeId, chapterId); changed = true; }
        }
        if (!changed) break;
    }
    const assigned = nodes.map(node => ({ ...node, dramaChapterId: node.dramaChapterId || nodeChapters.get(node.id) || chapters[0]?.id }));
    return { ...document, scene: { ...document.scene, nodes: assigned, viewport: { offsetX: 300, offsetY: 140, zoom: 0.8 } },
        preferences: { ...document.preferences, drama: { version: 1, sourceId: source?.id, cover: source?.localCover, chapters, assets: [...assets.values()], activeChapterId: chapters[0]?.id || null, view: "shots" } } };
}

/** Only storage is normalized. Existing editor/generation consumers receive hydrated arrays. */
export function packDramaDocument(document: CanvasDocument): CanvasDocument {
    const drama = document.preferences.drama;
    if (!drama) return document;
    const assets = collectDramaAssets(document.scene.nodes, drama.assets);
    return { ...document, preferences: { ...document.preferences, drama: { ...drama, assets } },
        scene: { ...document.scene, nodes: document.scene.nodes.map(node => isStoryboard(node) ?
            { ...node, storyboard: { ...node.storyboard, projectAssetIds: node.storyboard.assets.length ? node.storyboard.assets.map(a => a.id) : node.storyboard.projectAssetIds || [], assets: [] } } : node) } };
}

export function unpackDramaDocument(document: CanvasDocument): CanvasDocument {
    const drama = document.preferences.drama;
    if (!drama) return document;
    const pool = new Map(drama.assets.map(asset => [asset.id, asset]));
    const hydrated = document.scene.nodes.map(node => {
        if (!isStoryboard(node)) return node;
        const { projectAssetIds, ...storyboard } = node.storyboard;
        const chapterAssets = node.storyboard.assets.length ? node.storyboard.assets :
            (projectAssetIds || []).map(id => pool.get(id)).filter((asset): asset is CanvasStoryboardAsset => Boolean(asset));
        const candidates = [...new Map([...pool.values(), ...chapterAssets].map(asset => [asset.id, asset])).values()];
        const shots = storyboard.shots.map(shot => repairDramaShotAssetReferences(normalizeShotPromptContext(shot), candidates));
        const used = new Set(shots.flatMap(shot => shot.assetIds));
        const assets = [...new Map([...chapterAssets, ...candidates.filter(asset => used.has(asset.id))].map(asset => [asset.id, asset])).values()];
        return { ...node, storyboard: { ...storyboard, shots, assets } };
    });
    const boards = new Map(hydrated.filter(isStoryboard).map(board => [board.id, board]));
    const nodes = hydrated.map(node => {
        if (node.kind === "image" && node.dramaStoryboardId && node.dramaShotId) {
            const board = boards.get(node.dramaStoryboardId);
            const shot = board?.storyboard.shots.find(item => item.id === node.dramaShotId);
            if (!board || !shot) return node;
            const managed = assetImageReferences(board, shot.assetIds);
            // Recovered project references lead; custom uploads and their storage metadata survive.
            const references = replaceManagedVideoImageReferences(node.generation, imageReferences([]), managed);
            const operation = references.references.length ? "edit" as const : node.generation.operation;
            if (sameReferences(node.generation.references, references.references) &&
                JSON.stringify(node.generation.referenceObjectStorages) === JSON.stringify(references.referenceObjectStorages) &&
                node.generation.operation === operation) return node;
            return { ...node, generation: { ...node.generation, ...references, operation } };
        }
        if (node.kind !== "video" || !node.dramaStoryboardId || !node.dramaShotId || node.dramaVideoReferenceVersion === 1) return node;
        const board = boards.get(node.dramaStoryboardId);
        const shot = board?.storyboard.shots.find(item => item.id === node.dramaShotId);
        if (!board || !shot) return node;
        // Record the one-time check even when this old node needs no migration.
        // A later manual asset-only selection must survive the next reload.
        const checked = { ...node, dramaVideoReferenceVersion: 1 as const };
        if (!shot.image?.source) return checked;
        const current = shotVideoImageReferences(board, shot);
        const savedReferences = node.generation.references || [];
        // A corrected primary reference proves this is already the new layout. In
        // particular, do not delete a later manual upload of a project asset.
        if (savedReferences.some(reference => current.keys.has(reference))) return checked;
        const legacy = assetImageReferences(board, shot.assetIds);
        if (!savedReferences.some(reference => legacy.keys.has(reference))) return checked;
        const references = replaceManagedVideoImageReferences(node.generation, legacy, current);
        return { ...checked, generation: { ...node.generation, ...references } };
    });
    return { ...document, scene: { ...document.scene, nodes } };
}

/** Propagate immutable asset edits to chapters that reference the same project asset. */
export function reconcileDramaNodes(before: CanvasNode[], after: CanvasNode[], chapterId?: string | null): CanvasNode[] {
    if (before === after) return before;
    const previous = new Map(before.map(node => [node.id, node]));
    const changed = new Map<string, CanvasStoryboardAsset>();
    after.filter(isStoryboard).forEach(node => {
        const old = previous.get(node.id);
        if (!old || !isStoryboard(old) || old.storyboard.assets === node.storyboard.assets) return;
        const oldAssets = new Map(old.storyboard.assets.map(asset => [asset.id, asset]));
        node.storyboard.assets.forEach(asset => {
            const oldAsset = oldAssets.get(asset.id);
            if (oldAsset && fingerprint(oldAsset) !== fingerprint(asset)) changed.set(asset.id, asset);
        });
    });
    const linked = after.filter(node => node.dramaStoryboardId && node.dramaShotId && (node.kind === "image" || node.kind === "video" || node.kind === "text"));
    // Apply edits from expanded nodes to the board first, then project one resolved shot
    // onto every linked node. This also prevents stale sibling nodes undoing board edits.
    const reconciled = after.map(node => {
        if (!isStoryboard(node)) return node;
        const oldBoard = previous.get(node.id);
        const assets = node.storyboard.assets.map(asset => changed.get(asset.id) || asset);
        const updates = linked.filter(item => item.dramaStoryboardId === node.id && previous.get(item.id) !== item);
        const shots = node.storyboard.shots.map(shot => {
            const oldShot = oldBoard && isStoryboard(oldBoard) ? oldBoard.storyboard.shots.find(item => item.id === shot.id) : undefined;
            let next = shot;
            for (const item of updates) {
                if (item.dramaShotId !== shot.id) continue;
                const old = previous.get(item.id);
                if (item.kind === "text" && old?.kind === "text" && old.content.text !== item.content.text &&
                    (!oldShot || (shot.imagePrompt ?? shot.finalPrompt) === (oldShot.imagePrompt ?? oldShot.finalPrompt))) {
                    next = { ...next, imagePrompt: item.content.text };
                }
                if (item.kind !== "image" && item.kind !== "video") continue;
                if (item.content.source && (!old || (old.kind !== "image" && old.kind !== "video") || old.content.source !== item.content.source)) {
                    next = { ...next, [item.kind]: { ...item.content, ...(item.kind === "video" ? { poster: next.image?.source, model: item.generation.model, size: item.generation.size,
                        previousVideoStorageKey: item.dramaVideoPlan?.previousVideoStorageKey,
                        sourceSignature: item.dramaVideoPlan?.signature || (next.video?.source === item.content.source && next.video.sourceSignature ? next.video.sourceSignature : dramaShotVideoSignature({ ...next, videoPrompt: item.generation.prompt, durationSeconds: Number(item.generation.seconds) || next.durationSeconds }, node)) } : {}) } };
                }
                if (old && (old.kind === "image" || old.kind === "video")) {
                    const key = item.kind === "image" ? "imagePrompt" : "videoPrompt";
                    if (old.generation.prompt !== item.generation.prompt && (!oldShot || (shot[key] ?? shot.finalPrompt) === (oldShot[key] ?? oldShot.finalPrompt))) {
                        next = { ...next, [key]: item.generation.prompt };
                    }
                    if (item.kind === "video" && old.kind === "video" && old.generation.seconds !== item.generation.seconds &&
                        (!oldShot || shot.durationSeconds === oldShot.durationSeconds)) {
                        const seconds = Number(item.generation.seconds);
                        if (Number.isFinite(seconds) && seconds > 0) next = { ...next, durationSeconds: seconds };
                    }
                    if (item.kind === "image" && old.kind === "image" && !sameReferences(old.generation.references, item.generation.references) &&
                        (!oldShot || sameReferences(shot.assetIds, oldShot.assetIds))) {
                        const sources = new Map(assets.filter(asset => asset.image?.source).map(asset => [asset.image!.source, asset.id]));
                        // Custom uploads remain node inputs; known project references can also
                        // be edited from the expanded image's settings without diverging.
                        if (item.generation.references.every(source => sources.has(source))) next = { ...next, assetIds: [
                            ...shot.assetIds.filter(id => !assets.find(asset => asset.id === id)?.image?.source),
                            ...item.generation.references.map(source => sources.get(source)!),
                        ] };
                    }
                }
            }
            return next;
        });
        return assets.every((asset, index) => asset === node.storyboard.assets[index]) && shots.every((shot, index) => shot === node.storyboard.shots[index])
            ? node : { ...node, storyboard: { ...node.storyboard, assets, shots } };
    });
    const boards = new Map(reconciled.filter(isStoryboard).map(node => [node.id, node]));
    return reconciled.map(node => {
        let next = node;
        const previousNode = previous.get(node.id);
        const owner = node.dramaChapterId || previousNode?.dramaChapterId || (!previousNode ? chapterId : undefined);
        if (owner && owner !== node.dramaChapterId) next = { ...next, dramaChapterId: owner };
        const board = next.dramaStoryboardId ? boards.get(next.dramaStoryboardId) : undefined;
        const shot = board?.storyboard.shots.find(item => item.id === next.dramaShotId);
        if (board && shot) {
            if (next.kind === "text") {
                const prompt = shot.imagePrompt ?? shot.finalPrompt;
                if (next.content.text !== prompt) next = { ...next, content: { ...next.content, text: prompt } };
            } else if (next.kind === "image" || next.kind === "video") {
                const kind = next.kind;
                const prompt = (kind === "image" ? shot.imagePrompt : shot.videoPrompt) ?? shot.finalPrompt;
                const oldBoard = previous.get(board.id);
                const oldShot = oldBoard && isStoryboard(oldBoard) ? oldBoard.storyboard.shots.find(item => item.id === shot.id) : undefined;
                const managed = next.kind === "video" ? shotVideoImageReferences(board, shot) : assetImageReferences(board, shot.assetIds);
                const oldManaged = oldBoard && isStoryboard(oldBoard) && oldShot
                    ? next.kind === "video" ? shotVideoImageReferences(oldBoard, oldShot) : assetImageReferences(oldBoard, oldShot.assetIds)
                    : imageReferences([]);
                const assetReferences = managed.references;
                const oldReferences = oldManaged.references;
                const assetStorages = managed.referenceObjectStorages;
                const oldStorages = oldManaged.referenceObjectStorages;
                const managedReferencesChanged = !previousNode || !sameReferences(assetReferences, oldReferences) || JSON.stringify(assetStorages) !== JSON.stringify(oldStorages);
                const mergedReferences = managedReferencesChanged ? replaceManagedVideoImageReferences(next.generation, oldManaged, managed) : undefined;
                const references = managedReferencesChanged ? mergedReferences?.references || assetReferences : next.generation.references;
                const referenceObjectStorages = managedReferencesChanged ? mergedReferences?.referenceObjectStorages || assetStorages : next.generation.referenceObjectStorages;
                const imageOperation = next.kind === "image" ? (references.length ? "edit" : managedReferencesChanged ? "generation" : next.generation.operation) : undefined;
                const videoModeChanged = !previousNode || (!shot.image?.source && managedReferencesChanged) || Boolean(oldShot?.image?.source) !== Boolean(shot.image?.source);
                const videoGenerationMode = next.kind === "video" && videoModeChanged ? (shot.image?.source || references.length ? "image-to-video" : "text-to-video") : next.kind === "video" ? next.generation.videoGenerationMode : undefined;
                const media = shot[kind];
                if (oldShot && oldShot[kind] !== media) next = { ...next, content: { ...media, source: media?.source || "" } };
                if (next.generation.prompt !== prompt || !sameReferences(next.generation.references, references) || JSON.stringify(next.generation.referenceObjectStorages) !== JSON.stringify(referenceObjectStorages) ||
                    (next.kind === "image" && next.generation.operation !== imageOperation) ||
                    (next.kind === "video" && (next.generation.seconds !== String(shot.durationSeconds) || next.generation.videoGenerationMode !== videoGenerationMode))) {
                    next = { ...next, generation: { ...next.generation, prompt, references, referenceObjectStorages,
                        ...(next.kind === "image" ? { operation: imageOperation } : {}),
                        ...(next.kind === "video" ? { seconds: String(shot.durationSeconds), videoGenerationMode } : {}) } } as CanvasNode;
                }
            }
        }
        return next;
    });
}

function sameReferences(left: string[], right: string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

type ManagedImageReferences = { references: string[]; referenceObjectStorages: ObjectStorageFile[]; keys: Set<string> };

function imageReferences(images: Array<CanvasStoryboardAssetImage | undefined>): ManagedImageReferences {
    const references: string[] = [];
    const referenceObjectStorages: ObjectStorageFile[] = [];
    const keys = new Set<string>();
    for (const image of images) {
        if (!image?.source) continue;
        references.push(image.source);
        keys.add(image.source);
        if (image.storageKey) keys.add(image.storageKey);
        if (image.objectStorage?.url) {
            const file = image.objectStorage;
            referenceObjectStorages.push(file);
            keys.add(file.url);
            keys.add(file.key);
            keys.add(`image:${file.key}`);
        }
    }
    return { references, referenceObjectStorages, keys };
}

function assetImageReferences(board: CanvasStoryboardNode, assetIds: string[]) {
    return { ...imageReferences(assetIds.map(id => board.storyboard.assets.find(asset => asset.id === id)?.image)),
        references: shotAssetReferences(board, assetIds), referenceObjectStorages: shotAssetStorages(board, assetIds) };
}

function shotVideoImageReferences(board: CanvasStoryboardNode, shot: CanvasStoryboardShot) {
    return shot.image?.source ? imageReferences([shot.image]) : assetImageReferences(board, shot.assetIds);
}

/** Replace only the automatically managed inputs; manual extras keep their order and metadata. */
function replaceManagedVideoImageReferences(generation: Pick<CanvasVideoGenerationSettings, "references" | "referenceObjectStorages">, previous: ManagedImageReferences, current: ManagedImageReferences) {
    const references = [...new Set(current.references)];
    for (const reference of generation.references || []) {
        if (!previous.keys.has(reference) && !current.keys.has(reference) && !references.includes(reference)) references.push(reference);
    }
    const referenceObjectStorages = [...current.referenceObjectStorages];
    for (const file of generation.referenceObjectStorages || []) {
        if (previous.keys.has(file.url) || previous.keys.has(file.key) || previous.keys.has(`image:${file.key}`)) continue;
        if (!referenceObjectStorages.some(existing => existing.url === file.url)) referenceObjectStorages.push(file);
    }
    return { references, referenceObjectStorages };
}

function shotAssetReferences(board: CanvasStoryboardNode, assetIds: string[]) {
    return assetIds.flatMap(id => {
        const source = board.storyboard.assets.find(asset => asset.id === id)?.image?.source;
        return source ? [source] : [];
    });
}

function shotAssetStorages(board: CanvasStoryboardNode, assetIds: string[]) {
    return assetIds.flatMap(id => {
        const storage = board.storyboard.assets.find(asset => asset.id === id)?.image?.objectStorage;
        return storage?.url ? [storage] : [];
    });
}

/** Materialize only the requested shots. Stable IDs make repeated expansion idempotent. */
export function expandDramaShots(nodes: CanvasNode[], connections: CanvasConnection[], storyboardId: string, shotIds: string[]) {
    const board = nodes.find((node): node is CanvasStoryboardNode => node.id === storyboardId && isStoryboard(node));
    if (!board) return { nodes, connections, focusIds: [] as string[] };
    const nextNodes = [...nodes];
    const nextConnections = [...connections];
    const focusIds: string[] = [];
    for (const shot of board.storyboard.shots.filter(shot => shotIds.includes(shot.id))) {
        const prefix = `${board.id}:${shot.id}`;
        const origin = { x: board.frame.position.x + board.frame.width + 100, y: board.frame.position.y + board.storyboard.shots.indexOf(shot) * 440 };
        const text = createTextNode({ id: `${prefix}:prompt`, title: `镜头 ${shot.shotNumber} · 图片提示词`, text: shot.imagePrompt ?? shot.finalPrompt, position: origin });
        text.frame.width = 320; text.frame.height = 250;
        const image = createImageNode({ id: `${prefix}:image`, title: `镜头 ${shot.shotNumber} · 图片`, position: { x: origin.x + 390, y: origin.y } });
        image.content = { ...image.content, ...shot.image };
        image.generation.prompt = shot.imagePrompt ?? shot.finalPrompt;
        image.generation.references = shotAssetReferences(board, shot.assetIds);
        image.generation.referenceObjectStorages = shotAssetStorages(board, shot.assetIds);
        image.generation.operation = image.generation.references.length ? "edit" : "generation";
        const video = createVideoNode({ id: `${prefix}:video`, title: `镜头 ${shot.shotNumber} · 视频`, position: { x: origin.x + 980, y: origin.y } });
        video.dramaVideoReferenceVersion = 1;
        video.content = { ...video.content, ...shot.video };
        video.generation.prompt = shot.videoPrompt ?? shot.finalPrompt;
        video.generation.seconds = String(shot.durationSeconds);
        const videoReferences = shotVideoImageReferences(board, shot);
        video.generation.references = videoReferences.references;
        video.generation.referenceObjectStorages = videoReferences.referenceObjectStorages;
        video.generation.videoGenerationMode = shot.image?.source || video.generation.references.length ? "image-to-video" : "text-to-video";
        for (const node of [text, image, video]) {
            if (!nextNodes.some(item => item.id === node.id)) nextNodes.push({ ...node, dramaChapterId: board.dramaChapterId, dramaShotId: shot.id, dramaStoryboardId: board.id });
            focusIds.push(node.id);
        }
        for (const [source, target] of [[board.id, text.id], [text.id, image.id], [image.id, video.id]]) {
            if (!nextConnections.some(edge => edge.source.nodeId === source && edge.target.nodeId === target)) nextConnections.push({ id: `drama:${source}:${target}`, source: { nodeId: source }, target: { nodeId: target } });
        }
    }
    const addedNodes = nextNodes.length !== nodes.length;
    return { nodes: addedNodes && board.dramaChapterId ? arrangeDramaChapterNodes(nextNodes, board.dramaChapterId, nextConnections) : addedNodes ? nextNodes : nodes,
        connections: nextConnections.length === connections.length ? connections : nextConnections, focusIds };
}

export function dramaChapterNodes(nodes: CanvasNode[], chapterId: string | null | undefined): CanvasNode[] {
    return chapterId ? nodes.filter(node => node.dramaChapterId === chapterId) : nodes;
}
