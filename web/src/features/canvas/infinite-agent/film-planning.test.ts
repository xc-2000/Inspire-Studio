import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, type AiConfig } from "@/features/settings/stores/use-config-store";
import { readFilmPlanningConstraints } from "./film-planning";

test("AI timing ignores manual 10-second defaults and honors configured minimum", () => {
    const config: AiConfig = { ...defaultConfig, videoModel: "video-model", videoSeconds: "10", videoModelBillingConfigurations: [{ model: "video-model", capabilities: ["image-to-video"], videoBillingConfiguration: { billingUnit: "generation", minimumDurationSeconds: 4, modePrices: { "image-to-video": { "720p": 1 } } } }] };
    assert.deepEqual(readFilmPlanningConstraints(config).videoDuration.options, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test("Dola discrete durations and Muse genuine 10-second limitation remain enforced", () => {
    const muse = readFilmPlanningConstraints({ ...defaultConfig, videoModel: "sora-2", apiFormat: "muse" });
    assert.deepEqual(muse.videoDuration.options, [10]);
    assert.match(muse.durationNote, /模型限制/);
    const dola = readFilmPlanningConstraints({ ...defaultConfig, videoModel: "seedance-2.5", apiFormat: "dola" });
    assert.deepEqual(dola.videoDuration.options, [10, 15, 30]);
});


test("AI planner follows configured fixed durations instead of manual defaults", () => {
    for (const seconds of [15, 30, 60]) {
        const config: AiConfig = { ...defaultConfig, videoModel: "gateway::alias", videoSeconds: "10", videoModelBillingConfigurations: [{ model: "gateway::alias", capabilities: ["text-to-video"], videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: seconds, supportedDurationsSeconds: [seconds], modePrices: { "text-to-video": { "720p": 10 } } } }] };
        const result = readFilmPlanningConstraints(config);
        assert.deepEqual(result.videoDuration, { min: seconds, max: seconds, options: [seconds] });
        assert.ok(result.durationNote.includes(String(seconds)));
    }
});


test("long clip preference follows actual supported options and ignores the last manual duration", () => {
    for (const durations of [[10, 15, 30], [15], [30], [15, 60], []]) {
        const config: AiConfig = { ...defaultConfig, videoModel: "video-model", videoSeconds: "10", videoModelBillingConfigurations: [{ model: "video-model", capabilities: ["image-to-video"], videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: durations.length ? 1 : 100, supportedDurationsSeconds: durations, modePrices: {} } }] };
        const result = readFilmPlanningConstraints(config);
        assert.deepEqual(result.videoDuration.options, durations);
        assert.equal(result.segmentPolicy.preferredSeconds, durations.at(-1) ?? null);
        assert.equal(result.segmentPolicy.durationScope, "one-generated-video");
        if (durations.length) assert.ok(result.segmentPolicy.instruction.includes(`${durations.at(-1)} 秒`));
    }
});
