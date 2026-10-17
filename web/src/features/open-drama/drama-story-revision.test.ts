import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode } from "@/features/canvas/constants";
import type { CanvasStoryboardAsset, CanvasStoryboardShot } from "@/features/canvas/types";
import { applyDramaStoryRevision, createDramaStorySourceSignature, DramaStoryRevisionError } from "./drama-story-revision";

const shot = (id: string, overrides: Partial<CanvasStoryboardShot> = {}): CanvasStoryboardShot => ({ id, shotNumber: 1, durationSeconds: 8,
    visualDescription: "主人公打开古老的箱子。", shotSize: "近景", lightingAtmosphere: "烛光", dialogueVoiceover: "我终于找到了。",
    soundEffect: "箱盖吱呀声", cameraMovement: "慢慢推近", finalPrompt: "旧提示词", assetIds: ["new-hero"],
    continuity: { sceneId: "阁楼", time: "夜晚", transition: "establish", openingState: "箱子关闭，人物俯身伸手。", closingState: "箱盖打开，信件露出。", storyBeat: "发现关键证据" },
    ...overrides });
function fixture() {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    const existing: CanvasStoryboardAsset = { id: "canonical-hero", kind: "character", name: "林夏", description: "短发、蓝衣", image: { source: "/hero.png", storageKey: "hero" } };
    board.content.instruction = "原章剧本";
    board.content.visualStyle = "写实电影";
    board.storyboard.assets = [existing];
    board.storyboard.shots = [shot("old", { assetIds: [existing.id], image: { source: "/old.png" }, video: { source: "/old.mp4", storageKey: "old-video" } })];
    const generated = { shots: [shot("new")], assets: [{ id: "new-hero", kind: "character" as const, name: " 林夏 ", description: "模型试图改变为长发红衣" }] };
    const projectAssets = [existing, { id: "unused", kind: "scene" as const, name: "港口", description: "远处城市灯光", image: { source: "/port.png" } }];
    return { board, generated, projectAssets, scriptContent: "真实完整章节" };
}

test("优化保留角色定妆、资产标识和历史视频，同时生成完整可用的新提示词", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const result = applyDramaStoryRevision({ ...input, expectedSourceSignature: createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets), revisionId: "v1", now: "2026-10-06" });
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(result.board.storyboard.shots[0].assetIds, ["canonical-hero"]);
    assert.equal(result.board.storyboard.assets[0].description, "短发、蓝衣");
    assert.equal(result.board.storyboard.assets[0].image?.source, "/hero.png");
    assert.ok(result.assets.some(asset => asset.id === "unused"));
    assert.equal(result.board.storyboard.shots[0].image, undefined);
    assert.equal(result.board.storyboard.shots[0].video, undefined);
    assert.equal(result.board.storyboard.revisions![0].shots[0].video?.source, "/old.mp4");
    assert.equal(result.board.storyboard.revisions![0].shots[0].image?.source, "/old.png");
    assert.deepEqual(result.retiredShotIds, ["old"]);
    assert.notEqual(result.board.storyboard.shots[0].id, "old");
    for (const detail of ["箱盖打开", "我终于找到了", "写实电影", "8秒", "发现关键证据"]) assert.ok(result.board.storyboard.shots[0].videoPrompt!.includes(detail));
    assert.ok(!result.board.storyboard.shots[0].imagePrompt!.includes("箱盖打开"));
});

test("多个不相关题材与同名不同类别资产都使用通用合并规则", () => {
    for (const name of ["星舰船长", "阿桃", "侦探马丁"]) {
        const input = fixture();
        input.board.storyboard.assets[0].name = name;
        input.generated.assets[0].name = name;
        input.generated.assets.push({ id: "prop", kind: "prop" as "character", name, description: "名字相同的道具" });
        input.generated.shots[0].assetIds.push("prop");
        const result = applyDramaStoryRevision({ ...input, expectedSourceSignature: createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets), revisionId: name });
        assert.deepEqual(result.board.storyboard.shots[0].assetIds, ["canonical-hero", "prop"]);
        assert.equal(result.assets.find(asset => asset.id === "prop")?.kind, "prop");
    }
});

test("保留模型明确引用的同名章节变体，不因为项目默认角色有图片而替换身份", () => {
    const input = fixture();
    const variant: CanvasStoryboardAsset = { id: "chapter-hero", kind: "character", name: "林夏", description: "晚年、白发、灰衣" };
    input.board.storyboard.assets = [variant];
    input.board.storyboard.shots[0].assetIds = [variant.id];
    input.generated.assets[0] = { id: variant.id, kind: "character", name: variant.name, description: variant.description };
    input.generated.shots[0].assetIds = [variant.id];
    let result = applyDramaStoryRevision({ ...input, expectedSourceSignature: createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets), revisionId: "variant-explicit" });
    assert.deepEqual(result.board.storyboard.shots[0].assetIds, [variant.id]);
    assert.equal(result.board.storyboard.assets.find(asset => asset.id === variant.id)?.description, variant.description);
    assert.equal(result.board.storyboard.assets.find(asset => asset.id === variant.id)?.image, undefined);
    assert.equal(result.assets.find(asset => asset.id === "canonical-hero")?.image?.source, "/hero.png");

    // A new reference key for the same named character still favors the active chapter variant.
    input.generated.assets[0].id = "new-alias";
    input.generated.shots[0].assetIds = ["new-alias"];
    result = applyDramaStoryRevision({ ...input, expectedSourceSignature: createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets), revisionId: "variant-alias" });
    assert.deepEqual(result.board.storyboard.shots[0].assetIds, [variant.id]);
});

test("一章同时拥有同名角色的两个时期，明确引用的ID保持区分", () => {
    const input = fixture();
    const older: CanvasStoryboardAsset = { id: "older-hero", kind: "character", name: "林夏", description: "白发老妇", image: { source: "/older.png" } };
    input.board.storyboard.assets.push(older);
    input.generated.assets[0] = { id: older.id, kind: "character", name: older.name, description: older.description };
    input.generated.shots[0].assetIds = [older.id];
    const result = applyDramaStoryRevision({ ...input, expectedSourceSignature: createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets), revisionId: "two-ages" });
    assert.deepEqual(result.board.storyboard.shots[0].assetIds, [older.id]);
    assert.equal(result.assets.find(asset => asset.id === older.id)?.image?.source, "/older.png");
    assert.equal(result.assets.find(asset => asset.id === "canonical-hero")?.image?.source, "/hero.png");
});

test("剧本、连续性、素材图或已完成视频发生改变时拒绝过期草稿", () => {
    for (const mutate of [
        (input: ReturnType<typeof fixture>) => { input.scriptContent += "新结局"; },
        (input: ReturnType<typeof fixture>) => { input.board.storyboard.shots[0].continuity!.closingState = "跑出屋外"; },
        (input: ReturnType<typeof fixture>) => { input.projectAssets[1].image!.source = "/new-port.png"; },
        (input: ReturnType<typeof fixture>) => { input.board.storyboard.shots[0].video = { source: "/newly-finished.mp4" }; },
    ]) {
        const input = fixture();
        const signature = createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets);
        mutate(input);
        const before = JSON.stringify(input);
        assert.throws(() => applyDramaStoryRevision({ ...input, expectedSourceSignature: signature }), (error: unknown) => error instanceof DramaStoryRevisionError && error.code === "stale-draft");
        assert.equal(JSON.stringify(input), before);
    }
});

test("资产引用非法时不部分更新；新增资产撞旧ID时重新映射", () => {
    const input = fixture();
    input.generated.assets[0].id = "canonical-hero";
    input.generated.assets[0].name = "新人物";
    input.generated.shots[0].assetIds = ["canonical-hero"];
    const result = applyDramaStoryRevision({ ...input, expectedSourceSignature: createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets), revisionId: "collision" });
    assert.deepEqual(result.board.storyboard.shots[0].assetIds, ["revision:collision:asset:1"]);
    assert.equal(result.assets.find(asset => asset.id === "canonical-hero")?.name, "林夏");
    input.generated.shots[0].assetIds = ["missing"];
    const before = JSON.stringify(input);
    assert.throws(() => applyDramaStoryRevision({ ...input, expectedSourceSignature: createDramaStorySourceSignature(input.board, input.scriptContent, input.projectAssets) }), /不存在的资产/);
    assert.equal(JSON.stringify(input), before);
});

test("历史有界且签名不递归膨胀，旧展开镜头标识不会再次成为有效镜头", () => {
    const input = fixture();
    let board = input.board;
    const ids = new Set(board.storyboard.shots.map(shot => shot.id));
    for (let iteration = 0; iteration < 8; iteration++) {
        const signature = createDramaStorySourceSignature(board, input.scriptContent, input.projectAssets);
        assert.ok(signature.length < 80);
        const result = applyDramaStoryRevision({ ...input, board, expectedSourceSignature: signature, revisionId: `r${iteration}` });
        assert.ok(!ids.has(result.board.storyboard.shots[0].id));
        ids.add(result.board.storyboard.shots[0].id);
        board = result.board;
    }
    assert.equal(board.storyboard.revisions!.length, 5);
    assert.equal(board.storyboard.revisions![0].id, "r7");
    assert.equal(board.storyboard.revisions![4].id, "r3");
});
