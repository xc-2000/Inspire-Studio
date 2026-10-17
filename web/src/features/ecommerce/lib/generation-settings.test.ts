import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, type AiConfig, type ApiCallFormat, type VideoBillingConfiguration } from "@/features/settings/stores/use-config-store";
import { resolveCommerceGenerationSettings } from "./generation-settings";

function configForVideo(apiFormat: ApiCallFormat = "muse", modelName = "sora-2", billing?: Partial<VideoBillingConfiguration>): AiConfig {
    const videoModel = `video::${modelName}`;
    return {
        ...defaultConfig,
        model: "image::image-model",
        imageModel: "image::image-model",
        imageModels: ["image::image-model"],
        textModel: "text::text-model",
        textModels: ["text::text-model"],
        videoModel,
        videoModels: [videoModel],
        channels: [
            { id: "image", name: "Image", apiFormat: "openai", baseUrl: "", apiKey: "", models: ["image-model"] },
            { id: "text", name: "Text", apiFormat: "openai", baseUrl: "", apiKey: "", models: ["text-model"] },
            { id: "video", name: "Video", apiFormat, baseUrl: "", apiKey: "", models: [modelName] },
        ],
        modelCosts: [{ model: "image::image-model", taskType: "image", credits: 7, unit: "generation" }],
        videoModelBillingConfigurations: [
            {
                model: videoModel,
                capabilities: ["image-to-video"],
                videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: 3, modePrices: { "image-to-video": { "720p": 2 } }, ...billing },
            },
        ],
    };
}

test("按输出能力选模型，不把全局图片模型用于文本或视频", () => {
    const config = configForVideo();
    assert.equal(resolveCommerceGenerationSettings(config, { taskType: "text" }).model, "text::text-model");
    assert.equal(resolveCommerceGenerationSettings(config, { taskType: "video", imageReferenceCount: 1 }).model, "video::sora-2");
    const image = resolveCommerceGenerationSettings(config, { taskType: "image", model: config.videoModel, count: 4, size: "9:16", resolution: "4k", imageReferenceCount: 1 });
    assert.equal(image.model, "image::image-model");
    assert.equal(image.parameters.resolution, "4K");
    assert.equal(image.parameters.size, "9:16");
    assert.equal(image.selectedSizeRatio, "9:16");
    assert.equal(image.quote.credits, 28);
    assert.equal(image.issue, "");
    assert.equal(config.model, "image::image-model");
    assert.equal(config.videoSeconds, "5");
});

test("Muse 只有10秒且报价与实际归一化参数一致", () => {
    const result = resolveCommerceGenerationSettings(configForVideo(), { taskType: "video", seconds: 5, size: "9:16", imageReferenceCount: 1 });
    assert.deepEqual(result.durationOptions, [10]);
    assert.deepEqual(result.parameters, { seconds: "10", size: "9:16", resolution: "720p", watermark: false });
    assert.equal(result.videoGenerationMode, "image-to-video");
    assert.equal(result.quote.credits, 20);
    assert.equal(result.issue, "");
    assert.equal(result.sizeOptions.includes("adaptive"), false);
});

test("Dola不误用Seedance连续时长或分辨率限制", () => {
    const config = configForVideo("dola", "seedance-2.5", { modePrices: { "image-to-video": { auto: 6 } } });
    const result = resolveCommerceGenerationSettings(config, { taskType: "video", seconds: 26, size: "21:9", imageReferenceCount: 1 });
    assert.deepEqual(result.durationOptions, [10, 15, 30]);
    assert.equal(result.parameters.seconds, "30");
    assert.deepEqual(result.resolutionOptions, ["auto"]);
    assert.equal(result.parameters.size, "16:9");
    assert.equal(result.quote.credits, 180);
    const two = resolveCommerceGenerationSettings(configForVideo("dola", "seedance-2.0"), { taskType: "video", seconds: 11, imageReferenceCount: 1 });
    assert.deepEqual(two.durationOptions, [10, 15]);
    assert.equal(two.parameters.seconds, "10");
});

test("Seedance Mini供应商约束与已配置价格取交集", () => {
    const config = configForVideo("openai-video-json", "Doubao-Seedance-2.0-mini", { modePrices: { "image-to-video": { "480p": 1, "720p": 2, "1080p": 3 } } });
    const result = resolveCommerceGenerationSettings(config, { taskType: "video", resolution: "1080p", seconds: 20, imageReferenceCount: 1 });
    assert.deepEqual(result.resolutionOptions, ["480p", "720p"]);
    assert.equal(result.parameters.resolution, "720p");
    assert.deepEqual(result.durationOptions, [4, 5, 6, 7, 8]);
    assert.equal(result.parameters.seconds, "8");
    assert.equal(result.quote.credits, 16);
});

test("通用视频比例转换为已有协议像素尺寸，MiniMax保留比例和专用分辨率", () => {
    const generic = resolveCommerceGenerationSettings(configForVideo("openai", "generic-video"), { taskType: "video", size: "9:16", imageReferenceCount: 1 });
    assert.equal(generic.parameters.size, "720x1280");
    assert.equal(generic.selectedSizeRatio, "9:16");
    assert.ok(generic.sizeOptions.includes(generic.selectedSizeRatio));
    const restored = resolveCommerceGenerationSettings(configForVideo("openai", "generic-video"), { taskType: "video", size: "1280x720", imageReferenceCount: 1 });
    assert.equal(restored.parameters.size, "1280x720");
    assert.equal(restored.selectedSizeRatio, "16:9");
    const miniMax = resolveCommerceGenerationSettings(configForVideo("minimax", "minimax-h3", { modePrices: { "image-to-video": { "720p": 1, "768p": 2, "2k": 4 } } }), { taskType: "video", size: "9:16", imageReferenceCount: 1 });
    assert.deepEqual(miniMax.resolutionOptions, ["768p", "2k"]);
    assert.equal(miniMax.parameters.resolution, "768p");
    assert.equal(miniMax.parameters.size, "9:16");
});

test("模型约束与管理员计费配置无交集时不可提交", () => {
    const muse = resolveCommerceGenerationSettings(configForVideo("muse", "sora-2", { minimumDurationSeconds: 11 }), { taskType: "video", imageReferenceCount: 1 });
    assert.deepEqual(muse.durationOptions, []);
    assert.deepEqual(muse.parameters, {});
    assert.equal(muse.quote.available, false);
    assert.match(muse.issue, /时长/);
    const autoDl = resolveCommerceGenerationSettings(configForVideo("autodl-comfyui", "workflow", { modePrices: { "image-to-video": { "4k": 1 } } }), { taskType: "video", imageReferenceCount: 1 });
    assert.deepEqual(autoDl.resolutionOptions, []);
    assert.deepEqual(autoDl.parameters, {});
    assert.equal(autoDl.quote.available, false);
});

test("缺商品图时可以预览费用但不能提交图生视频", () => {
    const result = resolveCommerceGenerationSettings(configForVideo(), { taskType: "video" });
    assert.equal(result.quote.available, true);
    assert.equal(result.quote.credits, 20);
    assert.match(result.issue, /至少需要一张图片/);
});

test("文生图无参考图可生成，输出数量及报价最多按4张计算", () => {
    const config = configForVideo();
    const missing = resolveCommerceGenerationSettings(config, { taskType: "image", count: 15 });
    assert.equal(missing.parameters.count, 4);
    assert.equal(missing.quote.available, true);
    assert.equal(missing.quote.credits, 28);
    assert.equal(missing.imageGenerationMode, "text-to-image");
    assert.equal(missing.issue, "");
    const ready = resolveCommerceGenerationSettings(config, { taskType: "image", count: 15, imageReferenceCount: 1 });
    assert.equal(ready.parameters.count, 4);
    assert.equal(ready.quote.credits, 28);
    assert.equal(ready.imageGenerationMode, "image-to-image");
    assert.equal(ready.issue, "");
});

test("显式文生图可保留商品图且模式只输出到请求顶层", () => {
    const config = configForVideo();
    const textToImage = resolveCommerceGenerationSettings(config, { taskType: "image", imageGenerationMode: "text-to-image", imageReferenceCount: 3 });
    const imageToImage = resolveCommerceGenerationSettings(config, { taskType: "image", imageGenerationMode: "image-to-image", imageReferenceCount: 3 });
    assert.equal(textToImage.imageGenerationMode, "text-to-image");
    assert.equal(textToImage.issue, "");
    assert.equal("imageGenerationMode" in textToImage.parameters, false);
    assert.deepEqual(textToImage.parameters, imageToImage.parameters);
    assert.deepEqual(textToImage.quote, imageToImage.quote);
    assert.equal(resolveCommerceGenerationSettings(config, { taskType: "text", imageGenerationMode: "text-to-image" }).imageGenerationMode, undefined);
    const video = resolveCommerceGenerationSettings(config, { taskType: "video", imageGenerationMode: "text-to-image" });
    assert.equal(video.imageGenerationMode, undefined);
    assert.match(video.issue, /至少需要一张图片/);
});

test("显式图生图缺图片时可预览报价但不能提交", () => {
    const result = resolveCommerceGenerationSettings(configForVideo(), { taskType: "image", imageGenerationMode: "image-to-image" });
    assert.equal(result.imageGenerationMode, "image-to-image");
    assert.equal(result.quote.available, true);
    assert.equal(result.quote.credits, 7);
    assert.match(result.issue, /图生图请至少上传一张商品参考图/);
});

test("图片模型声明生成模式时按当前模式筛选，切换后使用兼容模型", () => {
    const config = configForVideo();
    config.channels[0].models = ["image-model", "text-image-model"];
    config.imageModels.push("image::text-image-model");
    config.modelCosts.push({ model: "image::text-image-model", taskType: "image", credits: 9, unit: "generation" });
    config.modelCapabilities = [
        { model: "image::image-model", capabilities: ["image-to-image"] },
        { model: "image::text-image-model", capabilities: ["text-to-image"] },
    ];
    const textToImage = resolveCommerceGenerationSettings(config, { taskType: "image", model: config.imageModel, imageGenerationMode: "text-to-image" });
    assert.deepEqual(textToImage.modelOptions, ["image::text-image-model"]);
    assert.equal(textToImage.model, "image::text-image-model");
    assert.equal(textToImage.quote.credits, 9);
    const imageToImage = resolveCommerceGenerationSettings(config, { taskType: "image", model: textToImage.model, imageGenerationMode: "image-to-image", imageReferenceCount: 1 });
    assert.deepEqual(imageToImage.modelOptions, ["image::image-model"]);
    assert.equal(imageToImage.model, config.imageModel);
    assert.equal(imageToImage.issue, "");
    config.imageModels = ["image::image-model"];
    const unavailable = resolveCommerceGenerationSettings(config, { taskType: "image", imageGenerationMode: "text-to-image" });
    assert.equal(unavailable.model, "");
    assert.equal(unavailable.quote.available, false);
    assert.equal(unavailable.imageGenerationMode, "text-to-image");
    assert.match(unavailable.issue, /暂无可用的文生图模型/);
});

test("没有声明图片模式的旧模型继续可用，vision不能误判为不支持图片生成", () => {
    const config = configForVideo();
    for (const capabilities of [undefined, [], ["vision"], ["text-to-image", "image-to-image"]]) {
        config.modelCapabilities = capabilities ? [{ model: config.imageModel, capabilities }] : [];
        for (const imageGenerationMode of ["text-to-image", "image-to-image"] as const) {
            const result = resolveCommerceGenerationSettings(config, { taskType: "image", imageGenerationMode, imageReferenceCount: 1 });
            assert.equal(result.model, config.imageModel);
            assert.equal(result.issue, "");
        }
    }
});

test("图片缺价格和视频缺图生能力不能伪装为零积分可生成", () => {
    const config = configForVideo();
    config.modelCosts = [];
    const image = resolveCommerceGenerationSettings(config, { taskType: "image" });
    assert.equal(image.quote.available, false);
    assert.equal(image.quote.credits, undefined);
    assert.match(image.issue, /价格/);
    config.videoModelBillingConfigurations[0].capabilities = ["text-to-video"];
    const video = resolveCommerceGenerationSettings(config, { taskType: "video", imageReferenceCount: 1 });
    assert.equal(video.model, "");
    assert.deepEqual(video.modelOptions, []);
    assert.equal(video.quote.available, false);
});
