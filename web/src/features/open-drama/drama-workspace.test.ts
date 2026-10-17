import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode, createTextNode, createVideoNode } from "@/features/canvas/constants";
import { createCanvasDocument } from "@/features/canvas/domain/canvas-document";
import { applyCanvasNodeAttributes, updateVideoNodeGeneration } from "@/features/canvas/domain/canvas-node";
import { readStoryboardShotReferenceImages, readStoryboardVideoGenerationMode } from "@/features/canvas/domain/storyboard";
import type { CanvasNode, CanvasStoryboardNode, CanvasVideoNode } from "@/features/canvas/types";
import type { ObjectStorageFile } from "@/shared/types/object-storage";
import { collectDramaAssets, dramaChapterNodes, expandDramaShots, packDramaDocument, reconcileDramaNodes, unpackDramaDocument, upgradeDramaDocument } from "./drama-workspace";
import { preserveCanvasNodeContext } from "@/features/canvas/domain/canvas-page-node";

function fixture() {
    const document = createCanvasDocument({ id: "drama-test", title: "测试短剧", now: "2026-09-27" });
    for (let i = 0; i < 2; i++) {
        const script = createTextNode({ id: `script-${i}`, position: { x: i * 1400, y: 0 }, text: "剧本" });
        const board = createStoryboardNode({ id: `board-${i}`, title: `第${i + 1}章`, position: { x: i * 1400 + 680, y: 0 } });
        board.storyboard.assets = [{ id: "actor", kind: "character", name: "主角", description: "原始设定", image: { source: "/open-drama/role.webp" } }, { id: "unused", kind: "prop", name: "道具", description: "" }];
        board.storyboard.shots = [{ id: `shot-${i}`, shotNumber: 1, durationSeconds: 5, visualDescription: "画面", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "旧提示词", assetIds: ["actor"], image: { source: "/shot.webp" }, video: { source: "/shot.mp4" } }];
        document.scene.nodes.push(script, board);
        document.scene.connections.push({ id: `edge-${i}`, source: { nodeId: script.id }, target: { nodeId: board.id } });
    }
    return document;
}
const boards = (nodes: CanvasNode[]) => nodes.filter((n): n is CanvasStoryboardNode => n.kind === "storyboard");
const videos = (nodes: CanvasNode[]) => nodes.filter((n): n is CanvasVideoNode => n.kind === "video");
const storedImage = (name: string): ObjectStorageFile => ({ provider: "cloudflareR2", url: `https://media.example.test/${name}.png`, key: `${name}.png`, bucket: "test", region: "auto", bytes: 12, mimeType: "image/png", uploadedAt: "2026-09-30" });

test("完整视频提示词标记经升级、序列化、资产合池和恢复后保留", () => {
    const original = fixture();
    const originalShot = boards(original.scene.nodes)[0].storyboard.shots[0];
    originalShot.videoPrompt = "人物平静地完成本镜动作。";
    originalShot.videoPromptContextMode = "self-contained";
    const upgraded = upgradeDramaDocument(original);
    const restored = unpackDramaDocument(JSON.parse(JSON.stringify(packDramaDocument(upgraded))));
    const actual = boards(restored.scene.nodes)[0].storyboard.shots[0];
    assert.equal(actual.videoPromptContextMode, "self-contained");
    assert.equal(actual.videoPrompt, originalShot.videoPrompt);
    assert.equal(actual.finalPrompt, originalShot.finalPrompt);
    assert.equal(actual.visualDescription, originalShot.visualDescription);
    assert.deepEqual(actual.assetIds, originalShot.assetIds);
    assert.deepEqual(actual.image, originalShot.image);
    assert.equal(actual.durationSeconds, originalShot.durationSeconds);
    assert.deepEqual(unpackDramaDocument(packDramaDocument(restored)), restored);
});

test("导入只接受有明确视频正文的受支持标记，旧提示词回退不误认为完整改写", () => {
    for (const context of ["unknown", "self-contained"] as const) {
        const original = fixture();
        const originalShot = boards(original.scene.nodes)[0].storyboard.shots[0];
        Object.assign(originalShot, { videoPromptContextMode: context, ...(context === "unknown" ? { videoPrompt: "有正文但未知模式" } : {}) });
        const upgraded = upgradeDramaDocument(original);
        assert.equal(boards(upgraded.scene.nodes)[0].storyboard.shots[0].videoPromptContextMode, undefined);
        const packed = JSON.parse(JSON.stringify(packDramaDocument(upgraded)));
        Object.assign(boards(packed.scene.nodes)[0].storyboard.shots[0], { videoPromptContextMode: context, videoPrompt: context === "unknown" ? "有正文" : "  " });
        const restored = unpackDramaDocument(packed);
        assert.equal(boards(restored.scene.nodes)[0].storyboard.shots[0].videoPromptContextMode, undefined);
    }
});

test("旧短剧缺失素材ID时恢复章节资产与展开图片引用，保留人工图片和原成图", () => {
    const document = upgradeDramaDocument(fixture());
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, "board-0", ["shot-0"]);
    const packed = packDramaDocument({ ...document, scene: { ...document.scene, ...expanded } });
    const board = boards(packed.scene.nodes)[0];
    board.storyboard.projectAssetIds = [];
    board.storyboard.shots[0] = { ...board.storyboard.shots[0], imagePrompt: "@[主角]拿起@[道具]", assetIds: [] };
    delete board.storyboard.shots[0].assetReferenceVersion;
    const node = packed.scene.nodes.find(node => node.kind === "image")!;
    assert.equal(node.kind, "image");
    if (node.kind !== "image") return;
    node.generation.references = ["https://example.test/manual.png"];
    node.generation.operation = "generation";
    node.generation.model = "configured-model";
    const original = structuredClone(packed);
    const restored = unpackDramaDocument(packed);
    const restoredBoard = boards(restored.scene.nodes)[0];
    const restoredImage = restored.scene.nodes.find(node => node.kind === "image")!;
    assert.deepEqual(packed, original);
    assert.deepEqual(restoredBoard.storyboard.shots[0].assetIds, ["actor", "unused"]);
    assert.deepEqual(restoredBoard.storyboard.assets.map(asset => asset.id), ["actor", "unused"]);
    assert.equal(restoredBoard.storyboard.shots[0].assetReferenceVersion, 1);
    if (restoredImage.kind !== "image") throw new Error("image missing");
    assert.deepEqual(restoredImage.generation.references, ["/open-drama/role.webp", "https://example.test/manual.png"]);
    assert.equal(restoredImage.generation.operation, "edit");
    assert.equal(restoredImage.generation.model, "configured-model");
    assert.equal(restoredImage.content.source, "/shot.webp");
    assert.deepEqual(unpackDramaDocument(packDramaDocument(restored)), restored);
    restoredBoard.storyboard.shots[0].assetIds = [];
    restoredImage.generation.references = [];
    const cleared = unpackDramaDocument(packDramaDocument(restored));
    assert.deepEqual(boards(cleared.scene.nodes)[0].storyboard.shots[0].assetIds, []);
    assert.deepEqual(cleared.scene.nodes.find(node => node.kind === "image")?.generation.references, []);
});

test("新Fork在源objectIds缺失时从明确引用恢复资产而不改提示词", () => {
    const source = fixture();
    const board = boards(source.scene.nodes)[0];
    board.storyboard.shots[0].assetIds = [];
    board.storyboard.shots[0].imagePrompt = "@[主角]看着@[道具]";
    const upgraded = upgradeDramaDocument(source);
    assert.deepEqual(boards(upgraded.scene.nodes)[0].storyboard.shots[0].assetIds, ["actor", "unused"]);
    assert.equal(boards(upgraded.scene.nodes)[0].storyboard.shots[0].imagePrompt, "@[主角]看着@[道具]");
});

test("视频重建保留镜头归属，成功结果回填章节且重载保留引用版本", () => {
    const document = upgradeDramaDocument(fixture());
    const board = boards(document.scene.nodes)[0];
    board.storyboard.shots[0].video = undefined;
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, board.id, ["shot-0"]);
    const original = videos(expanded.nodes)[0];
    const placeholder = createVideoNode({ id: "temporary-generated-id", position: original.frame.position });
    placeholder.execution = { phase: "running", taskId: "video-task" };
    const loading = preserveCanvasNodeContext(original, placeholder);
    const pending = reconcileDramaNodes(expanded.nodes, expanded.nodes.map(node => node.id === original.id ? loading : node));
    assert.equal(loading.id, original.id);
    assert.equal(loading.dramaShotId, "shot-0");
    assert.equal(loading.dramaStoryboardId, board.id);
    assert.equal(loading.kind === "video" && loading.dramaVideoReferenceVersion, 1);
    const completed = applyCanvasNodeAttributes(loading, { content: "https://media.example.test/result.mp4", storageKey: "video:result", status: "success" });
    const saved = reconcileDramaNodes(pending, pending.map(node => node.id === original.id ? completed : node));
    assert.equal(boards(saved)[0].storyboard.shots[0].video?.source, "https://media.example.test/result.mp4");
    assert.equal(boards(saved)[0].storyboard.shots[0].video?.storageKey, "video:result");
    const restored = unpackDramaDocument(packDramaDocument({ ...document, scene: { ...document.scene, nodes: saved, connections: expanded.connections } }));
    const video = videos(restored.scene.nodes).find(node => node.id === original.id)!;
    assert.equal(video.dramaVideoReferenceVersion, 1);
    assert.equal(video.dramaChapterId, original.dramaChapterId);
    assert.equal(video.content.source, "https://media.example.test/result.mp4");
});

test("升级不修改原快照，未引用素材保留在项目库", () => {
    const source = fixture();
    const copy = structuredClone(source);
    const upgraded = upgradeDramaDocument(source);
    assert.deepEqual(source, copy);
    assert.equal(upgraded.preferences.drama?.assets.length, 2);
    assert.equal(boards(upgraded.scene.nodes)[0].storyboard.assets.length, 1);
    assert.equal(upgraded.preferences.drama?.chapters.length, 2);
    assert.deepEqual(upgradeDramaDocument(upgraded), upgraded);
});

test("同ID但已修改的素材保留独立版本并修正镜头引用", () => {
    const source = fixture();
    boards(source.scene.nodes)[1].storyboard.assets[0].description = "第二章修改过";
    const upgraded = upgradeDramaDocument(source);
    const [first, second] = boards(upgraded.scene.nodes);
    assert.equal(upgraded.preferences.drama?.assets.length, 3);
    assert.notEqual(first.storyboard.assets[0].id, second.storyboard.assets[0].id);
    assert.equal(second.storyboard.shots[0].assetIds[0], second.storyboard.assets[0].id);
    assert.equal(second.storyboard.assets[0].description, "第二章修改过");
});

test("存储只保留共享资产和ID引用，重载还原媒体及字段", () => {
    const upgraded = upgradeDramaDocument(fixture());
    const packed = packDramaDocument(upgraded);
    assert.equal(packed.preferences.drama?.assets.length, 2);
    assert.ok(boards(packed.scene.nodes).every(board => board.storyboard.assets.length === 0));
    const restored = unpackDramaDocument(JSON.parse(JSON.stringify(packed)));
    assert.deepEqual(restored, JSON.parse(JSON.stringify(upgraded)));
    assert.equal(boards(restored.scene.nodes)[0].storyboard.assets[0], boards(restored.scene.nodes)[1].storyboard.assets[0]);
});

test("共享素材修改同步到引用章节，未修改的节点不被改写", () => {
    const source = upgradeDramaDocument(fixture()).scene.nodes;
    const first = boards(source)[0];
    const edited = source.map(n => n.id === first.id ? { ...first, storyboard: { ...first.storyboard, assets: first.storyboard.assets.map(a => ({ ...a, name: "新的主角名" })) } } : n);
    const next = reconcileDramaNodes(source, edited, first.dramaChapterId);
    assert.ok(boards(next).every(board => board.storyboard.assets[0].name === "新的主角名"));
    assert.equal(next[0], source[0]);
});

test("镜头按需展开可重复调用，修改图片结果回写正确章节", () => {
    const upgraded = upgradeDramaDocument(fixture());
    const expanded = expandDramaShots(upgraded.scene.nodes, upgraded.scene.connections, "board-0", ["shot-0"]);
    const repeated = expandDramaShots(expanded.nodes, expanded.connections, "board-0", ["shot-0"]);
    assert.equal(expanded.nodes.length, 7);
    assert.equal(expanded.nodes.find(node => node.kind === "image")?.generation.operation, "edit");
    assert.deepEqual(repeated, expanded);
    const after = expanded.nodes.map(n => n.kind === "image" ? { ...n, content: { source: "/new-image.webp" } } : n);
    const synced = reconcileDramaNodes(expanded.nodes, after);
    assert.equal(boards(synced)[0].storyboard.shots[0].image?.source, "/new-image.webp");
    assert.equal(boards(synced)[1].storyboard.shots[0].image?.source, "/shot.webp");
});

test("有镜头图片时自动使用图生视频，图片作为第一张参考", () => {
    const shot = boards(fixture().scene.nodes)[0].storyboard.shots[0];
    assert.equal(readStoryboardVideoGenerationMode(shot, []), "image-to-video");
    assert.equal(readStoryboardShotReferenceImages(shot, [])[0].dataUrl, "/shot.webp");
});

test("没有生成结果时，展开节点的提示词修改也同步回镜头", () => {
    const upgraded = upgradeDramaDocument(fixture());
    const first = boards(upgraded.scene.nodes)[0];
    first.storyboard.shots[0].video = undefined;
    const expanded = expandDramaShots(upgraded.scene.nodes, upgraded.scene.connections, first.id, ["shot-0"]);
    const edited = expanded.nodes.map(node => node.kind === "video" ? { ...node, generation: { ...node.generation, prompt: "新的运动描述" } } : node);
    const synced = reconcileDramaNodes(expanded.nodes, edited);
    assert.equal(boards(synced)[0].storyboard.shots[0].videoPrompt, "新的运动描述");
    assert.equal(boards(synced)[0].storyboard.shots[0].video, undefined);
});

test("未连线的用户节点升级后仍可在章节画布找到", () => {
    const source = fixture();
    source.scene.nodes.push(createTextNode({ id: "user-note", position: { x: 0, y: 900 }, text: "手动补充的笔记" }));
    const upgraded = upgradeDramaDocument(source);
    assert.ok(dramaChapterNodes(upgraded.scene.nodes, upgraded.preferences.drama?.activeChapterId).some(n => n.id === "user-note"));
});

test("工作台修改时长、提示词与素材后，展开节点同步采用最新配置", () => {
    const document = upgradeDramaDocument(fixture());
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, "board-0", ["shot-0"]);
    const changed = expanded.nodes.map(node => node.id === "board-0" && node.kind === "storyboard" ? {
        ...node, storyboard: { ...node.storyboard,
            assets: [...node.storyboard.assets, { id: "new-actor", name: "新角色", kind: "character" as const, description: "", image: { source: "/new-actor.webp" } }],
            shots: node.storyboard.shots.map(shot => ({ ...shot, imagePrompt: "新的画面", videoPrompt: "新的运动", durationSeconds: 10, assetIds: ["new-actor"] })),
        },
    } : node);
    const synced = reconcileDramaNodes(expanded.nodes, changed);
    const text = synced.find(node => node.id === "board-0:shot-0:prompt");
    const image = synced.find(node => node.id === "board-0:shot-0:image");
    const video = synced.find(node => node.id === "board-0:shot-0:video");
    assert.equal(text?.kind === "text" && text.content.text, "新的画面");
    assert.equal(image?.kind === "image" && image.generation.prompt, "新的画面");
    assert.equal(video?.kind === "video" && video.generation.prompt, "新的运动");
    assert.equal(video?.kind === "video" && video.generation.seconds, "10");
    assert.deepEqual(image?.kind === "image" && image.generation.references, ["/new-actor.webp"]);
    assert.equal(image?.kind === "image" && image.generation.operation, "edit");
    assert.deepEqual(video?.kind === "video" && video.generation.references, ["/shot.webp"]);
});

test("展开的提示词文本和视频时长编辑回写工作台及同镜头节点", () => {
    const document = upgradeDramaDocument(fixture());
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, "board-0", ["shot-0"]);
    const changed = expanded.nodes.map(node => node.dramaShotId === "shot-0" && node.kind === "text" ? { ...node, content: { ...node.content, text: "画布编辑的提示词" } }
        : node.dramaShotId === "shot-0" && node.kind === "video" ? { ...node, generation: { ...node.generation, seconds: "8" } } : node);
    const synced = reconcileDramaNodes(expanded.nodes, changed);
    const shot = boards(synced)[0].storyboard.shots[0];
    assert.equal(shot.imagePrompt, "画布编辑的提示词");
    assert.equal(shot.durationSeconds, 8);
    assert.equal(synced.find(node => node.kind === "image")?.kind === "image" && synced.find(node => node.kind === "image")!.generation.prompt, "画布编辑的提示词");
});

test("共享素材图片更新传播到各章图片节点，视频仍引用镜头成图", () => {
    const document = upgradeDramaDocument(fixture());
    const first = expandDramaShots(document.scene.nodes, document.scene.connections, "board-0", ["shot-0"]);
    const expanded = expandDramaShots(first.nodes, first.connections, "board-1", ["shot-1"]);
    const changed = expanded.nodes.map(node => node.id === "board-0" && node.kind === "storyboard" ? {
        ...node, storyboard: { ...node.storyboard, assets: node.storyboard.assets.map(asset => ({ ...asset, image: { source: "/shared-new.webp" } })) },
    } : node);
    const synced = reconcileDramaNodes(expanded.nodes, changed);
    assert.ok(synced.filter(node => node.kind === "image").every(node => node.generation.references[0] === "/shared-new.webp"));
    assert.ok(videos(synced).every(node => node.generation.references[0] === "/shot.webp"));
});

test("角色设定图更新不会丢掉图片节点额外上传的参考", () => {
    const document = upgradeDramaDocument(fixture());
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, "board-0", ["shot-0"]);
    const image = expanded.nodes.find(node => node.kind === "image")!;
    if (image.kind !== "image") throw new Error("image missing");
    const extra = storedImage("manual-extra");
    image.generation.references.push(extra.url);
    image.generation.referenceObjectStorages.push(extra);
    const changed = expanded.nodes.map(node => node.id === "board-0" && node.kind === "storyboard" ? {
        ...node, storyboard: { ...node.storyboard, assets: node.storyboard.assets.map(asset => ({ ...asset, image: { source: "/new-role.webp" } })) },
    } : node);
    const next = reconcileDramaNodes(expanded.nodes, changed).find(node => node.kind === "image")!;
    if (next.kind !== "image") throw new Error("image missing");
    assert.deepEqual(next.generation.references, ["/new-role.webp", extra.url]);
    assert.deepEqual(next.generation.referenceObjectStorages, [extra]);
    assert.equal(next.generation.operation, "edit");
});

test("生成时临时清空节点不丢旧结果；从工作台移除图片会清空展开节点", () => {
    const document = upgradeDramaDocument(fixture());
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, "board-0", ["shot-0"]);
    const cleared = expanded.nodes.map(node => node.kind === "image" ? { ...node, content: { source: "" } } : node);
    const generating = reconcileDramaNodes(expanded.nodes, cleared);
    assert.equal(boards(generating)[0].storyboard.shots[0].image?.source, "/shot.webp");
    assert.equal(generating.find(node => node.kind === "image")?.content.source, "");
    const removed = expanded.nodes.map(node => node.id === "board-0" && node.kind === "storyboard" ? { ...node, storyboard: { ...node.storyboard, shots: node.storyboard.shots.map(shot => ({ ...shot, image: undefined })) } } : node);
    const synced = reconcileDramaNodes(expanded.nodes, removed);
    assert.equal(synced.find(node => node.kind === "image")?.content.source, "");
});

test("展开图片修改已知素材引用时回写镜头，已有视频仍用镜头成图", () => {
    const document = upgradeDramaDocument(fixture());
    const board = boards(document.scene.nodes)[0];
    board.storyboard.assets.push({ id: "new", name: "新素材", description: "", kind: "character", image: { source: "/new.webp" } });
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, board.id, ["shot-0"]);
    const changed = expanded.nodes.map(node => node.kind === "image" ? { ...node, generation: { ...node.generation, references: ["/new.webp"] } } : node);
    const synced = reconcileDramaNodes(expanded.nodes, changed);
    assert.deepEqual(boards(synced)[0].storyboard.shots[0].assetIds, ["new"]);
    assert.deepEqual(synced.find(node => node.kind === "video")?.generation.references, ["/shot.webp"]);
});

test("新展开视频持久引用镜头R2成图，保留对象存储且展开幂等", () => {
    const document = upgradeDramaDocument(fixture());
    const image = storedImage("shot-current");
    boards(document.scene.nodes)[0].storyboard.shots[0].image = { source: image.url, storageKey: "image:shot-current", objectStorage: image };
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, "board-0", ["shot-0"]);
    const video = videos(expanded.nodes)[0];
    assert.deepEqual(video.generation.references, [image.url]);
    assert.deepEqual(video.generation.referenceObjectStorages, [image]);
    assert.equal(video.generation.videoGenerationMode, "image-to-video");
    assert.equal(video.dramaVideoReferenceVersion, 1);
    assert.deepEqual(expandDramaShots(expanded.nodes, expanded.connections, "board-0", ["shot-0"]), expanded);
    assert.deepEqual(expanded.nodes.find(node => node.kind === "image")?.generation.references, ["/open-drama/role.webp"]);
});

test("无镜头成图的视频回退素材，成图成功后仅替换自动素材并保留额外参考", () => {
    const document = upgradeDramaDocument(fixture());
    const board = boards(document.scene.nodes)[0];
    const asset = storedImage("actor");
    const extra = storedImage("manual-extra");
    board.storyboard.shots[0].image = undefined;
    board.storyboard.assets[0].image = { source: asset.url, objectStorage: asset };
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, board.id, ["shot-0"]);
    const video = videos(expanded.nodes)[0];
    assert.deepEqual(video.generation.references, [asset.url]);
    assert.deepEqual(video.generation.referenceObjectStorages, [asset]);
    video.generation.references.push(extra.url);
    video.generation.referenceObjectStorages.push(extra);
    const image = storedImage("first-shot-result");
    const changed = expanded.nodes.map(node => node.id === board.id && node.kind === "storyboard" ? { ...node, storyboard: { ...node.storyboard,
        shots: node.storyboard.shots.map(shot => ({ ...shot, image: { source: image.url, objectStorage: image } })),
    } } : node);
    const synced = videos(reconcileDramaNodes(expanded.nodes, changed))[0];
    assert.deepEqual(synced.generation.references, [image.url, extra.url]);
    assert.deepEqual(synced.generation.referenceObjectStorages, [image, extra]);
});

test("旧工程解包只迁移绑定镜头的自动素材引用，额外上传及其他内容完整保留", () => {
    const document = upgradeDramaDocument(fixture());
    const board = boards(document.scene.nodes)[0];
    const asset = storedImage("legacy-actor");
    const image = storedImage("current-shot");
    const extra = storedImage("user-extra");
    const legacySource = "/open-drama/media/3049669/objects/439203.webp";
    boards(document.scene.nodes).forEach(chapter => {
        chapter.storyboard.assets[0].image = { source: legacySource, objectStorage: asset };
    });
    board.storyboard.shots[0].image = { source: image.url, storageKey: "image:current-shot", objectStorage: image };
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, board.id, ["shot-0"]);
    const video = videos(expanded.nodes)[0];
    delete video.dramaVideoReferenceVersion;
    video.generation.references = [legacySource, extra.url];
    video.generation.referenceObjectStorages = [asset, extra];
    video.generation.prompt = "用户修改的视频提示词";
    video.generation.videoGenerationMode = "reference-to-video";
    const unrelated = createVideoNode({ id: "unrelated", position: { x: 0, y: 900 } });
    unrelated.generation.references = [legacySource];
    unrelated.generation.referenceObjectStorages = [asset];
    const missingOwner = { ...createVideoNode({ id: "missing-owner", position: { x: 0, y: 950 } }), dramaStoryboardId: board.id, dramaShotId: "removed-shot" };
    missingOwner.generation.references = [asset.url];
    const legacy = packDramaDocument({ ...document, scene: { ...document.scene, nodes: [...expanded.nodes, unrelated, missingOwner], connections: expanded.connections } });
    const copy = structuredClone(legacy);
    const restored = unpackDramaDocument(legacy);
    const migrated = videos(restored.scene.nodes).find(node => node.id === video.id)!;
    assert.deepEqual(migrated.generation.references, [image.url, extra.url]);
    assert.deepEqual(migrated.generation.referenceObjectStorages, [image, extra]);
    assert.equal(migrated.dramaVideoReferenceVersion, 1);
    assert.equal(migrated.generation.prompt, video.generation.prompt);
    assert.equal(migrated.generation.videoGenerationMode, "reference-to-video");
    assert.deepEqual(migrated.content, video.content);
    assert.deepEqual(migrated.execution, video.execution);
    assert.deepEqual(restored.scene.nodes.find(node => node.id === unrelated.id), unrelated);
    assert.deepEqual(restored.scene.nodes.find(node => node.id === missingOwner.id), missingOwner);
    assert.deepEqual(legacy, copy);
    assert.deepEqual(unpackDramaDocument(restored), restored);
});

test("镜头成图更新同步视频主参考并保留手动参考、R2信息和已选模式", () => {
    const document = upgradeDramaDocument(fixture());
    const board = boards(document.scene.nodes)[0];
    const first = storedImage("shot-first");
    const next = storedImage("shot-next");
    const extra = storedImage("manual-extra");
    board.storyboard.shots[0].image = { source: first.url, objectStorage: first };
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, board.id, ["shot-0"]);
    const video = videos(expanded.nodes)[0];
    // A later explicit project-asset reference is a manual extra once the primary is present.
    video.generation.references.push("/open-drama/role.webp", extra.url);
    video.generation.referenceObjectStorages.push(extra);
    video.generation.videoGenerationMode = "reference-to-video";
    const changed = expanded.nodes.map(node => node.id === board.id && node.kind === "storyboard" ? { ...node, storyboard: { ...node.storyboard,
        shots: node.storyboard.shots.map(shot => ({ ...shot, image: { source: next.url, objectStorage: next } })),
    } } : node);
    const synced = videos(reconcileDramaNodes(expanded.nodes, changed))[0];
    assert.deepEqual(synced.generation.references, [next.url, "/open-drama/role.webp", extra.url]);
    assert.deepEqual(synced.generation.referenceObjectStorages, [next, extra]);
    assert.equal(synced.generation.videoGenerationMode, "reference-to-video");
    assert.equal(synced.generation.prompt, video.generation.prompt);
    const snapshot = { ...document, scene: { ...document.scene, nodes: expanded.nodes, connections: expanded.connections } };
    assert.deepEqual(videos(unpackDramaDocument(snapshot).scene.nodes)[0], video);
});

test("新版视频删除主参考后仅选择项目素材，编辑、生成与存储重载都保留手动选择", () => {
    const document = upgradeDramaDocument(fixture());
    const board = boards(document.scene.nodes)[0];
    const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, board.id, ["shot-0"]);
    const video = videos(expanded.nodes)[0];
    const manual = updateVideoNodeGeneration(video, {
        references: ["/open-drama/role.webp"], referenceObjectStorages: [], videoGenerationMode: "reference-to-video",
    });
    const running = applyCanvasNodeAttributes(manual, { status: "loading", taskId: "test-task", startedAt: "2026-09-30" });
    const completed = applyCanvasNodeAttributes(running, { status: "success", content: "/manual-result.mp4", completedAt: "2026-09-30" });
    assert.equal(completed.kind === "video" && completed.dramaVideoReferenceVersion, 1);
    const snapshot = { ...document, scene: { ...document.scene, nodes: expanded.nodes.map(node => node.id === video.id ? completed : node), connections: expanded.connections } };
    const restored = unpackDramaDocument(JSON.parse(JSON.stringify(packDramaDocument(snapshot))));
    assert.deepEqual(restored.scene.nodes.find(node => node.id === video.id), completed);
    assert.deepEqual(unpackDramaDocument(restored), restored);
});

test("旧视频不需要迁移也记录版本，后续仅选择项目素材不会在重载时误迁移", () => {
    for (const initial of ["primary", "custom", "no-shot-image"] as const) {
        const document = upgradeDramaDocument(fixture());
        const board = boards(document.scene.nodes)[0];
        if (initial === "no-shot-image") board.storyboard.shots[0].image = undefined;
        const expanded = expandDramaShots(document.scene.nodes, document.scene.connections, board.id, ["shot-0"]);
        const video = videos(expanded.nodes)[0];
        delete video.dramaVideoReferenceVersion;
        if (initial === "custom") video.generation.references = ["https://media.example.test/manual.png"];
        const snapshot = { ...document, scene: { ...document.scene, nodes: expanded.nodes, connections: expanded.connections } };
        const checked = unpackDramaDocument(packDramaDocument(snapshot));
        const checkedVideo = videos(checked.scene.nodes)[0];
        assert.equal(checkedVideo.dramaVideoReferenceVersion, 1, initial);
        assert.deepEqual(checkedVideo.generation, video.generation, initial);
        const manual = updateVideoNodeGeneration(checkedVideo, { references: ["/open-drama/role.webp"], referenceObjectStorages: [] });
        const edited = { ...checked, scene: { ...checked.scene, nodes: checked.scene.nodes.map(node => node.id === manual.id ? manual : node) } };
        const restored = unpackDramaDocument(JSON.parse(JSON.stringify(packDramaDocument(edited))));
        assert.deepEqual(videos(restored.scene.nodes)[0], manual, initial);
    }
});
