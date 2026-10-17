import assert from "node:assert/strict";
import test from "node:test";
import { availableChannelModels } from "./model-availability.ts";
import { configFromModelConfigs, createModelChannel, modelOptionsFromChannels, modelOptionLabel, modelOptionAdminLabel, modelOptionLabelWithRealName } from "../stores/use-config-store.ts";
import type { ServerModelConfig } from "@/services/api/server";

test("disabled gateway models are hidden, empty availability never falls back to configured models", () => {
    assert.deepEqual(availableChannelModels({ models: ["off", "on"], availableModels: ["on", "unknown"] }), ["on"]);
    assert.deepEqual(availableChannelModels({ models: ["off"], availableModels: [] }), []);
    assert.deepEqual(availableChannelModels({ models: ["direct"] }), ["direct"]);
});

test("admin dropdowns hide disabled defaults and restore prices and selection after enabling", () => {
    const channel = createModelChannel({ id: "gateway", models: ["image", "video", "text", "active"], availableModels: ["active"] });
    const saved = ["image", "video", "text"].map((type) => ({ id: type, channelId: "gateway", modelName: type,
        modelType: type, defaultModel: true, creditCost: 10, capabilities: [] } as unknown as ServerModelConfig));
    const snapshot = JSON.stringify(saved);
    const disabled = configFromModelConfigs([channel], saved);
    assert.deepEqual(modelOptionsFromChannels([channel]), ["gateway::active"]);
    for (const type of ["image", "video", "text"] as const) {
        assert.deepEqual(disabled[`${type}Models`], []);
        assert.equal(disabled[`${type}Model`], "");
    }
    assert.equal(disabled.agentModel, "");
    const enabled = configFromModelConfigs([{ ...channel, availableModels: channel.models }], saved);
    assert.equal(enabled.videoModel, "gateway::video");
    assert.equal(enabled.agentModel, "gateway::text");
    assert.equal(enabled.modelCosts.find((item) => item.model === "gateway::video")?.credits, 10);
    assert.equal(JSON.stringify(saved), snapshot);
});

test("a disabled explicit default does not silently switch to a different same-name channel", () => {
    const channels = [createModelChannel({ id: "primary", models: ["same"], availableModels: [] }),
        createModelChannel({ id: "backup", models: ["same"] })];
    const saved = channels.map((channel, i) => ({ id: channel.id, channelId: channel.id, modelName: "same",
        modelType: "video", defaultModel: i === 0, capabilities: [] } as unknown as ServerModelConfig));
    const config = configFromModelConfigs(channels, saved);
    assert.deepEqual(config.videoModels, ["backup::same"]);
    assert.equal(config.videoModel, "");
});

test("user labels omit channels while admin labels retain the active supplier and aliases", () => {
    const channel = createModelChannel({ id: "gateway", name: "New API · video", models: ["grok-video", "h3"],
        modelChannelNames: { "grok-video": "arcads", h3: "original" } });
    const config = configFromModelConfigs([channel], []);
    assert.equal(modelOptionLabel(config, "gateway::grok-video"), "grok-video");
    assert.equal(modelOptionLabel(config, "gateway::h3"), "h3");
    assert.equal(modelOptionAdminLabel(config, "gateway::grok-video"), "grok-video（arcads）");
    assert.equal(modelOptionAdminLabel(config, "gateway::h3"), "h3（original）");
    assert.equal(modelOptionLabelWithRealName(config, "gateway::grok-video"), "grok-video（arcads）");
    config.modelDisplayNames["gateway::grok-video"] = "Grok Video";
    assert.equal(modelOptionLabel(config, "gateway::grok-video"), "Grok Video");
    config.channels[0].modelChannelNames!["grok-video"] = "renamed";
    assert.equal(modelOptionLabelWithRealName(config, "gateway::grok-video"), "（Grok Video）grok-video（renamed）");
    assert.deepEqual(config.models, ["gateway::grok-video", "gateway::h3"]);
});
