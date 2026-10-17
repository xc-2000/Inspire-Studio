import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, type AiConfig } from "../../settings/stores/use-config-store.ts";
import { dolaDurationOptions, dolaDurationRange, isDolaVideoConfig, normalizeDolaDuration, resolveDolaSecondsLabel, supportsDolaRatio } from "./dola-video.ts";
import { isVideoDurationSupported, readVideoDurationRange } from "./video-duration.ts";

function dolaConfig(model: string): AiConfig {
    const value = `dola::${model}`;
    return {
        ...defaultConfig,
        model: value,
        videoModel: value,
        videoModels: [value],
        channels: [{
            id: "dola",
            name: "Dola",
            baseUrl: "http://192.0.2.10:8000/v1",
            apiKey: "test-key",
            apiFormat: "dola",
            models: [model],
        }],
    };
}

test("识别 Dola 渠道，不会误判成 Seedance", () => {
    const config = dolaConfig("Doubao-Seedance-2.5");
    assert.equal(isDolaVideoConfig(config), true);
    // 名称同样含 seedance，但必须优先走 Dola 的离散时长规则。
    assert.deepEqual(readVideoDurationRange(config), { min: 10, max: 30 });
});

test("seedance-2.0 只支持 10/15 秒，2.5 支持 30 秒", () => {
    assert.deepEqual(dolaDurationOptions("Doubao-Seedance-2.0"), [10, 15]);
    assert.deepEqual(dolaDurationOptions("Doubao-Seedance-2.5"), [10, 15, 30]);
    assert.deepEqual(dolaDurationRange("Doubao-Seedance-2.0"), { min: 10, max: 15 });
    assert.deepEqual(dolaDurationRange("Doubao-Seedance-2.5"), { min: 10, max: 30 });
});

test("时长吸附到最近的合法档位", () => {
    assert.equal(normalizeDolaDuration("5", "Doubao-Seedance-2.0"), 10);
    assert.equal(normalizeDolaDuration("12", "Doubao-Seedance-2.0"), 10);
    assert.equal(normalizeDolaDuration("13", "Doubao-Seedance-2.0"), 15);
    assert.equal(normalizeDolaDuration("18", "Doubao-Seedance-2.5"), 15);
    assert.equal(normalizeDolaDuration("25", "Doubao-Seedance-2.5"), 30);
    assert.equal(normalizeDolaDuration("30", "Doubao-Seedance-2.0"), 15);
    assert.equal(normalizeDolaDuration("abc", "Doubao-Seedance-2.0"), 10);
});

test("11 至 14 秒在 Dola 下不被视为合法时长", () => {
    const config = dolaConfig("Doubao-Seedance-2.0");
    assert.equal(isVideoDurationSupported(config, 10), true);
    assert.equal(isVideoDurationSupported(config, 15), true);
    assert.equal(isVideoDurationSupported(config, 11), false);
    assert.equal(isVideoDurationSupported(config, 13), false);
    assert.equal(isVideoDurationSupported(config, 30), false);
});

test("30 秒时长只在 seedance-2.5 下合法", () => {
    assert.equal(isVideoDurationSupported(dolaConfig("Doubao-Seedance-2.5"), 30), true);
});

test("时长文案保留 30 秒，不被 15 秒上限截断", () => {
    assert.equal(resolveDolaSecondsLabel("30", dolaConfig("Doubao-Seedance-2.5")), "30s");
    assert.equal(resolveDolaSecondsLabel("30", dolaConfig("Doubao-Seedance-2.0")), "15s");
});

test("比例只接受 Dola 页面标签", () => {
    assert.equal(supportsDolaRatio("16:9"), true);
    assert.equal(supportsDolaRatio("3:4"), true);
    assert.equal(supportsDolaRatio("21:9"), false);
    assert.equal(supportsDolaRatio("adaptive"), false);
});
