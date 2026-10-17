import assert from "node:assert/strict";
import test from "node:test";
import { commerceImageGenerationModeFromRequest, resolveCommerceImageGenerationMode } from "./image-generation-mode";

test("未设置模式的商品无图默认文生图，有图兼容图生图", () => {
    assert.equal(resolveCommerceImageGenerationMode(undefined, 0), "text-to-image");
    assert.equal(resolveCommerceImageGenerationMode(undefined, 2), "image-to-image");
});

test("保存的显式模式不随商品图片增减改变", () => {
    for (const count of [0, 1, 6]) {
        assert.equal(resolveCommerceImageGenerationMode("text-to-image", count), "text-to-image");
        assert.equal(resolveCommerceImageGenerationMode("image-to-image", count), "image-to-image");
    }
});

test("历史重新创作从任务实际参考图恢复模式，不从当前商品或元数据推断", () => {
    assert.equal(commerceImageGenerationModeFromRequest({ references: [{ storageKey: "product.png" }] }), "image-to-image");
    assert.equal(commerceImageGenerationModeFromRequest({ references: [], imageGenerationMode: "image-to-image" }), "text-to-image");
});

test("历史任务未读取或请求数据损坏时不猜测原始图片模式", () => {
    for (const data of [undefined, null, "invalid", [], {}, { prompt: "奶白色陶瓷杯" }, { references: null }, { references: "invalid" }]) {
        assert.equal(commerceImageGenerationModeFromRequest(data), undefined);
    }
});
