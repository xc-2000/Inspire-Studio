import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, configFromModelConfigs, useConfigStore, type AiConfig } from "../stores/use-config-store";
import { configuredVideoResolutions, resolveVideoResolution } from "./video-resolution-configuration";

function sample(): AiConfig {
    return {
        ...defaultConfig,
        channels: [{ id: "a", name: "a", baseUrl: "", apiKey: "", apiFormat: "newapi", models: ["video"] }, { id: "b", name: "b", baseUrl: "", apiKey: "", apiFormat: "newapi", models: ["video"] }],
        videoModels: ["a::video", "b::video"], videoModel: "a::video", vquality: "720p",
        videoModelBillingConfigurations: ["a", "b"].map(id => ({
            model: id + "::video", capabilities: ["text-to-video", "image-to-video"],
            videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: 1, defaultResolution: id === "a" ? "1080p" : "480p",
                modePrices: { "text-to-video": { "480p": 0, "720p": 5, "1080p": 10 }, "image-to-video": { "480p": 1, "720p": 5 } } },
        })),
    };
}

test("model default, explicit override and mode fallback use priced resolutions", () => {
    const config = sample();
    assert.equal(resolveVideoResolution(config), "1080p");
    assert.equal(resolveVideoResolution(config, "b::video"), "480p");
    assert.equal(resolveVideoResolution(config, "a::video", "text-to-video", "720P"), "720p");
    assert.equal(resolveVideoResolution(config, "a::video", "text-to-video", "4k"), "1080p");
    assert.equal(resolveVideoResolution(config, "a::video", "image-to-video"), "720p");
    assert.deepEqual(configuredVideoResolutions(config.videoModelBillingConfigurations[0].videoBillingConfiguration, ["image-to-video"]), ["480p", "720p"]);
});

test("legacy configurations fall back to 720p, then the first priced resolution", () => {
    const config = sample();
    delete config.videoModelBillingConfigurations[0].videoBillingConfiguration!.defaultResolution;
    assert.equal(resolveVideoResolution(config), "720p");
    delete config.videoModelBillingConfigurations[0].videoBillingConfiguration!.modePrices["text-to-video"]!["720p"];
    assert.equal(resolveVideoResolution(config), "480p");
});

test("changing model applies its default and subsequent manual choices stay selected", () => {
    const before = useConfigStore.getState().config;
    try {
        useConfigStore.setState({ config: sample() });
        useConfigStore.getState().updateConfig("videoModel", "b::video");
        assert.equal(useConfigStore.getState().config.vquality, "480p");
        useConfigStore.getState().updateConfig("vquality", "720p");
        useConfigStore.getState().updateConfig("size", "16:9");
        assert.equal(useConfigStore.getState().config.vquality, "720p");
        useConfigStore.getState().updateConfig("videoModel", "a::video");
        assert.equal(useConfigStore.getState().config.vquality, "1080p");
    } finally {
        useConfigStore.setState({ config: before });
    }
});

test("server hydration and changed admin defaults reach the generation config", () => {
    const config = sample();
    const models = config.videoModelBillingConfigurations.map((entry, index) => ({
        id: String(index), channelId: index ? "b" : "a", modelName: "video", modelType: "video" as const,
        defaultModel: index === 0, capabilities: entry.capabilities, videoBillingConfiguration: entry.videoBillingConfiguration,
    }));
    assert.equal(configFromModelConfigs(config.channels, models as never).vquality, "1080p");
    const previous = { ...config, vquality: "720p", videoModelBillingConfigurations: [] };
    assert.equal(configFromModelConfigs(config.channels, models as never, previous).vquality, "1080p");
    assert.equal(configFromModelConfigs(config.channels, models as never, { ...previous, vquality: "480p" }).vquality, "480p");
});
