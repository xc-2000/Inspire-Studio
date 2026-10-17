import assert from "node:assert/strict";
import test from "node:test";

import { reconcileModelConfigDraftIds, retainCapabilityModelDrafts } from "./model-config-draft-merge.ts";

test("editing visible selections preserves disabled model settings while removing a deselected active model", () => {
    const hidden = { id: "off", channelId: "gateway", modelName: "off", modelType: "video", defaultModel: true, creditCost: 10 };
    const visible = { ...hidden, id: "on", modelName: "on", defaultModel: false };
    const text = { ...hidden, id: "text", modelType: "text" };
    assert.deepEqual(retainCapabilityModelDrafts([hidden, visible, text], "video", [], ["gateway::on"]), [hidden]);
    assert.deepEqual(retainCapabilityModelDrafts([hidden, visible], "video", ["gateway::on"], ["gateway::on"]), [hidden, visible]);
});

test("重复模型草稿采用服务端 ID 并保留待保存修改", () => {
    const drafts = [
        {
            id: "temporary-id",
            channelId: "autodl-comfyui",
            modelName: "minimax_h3_zm_u24",
            modelType: "video",
            displayName: "新的显示名",
            creditCost: 12,
        },
    ];
    const persisted = [
        {
            id: "persisted-id",
            channelId: "autodl-comfyui",
            modelName: "minimax_h3_zm_u24",
            modelType: "video",
        },
    ];

    assert.deepEqual(reconcileModelConfigDraftIds(drafts, persisted), [
        {
            ...drafts[0],
            id: "persisted-id",
        },
    ]);
});

test("不同类型或工作流的模型草稿不会错误合并", () => {
    const drafts = [
        { id: "video-draft", channelId: "channel", modelName: "same-name", modelType: "video" },
        { id: "other-workflow", channelId: "channel", modelName: "other-name", modelType: "video" },
    ];
    const persisted = [{ id: "text-config", channelId: "channel", modelName: "same-name", modelType: "text" }];

    assert.deepEqual(reconcileModelConfigDraftIds(drafts, persisted), drafts);
});
