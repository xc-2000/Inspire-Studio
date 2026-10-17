import { selectableModelsByCapability, type AiConfig } from "@/features/settings/stores/use-config-store";
import { availableVideoModelsForMode } from "@/features/generation/lib/video-billing";
import { resolveVideoResolution } from "@/features/settings/lib/video-resolution-configuration";

/** A per-film snapshot; never writes back to the user's global defaults. */
export type FilmModelSelection = {
    textModel: string;
    imageModel: string;
    videoModel: string;
};

export function defaultFilmModels(config: AiConfig): FilmModelSelection {
    const pick = (value: string, options: string[]) => options.includes(value) ? value : options[0] || "";
    return {
        textModel: pick(config.agentModel || config.textModel, selectableModelsByCapability(config, "text")),
        imageModel: pick(config.imageModel, selectableModelsByCapability(config, "image")),
        videoModel: pick(config.videoModel, availableVideoModelsForMode(config, "image-to-video")),
    };
}

export function filmModelSelectionError(config: AiConfig, models: FilmModelSelection): string | undefined {
    for (const [key, capability, label] of [
        ["textModel", "text", "文本"], ["imageModel", "image", "图像"], ["videoModel", "video", "视频"],
    ] as const) {
        if (!models[key] || !selectableModelsByCapability(config, capability).includes(models[key])) {
            return `请选择可用的${label}模型，原模型可能已被停用`;
        }
    }
    if (!availableVideoModelsForMode(config, "image-to-video").includes(models.videoModel)) return "请选择支持图生视频且已配置价格的视频模型";
}

export function applyFilmModels(config: AiConfig, models: FilmModelSelection): AiConfig {
    return {
        ...config, ...models, agentModel: models.textModel, audioModel: "",
        videoGenerationMode: "image-to-video",
        vquality: resolveVideoResolution(config, models.videoModel, "image-to-video"),
    };
}
