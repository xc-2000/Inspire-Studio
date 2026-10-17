import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, useConfigStore, type AiConfig } from "../../settings/stores/use-config-store.ts";
import { isVideoDurationSupported, readVideoDurationRange, readVideoDurationOptions } from "./video-duration.ts";

function videoConfig(model: string): AiConfig {
    const value = `lumina::${model}`;
    return {
        ...defaultConfig,
        model: value,
        videoModel: value,
        videoModels: [value],
        channels: [{
            id: "lumina",
            name: "Lumina 视频",
            baseUrl: "http://192.0.2.20:8788/openai/v1",
            apiKey: "test-key",
            apiFormat: "openai-video-json",
            models: [model],
        }],
    };
}

test("Seedance 2.0 Mini 视频时长最多为 8 秒", () => {
    assert.deepEqual(readVideoDurationRange(videoConfig("Doubao-Seedance-2.0-mini")), { min: 4, max: 8 });
});

test("Veo 3.1 uses provider catalog discrete durations, not every integer between 4 and 8", () => {
    for (const model of ["veo-3.1-lite-generate-preview", "veo-3.1-fast-generate-preview"]) {
        const config = videoConfig(model);
        assert.deepEqual(readVideoDurationRange(config), { min: 4, max: 8 });
        assert.deepEqual([3,4,5,6,7,8,10].filter(seconds => isVideoDurationSupported(config, seconds)), [4,6,8]);
    }
});

test("其他 Seedance 视频模型保持 15 秒上限", () => {
    assert.deepEqual(readVideoDurationRange(videoConfig("Doubao-Seedance-2.0-pro-fast")), { min: 4, max: 15 });
});

test("Seedance 2.5 支持最长 30 秒", () => {
    assert.deepEqual(readVideoDurationRange(videoConfig("Doubao-Seedance-2.5")), { min: 4, max: 30 });
});

test("Seedance 1.x 和专用图生视频模型使用各自时长范围", () => {
    assert.deepEqual(readVideoDurationRange(videoConfig("ByteDance-Seedance-1.5-pro")), { min: 4, max: 12 });
    assert.deepEqual(readVideoDurationRange(videoConfig("ByteDance-Seedance-1.0-pro-fast")), { min: 2, max: 12 });
    assert.deepEqual(readVideoDurationRange(videoConfig("seedance_i2v_pro_com")), { min: 3, max: 12 });
});

test("Muse 视频时长仅允许 10 秒", () => {
    const config = {
        ...defaultConfig,
        model: "muse::sora-2",
        videoModel: "muse::sora-2",
        videoModels: ["sora-2"],
        channels: [{
            id: "muse",
            name: "Muse 视频",
            baseUrl: "https://muse.example/v1",
            apiKey: "test-key",
            apiFormat: "muse" as const,
            models: ["sora-2"],
        }],
    } satisfies AiConfig;

    assert.deepEqual(readVideoDurationRange(config), { min: 10, max: 10 });
    assert.equal(isVideoDurationSupported(config, 10), true);
    assert.equal(isVideoDurationSupported(config, 8), false);
    assert.equal(isVideoDurationSupported(config, 12), false);
});


test("configured duration overrides aliases and stays scoped to the channel", () => {
    const config = videoConfig("doubao-video-2.5");
    config.videoModelBillingConfigurations = [{ model: config.videoModel, capabilities: ["text-to-video"], videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: 3, modePrices: {}, supportedDurationsSeconds: [30] } }];
    assert.deepEqual(readVideoDurationRange(config), { min: 30, max: 30 });
    assert.deepEqual(readVideoDurationOptions(config), [30]);
    assert.equal(isVideoDurationSupported(config, 15), false);
    assert.equal(isVideoDurationSupported(config, 30), true);
    assert.deepEqual(readVideoDurationOptions({ ...config, videoModel: "another::doubao-video-2.5", model: "another::doubao-video-2.5" }), Array.from({length: 15}, (_, i) => i + 1));
});

test("configured discrete durations reject intermediate seconds and preserve billing minimum", () => {
    const config = videoConfig("alias");
    config.videoModelBillingConfigurations = [{ model: config.videoModel, capabilities: [], videoBillingConfiguration: { billingUnit: "generation", minimumDurationSeconds: 6, modePrices: {}, supportedDurationsSeconds: [4, 8, 30, 8] } }];
    assert.deepEqual(readVideoDurationOptions(config), [8, 30]);
    assert.equal(isVideoDurationSupported(config, 15), false);
});


test("switching models normalizes fixed seconds before opening a settings panel", () => {
    const config = videoConfig("doubao-video-2.5");
    config.channels[0].models.push("doubao-video-2.0");
    config.videoModels.push("lumina::doubao-video-2.0");
    config.videoModelBillingConfigurations = [30, 15].map((seconds, i) => ({ model: config.videoModels[i], capabilities: ["text-to-video"], videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: seconds, supportedDurationsSeconds: [seconds], modePrices: { "text-to-video": { "720p": 10 } } } }));
    const previous = useConfigStore.getState().config;
    try {
        useConfigStore.setState({ config });
        useConfigStore.getState().updateConfig("videoModel", config.videoModels[0]);
        assert.equal(useConfigStore.getState().config.videoSeconds, "30");
        useConfigStore.getState().updateConfig("videoModel", config.videoModels[1]);
        assert.equal(useConfigStore.getState().config.videoSeconds, "15");
    } finally { useConfigStore.setState({ config: previous }); }
});
