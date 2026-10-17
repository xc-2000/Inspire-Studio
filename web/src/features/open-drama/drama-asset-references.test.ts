import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasStoryboardAsset, CanvasStoryboardShot } from "@/features/canvas/types";
import { repairDramaShotAssetReferences } from "./drama-asset-references";

const assets: CanvasStoryboardAsset[] = [
    { id: "lin", name: "林岁安", kind: "character", description: "" },
    { id: "zhao", name: "赵金花", kind: "character", description: "" },
    { id: "scene", name: "林家堂屋-用餐区", kind: "scene", description: "" },
    { id: "ladle", name: "水瓢", kind: "prop", description: "" },
];
const shot = (imagePrompt: string, assetIds: string[] = []): CanvasStoryboardShot => ({
    id: "shot", shotNumber: 1, durationSeconds: 5, visualDescription: "", shotSize: "中景", lightingAtmosphere: "",
    dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "", imagePrompt, assetIds,
});

test("旧镜头恢复明确素材名，保留顺序并忽略代词与未知名字", () => {
    const source = shot("场景：@[林家堂屋-用餐区]，@[林岁安]举起@[水瓢]，赵金花回头，@[她]看着@[林岁安]，@[陌生人]离开");
    assert.deepEqual(repairDramaShotAssetReferences(source, assets).assetIds, ["scene", "lin", "ladle", "zhao"]);
    assert.deepEqual(source.assetIds, []);
});

test("存在人工绑定时不追加，迁移后人工清空不会重建", () => {
    const existing = repairDramaShotAssetReferences(shot("林岁安和赵金花", ["lin"]), assets);
    assert.deepEqual(existing.assetIds, ["lin"]);
    const cleared = { ...existing, assetIds: [] };
    assert.equal(repairDramaShotAssetReferences(cleared, assets), cleared);
});

test("同名素材版本不猜测，不把较短名字作为较长名字的额外角色", () => {
    const ambiguous = [...assets, { ...assets[0], id: "lin-alternate" }];
    assert.deepEqual(repairDramaShotAssetReferences(shot("@[林岁安]和赵金花"), ambiguous).assetIds, ["zhao"]);
    const overlapping = [...assets, { id: "short", name: "岁安", kind: "character" as const, description: "" }];
    assert.deepEqual(repairDramaShotAssetReferences(shot("林岁安举起水瓢"), overlapping).assetIds, ["lin", "ladle"]);
});

test("明确清空图片提示词时不从旧提示词复活引用", () => {
    const source = { ...shot(""), finalPrompt: "林岁安举起水瓢", visualDescription: "赵金花回头" };
    assert.deepEqual(repairDramaShotAssetReferences(source, assets).assetIds, []);
});
