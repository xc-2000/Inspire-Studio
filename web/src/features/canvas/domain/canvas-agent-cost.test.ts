import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/features/settings/stores/use-config-store";
import { estimateCanvasAgentGenerationCosts } from "./canvas-agent-cost.ts";

test("a mixed batch uses each image model price and the actual video duration/count", () => {
    const video = { ...defaultConfig, model: "video", count: "2", videoSeconds: "8", vquality: "720p", videoGenerationMode: "text-to-video" as const, videoModelBillingConfigurations: [{ model: "video", capabilities: ["text-to-video" as const], videoBillingConfiguration: { billingUnit: "second" as const, minimumDurationSeconds: 3, modePrices: { "text-to-video": { "720p": 3 } } } }] };
    const estimate = estimateCanvasAgentGenerationCosts([
        { mode: "image", config: { ...defaultConfig, model: "image-a", count: "4", modelCosts: [{ model: "image-a", taskType: "image", credits: 5, unit: "generation" }] } },
        { mode: "image", config: { ...defaultConfig, model: "image-b", count: "2", modelCosts: [{ model: "image-b", taskType: "image", credits: 7, unit: "generation" }] } },
        { mode: "video", config: video },
        { mode: "text", config: { ...defaultConfig, model: "text" } },
    ]);
    assert.equal(estimate.credits, 20 + 14 + 48);
    assert.equal(estimate.tokenBilled, true);
    assert.equal(estimate.unavailable, 0);
    assert.match(estimate.text, /按实际 token 使用量计费/);
});

test("unknown prices remain unavailable and retry counts do not reuse batch counts", () => {
    const unknown = estimateCanvasAgentGenerationCosts([{ mode: "image", config: { ...defaultConfig, model: "missing" } }]);
    assert.equal(unknown.unavailable, 1);
    assert.match(unknown.text, /暂不可报价/);
    const retry = estimateCanvasAgentGenerationCosts([{ mode: "image", config: { ...defaultConfig, model: "image", count: "4", modelCosts: [{ model: "image", taskType: "image", credits: 5, unit: "generation" }] }, count: 1 }]);
    assert.equal(retry.credits, 5);
});
