import { requestCreditCost } from "@/features/generation/constants/credit-calculation";
import { agnesVideoRatioOptions, isAgnesVideoConfig, normalizeAgnesVideoRatio } from "@/features/generation/lib/agnes-video";
import { autoDlVideoResolutions, isAutoDlComfyUiVideoConfig, normalizeAutoDlVideoRatio } from "@/features/generation/lib/autodl-comfyui-video";
import { DOLA_RATIO_LABELS, isDolaVideoConfig } from "@/features/generation/lib/dola-video";
import { isMiniMaxH3VideoConfig, miniMaxH3ResolutionOptions, normalizeMiniMaxH3Ratio } from "@/features/generation/lib/minimax-h3-video";
import { isMuseVideoConfig } from "@/features/generation/lib/muse-video";
import { isSeedanceVideoConfig, normalizeSeedanceRatio, seedanceSupportedResolutions } from "@/features/generation/lib/seedance-video";
import { availableVideoModelsForMode, availableVideoResolutions, quoteVideoGeneration, videoGenerationReferenceIssue } from "@/features/generation/lib/video-billing";
import { resolveVideoResolution } from "@/features/settings/lib/video-resolution-configuration";
import { isVideoDurationSupported, readVideoDurationRange } from "@/features/generation/lib/video-duration";
import { modelOptionName, selectableModelsByCapability, type AiConfig } from "@/features/settings/stores/use-config-store";
import { resolveCommerceImageGenerationMode, type CommerceImageGenerationMode } from "./image-generation-mode";

export type CommerceTaskType = "text" | "image" | "video";

export type CommerceGenerationInput = {
    taskType: CommerceTaskType;
    model?: string;
    size?: string;
    resolution?: string;
    quality?: string;
    seconds?: string | number;
    /** Number of images in this request. Video tasks produce one video. */
    count?: string | number;
    imageReferenceCount?: number;
    imageGenerationMode?: CommerceImageGenerationMode;
};

export type CommerceGenerationQuote = {
    available: boolean;
    credits?: number;
    label: string;
    reason?: string;
};

export type CommerceGenerationSettings = {
    taskType: CommerceTaskType;
    model: string;
    modelOptions: string[];
    parameters: Record<string, unknown>;
    videoGenerationMode?: "image-to-video";
    imageGenerationMode?: CommerceImageGenerationMode;
    durationOptions: number[];
    resolutionOptions: string[];
    /** Ratios for the picker; generic video parameters.size is converted to pixels. */
    sizeOptions: string[];
    /** Selected picker value, independent of the provider's pixel-size parameter. */
    selectedSizeRatio: string;
    quote: CommerceGenerationQuote;
    /** Empty when submission is allowed. Missing materials do not suppress price previews. */
    issue: string;
};

const IMAGE_SIZES = ["1:1", "1:2", "2:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "9:21"];
const IMAGE_RESOLUTIONS = ["1K", "2K", "4K"];
const VIDEO_SIZES = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const GENERIC_VIDEO_SIZES: Record<string, string> = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "720x720",
    "4:3": "960x720",
    "3:4": "720x960",
    "21:9": "1680x720",
    adaptive: "auto",
};

/** Resolve a request snapshot without changing shared model settings or sending a task. */
export function resolveCommerceGenerationSettings(config: AiConfig, input: CommerceGenerationInput): CommerceGenerationSettings {
    const imageGenerationMode = input.taskType === "image" ? resolveCommerceImageGenerationMode(input.imageGenerationMode, input.imageReferenceCount || 0) : undefined;
    const modelOptions =
        input.taskType === "video"
            ? availableVideoModelsForMode(config, "image-to-video")
            : selectableModelsByCapability(config, input.taskType).filter((model) => {
                  if (!imageGenerationMode) return true;
                  const capabilities = config.modelCapabilities.find((item) => item.model === model)?.capabilities || [];
                  return !capabilities.some((capability) => capability === "text-to-image" || capability === "image-to-image") || capabilities.includes(imageGenerationMode);
              });
    const preferred = input.taskType === "text" ? config.textModel : input.taskType === "image" ? config.imageModel : config.videoModel;
    const model = [input.model, preferred].find((value): value is string => Boolean(value && modelOptions.includes(value))) || modelOptions[0] || "";
    const base: CommerceGenerationSettings = {
        taskType: input.taskType,
        model,
        modelOptions,
        parameters: {},
        ...(imageGenerationMode ? { imageGenerationMode } : {}),
        durationOptions: [],
        resolutionOptions: [],
        sizeOptions: [],
        selectedSizeRatio: "",
        quote: unavailableQuote("请选择可用模型"),
        issue: "",
    };
    if (!model) {
        const reason = input.taskType === "video" ? "暂无已配置图生视频能力和价格的模型" : input.taskType === "image" ? `暂无可用的${imageGenerationMode === "text-to-image" ? "文生图" : "图生图"}模型` : "暂无可用的文本模型";
        return { ...base, quote: unavailableQuote(reason), issue: reason };
    }
    if (input.taskType === "text") return { ...base, quote: { available: true, label: "按实际文本用量计费" } };
    if (input.taskType === "image") return resolveImageSettings(config, input, base);
    return resolveVideoSettings(config, input, base);
}

function resolveImageSettings(config: AiConfig, input: CommerceGenerationInput, base: CommerceGenerationSettings): CommerceGenerationSettings {
    const imageGenerationMode = resolveCommerceImageGenerationMode(input.imageGenerationMode, input.imageReferenceCount || 0);
    const count = Math.max(1, Math.min(4, Math.floor(Math.abs(Number(input.count ?? 1)) || 1)));
    const quality = selectValue(["low", "medium", "high"], input.quality ?? config.quality, "medium");
    const resolution = selectValue(IMAGE_RESOLUTIONS, (input.resolution ?? config.imageResolution).toUpperCase(), "2K");
    const size = closestRatio(input.size ?? config.size, IMAGE_SIZES, "1:1");
    const price = config.modelCosts.find((item) => item.model === base.model && item.taskType === "image");
    const validPrice = price && Number.isSafeInteger(price.credits) && price.credits >= 0;
    const credits = validPrice ? requestCreditCost({ modelCosts: config.modelCosts, model: base.model, taskType: "image", count }) : undefined;
    const quote = credits !== undefined && Number.isSafeInteger(credits) ? creditsQuote(credits) : unavailableQuote("当前图片模型未配置有效价格");
    const materialIssue = imageGenerationMode === "image-to-image" && (input.imageReferenceCount || 0) < 1 ? "图生图请至少上传一张商品参考图，以保持商品形象一致" : "";
    return {
        ...base,
        imageGenerationMode,
        parameters: { count, quality, resolution, size },
        resolutionOptions: [...IMAGE_RESOLUTIONS],
        sizeOptions: [...IMAGE_SIZES],
        selectedSizeRatio: size,
        quote,
        issue: quote.reason || materialIssue,
    };
}

function resolveVideoSettings(config: AiConfig, input: CommerceGenerationInput, base: CommerceGenerationSettings): CommerceGenerationSettings {
    // Both fields must point at this video model: provider helpers inspect either one.
    const selected = { ...config, model: base.model, videoModel: base.model, videoGenerationMode: "image-to-video" as const };
    const dola = isDolaVideoConfig(selected);
    const muse = isMuseVideoConfig(selected);
    const autoDl = isAutoDlComfyUiVideoConfig(selected);
    const agnes = isAgnesVideoConfig(selected);
    const miniMax = isMiniMaxH3VideoConfig(selected);
    // Dola model names contain Seedance, but Dola has its own protocol constraints.
    const seedance = !dola && !muse && isSeedanceVideoConfig(selected);
    const providerResolutions: readonly string[] | null = autoDl ? [...autoDlVideoResolutions] : miniMax ? miniMaxH3ResolutionOptions : agnes ? ["480p", "720p", "1080p"] : seedance ? seedanceSupportedResolutions(modelOptionName(base.model)) : null;
    const resolutionOptions = availableVideoResolutions(config, base.model, "image-to-video").filter((value) => !providerResolutions || providerResolutions.includes(value));
    const requestedResolution = input.resolution ?? (base.model === config.videoModel ? config.vquality : "");
    const resolution = resolveVideoResolution(config, base.model, "image-to-video", normalizeVideoResolution(requestedResolution), resolutionOptions);
    const videoConfig = { ...selected, vquality: resolution };
    const range = readVideoDurationRange(videoConfig);
    const minimum = config.videoModelBillingConfigurations.find((item) => item.model === base.model)?.videoBillingConfiguration?.minimumDurationSeconds;
    const validMinimum = typeof minimum === "number" && Number.isSafeInteger(minimum) && minimum > 0;
    const durationOptions = validMinimum ? Array.from({ length: Math.max(0, range.max - range.min + 1) }, (_, index) => range.min + index).filter((seconds) => seconds >= minimum && isVideoDurationSupported(videoConfig, seconds)) : [];
    const requestedSeconds = Number(input.seconds ?? config.videoSeconds);
    const seconds = durationOptions.length ? durationOptions.reduce((best, value) => (Number.isFinite(requestedSeconds) && Math.abs(value - requestedSeconds) < Math.abs(best - requestedSeconds) ? value : best)) : undefined;
    const sizeOptions = autoDl ? ["16:9", "9:16"] : dola ? [...DOLA_RATIO_LABELS] : agnes ? agnesVideoRatioOptions.map((item) => item.value) : muse ? [...VIDEO_SIZES] : [...VIDEO_SIZES, "adaptive"];
    const requestedSize = input.size ?? config.size;
    const ratio = autoDl
        ? normalizeAutoDlVideoRatio(requestedSize)
        : agnes
          ? normalizeAgnesVideoRatio(requestedSize)
          : miniMax
            ? normalizeMiniMaxH3Ratio(requestedSize)
            : seedance
              ? normalizeSeedanceRatio(requestedSize)
              : closestRatio(requestedSize, sizeOptions, "16:9");
    const size = dola || muse || autoDl || agnes || miniMax || seedance ? ratio : GENERIC_VIDEO_SIZES[ratio];
    const parameterIssue = !resolutionOptions.length ? "当前模型没有可用的视频分辨率价格" : !validMinimum ? "当前模型的最短视频时长配置无效" : !durationOptions.length ? "模型支持的时长与最短计费时长不兼容" : "";
    const quote = parameterIssue ? unavailableQuote(parameterIssue) : videoQuote(config, base.model, resolution, seconds!);
    const materialIssue = videoGenerationReferenceIssue("image-to-video", input.imageReferenceCount || 0, 0);
    return {
        ...base,
        videoGenerationMode: "image-to-video",
        durationOptions,
        resolutionOptions,
        sizeOptions,
        selectedSizeRatio: ratio,
        parameters: parameterIssue ? {} : { seconds: String(seconds), size, resolution, watermark: false },
        quote,
        issue: quote.reason || materialIssue,
    };
}

function videoQuote(config: AiConfig, model: string, resolution: string, seconds: number): CommerceGenerationQuote {
    const quote = quoteVideoGeneration({ config, model, mode: "image-to-video", resolution, seconds, requireReferences: false });
    return quote.available ? creditsQuote(quote.credits) : unavailableQuote(quote.reason);
}

function creditsQuote(credits: number): CommerceGenerationQuote {
    return { available: true, credits, label: `预计 ${credits} 积分` };
}

function unavailableQuote(reason: string): CommerceGenerationQuote {
    return { available: false, label: "暂无报价", reason };
}

function selectValue(options: readonly string[], requested: string | undefined, fallback: string): string {
    return requested && options.includes(requested) ? requested : options.includes(fallback) ? fallback : options[0] || "";
}

function normalizeVideoResolution(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "2160p") return "4k";
    return /^(480|720|768|1080)$/.test(normalized) ? `${normalized}p` : normalized;
}

function closestRatio(value: string, options: readonly string[], fallback: string): string {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
    if (options.includes(normalized)) return normalized;
    if (normalized === "auto" && options.includes("adaptive")) return "adaptive";
    const dimensions = normalized.match(/^(\d+(?:\.\d+)?)[x:](\d+(?:\.\d+)?)$/);
    if (!dimensions || Number(dimensions[1]) <= 0 || Number(dimensions[2]) <= 0) return fallback;
    const requested = Number(dimensions[1]) / Number(dimensions[2]);
    return options
        .filter((option) => option.includes(":"))
        .reduce((best, option) => {
            const distance = (ratio: string) => {
                const [width, height] = ratio.split(":").map(Number);
                return Math.abs(width / height - requested);
            };
            return distance(option) < distance(best) ? option : best;
        }, fallback);
}
