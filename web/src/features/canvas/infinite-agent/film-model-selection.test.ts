import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, type AiConfig } from "@/features/settings/stores/use-config-store";
import { applyFilmModels, defaultFilmModels, filmModelSelectionError } from "./film-model-selection";
import { resolveOneSentenceFilmRequest } from "./one-sentence-film";

const config: AiConfig = {
    ...defaultConfig, agentModel: "text-a", imageModel: "image-a", videoModel: "video-a", audioModel: "audio-a", vquality: "1080p",
    textModels: ["text-a", "text-b"], imageModels: ["image-a", "image-b"], videoModels: ["video-a", "video-b"], audioModels: ["audio-a", "audio-b"],
    videoModelBillingConfigurations: ["video-a", "video-b"].map(model => ({
        model, capabilities: ["image-to-video"], videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: 1, defaultResolution: "720p", modePrices: { "image-to-video": { "720p": 10 } } },
    })),
};
const selected = { textModel: "text-b", imageModel: "image-b", videoModel: "video-b", audioModel: "audio-b" };

test("per-film choices override the three models while speech stays disabled without mutating defaults", () => {
    assert.equal(filmModelSelectionError(config, selected), undefined);
    const run = applyFilmModels(config, selected);
    assert.deepEqual([run.agentModel, run.textModel, run.imageModel, run.videoModel, run.audioModel], ["text-b", "text-b", "image-b", "video-b", ""]);
    assert.equal("audioModel" in defaultFilmModels(config), false);
    assert.equal(config.audioModel, "audio-a");
    assert.equal(run.vquality, "720p");
    assert.equal(run.videoGenerationMode, "image-to-video");
    assert.equal(config.videoModel, "video-a");
    assert.equal(config.vquality, "1080p");
});
test("disabled, wrong-category and text-only video choices are rejected before generation", () => {
    assert.match(filmModelSelectionError(config, { ...selected, imageModel: "video-b" })!, /图像/);
    assert.equal(filmModelSelectionError({ ...config, audioModels: [] }, selected), undefined);
    assert.match(filmModelSelectionError({ ...config, videoModelBillingConfigurations: [] }, selected)!, /图生视频/);
    assert.equal(defaultFilmModels({ ...config, agentModel: "disabled" }).textModel, "text-a");
});
test("legacy saved speech choices cannot reactivate voiceover", () => {
    assert.equal(applyFilmModels(config, selected).audioModel, "");
});
test("film continuation retains the chosen models after serialization and global default changes", () => {
    const request = resolveOneSentenceFilmRequest("【一句话成片】一场雨夜追逐")!;
    request.film.models = selected;
    const resumed = resolveOneSentenceFilmRequest("继续成片", JSON.parse(JSON.stringify(request.film)))!;
    assert.equal(resumed.resume, true);
    assert.deepEqual(resumed.film.models, selected);
    assert.equal(applyFilmModels({ ...config, videoModel: "video-a" }, resumed.film.models!).videoModel, "video-b");
    assert.equal(applyFilmModels(config, resumed.film.models!).audioModel, "");
});
