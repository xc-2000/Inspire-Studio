import { agnesVideoMaxSeconds, isAgnesVideoConfig } from "./agnes-video";
import { isAutoDlComfyUiVideoConfig } from "./autodl-comfyui-video";
import { dolaDurationOptions, dolaDurationRange, isDolaVideoConfig } from "./dola-video";
import { isMiniMaxH3VideoConfig } from "./minimax-h3-video";
import { isMuseVideoConfig, MUSE_VIDEO_DURATION_SECONDS } from "./muse-video";
import { isSeedanceVideoConfig, seedanceDurationRange } from "./seedance-video";
import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/features/settings/stores/use-config-store";
import { readConfiguredVideoDurations, nearestVideoDuration } from "@/features/settings/lib/video-duration-configuration";

export { readConfiguredVideoDurations, nearestVideoDuration };

export type VideoDurationRange = {
    min: number;
    max: number;
};

/**
 * 读取当前视频模型支持的生成时长范围。
 */
export function readVideoDurationRange(config: AiConfig): VideoDurationRange {
    const configured = readConfiguredVideoDurations(config);
    if (configured.length) return { min: configured[0], max: configured[configured.length - 1] };
    const resolvedConfig = resolveModelRequestConfig(config, config.videoModel || config.model);
    const model = modelOptionName(resolvedConfig.videoModel || resolvedConfig.model);
    if (isMuseVideoConfig(resolvedConfig)) return { min: MUSE_VIDEO_DURATION_SECONDS, max: MUSE_VIDEO_DURATION_SECONDS };
    if (/^veo-3(?:[.-]|$)/i.test(model)) return { min: 4, max: 8 };
    // Dola 必须优先判断：其模型名同样含有 seedance，会命中下面的 Seedance 分支。
    if (isDolaVideoConfig(resolvedConfig)) return dolaDurationRange(model);
    if (isSeedanceVideoConfig(resolvedConfig)) return seedanceDurationRange(model);
    if (isMiniMaxH3VideoConfig(resolvedConfig)) return { min: 4, max: 15 };
    if (isAutoDlComfyUiVideoConfig(resolvedConfig)) return { min: 1, max: 15 };
    if (isAgnesVideoConfig(resolvedConfig)) return { min: 1, max: Math.min(15, Math.floor(agnesVideoMaxSeconds(resolvedConfig.vquality))) };
    return { min: 1, max: 15 };
}

/**
 * 判断镜头时长是否被当前视频模型支持。
 */
export function isVideoDurationSupported(config: AiConfig, durationSeconds: number): boolean {
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1) return false;
    const configured = readConfiguredVideoDurations(config);
    if (configured.length) return configured.includes(durationSeconds);
    const resolvedConfig = resolveModelRequestConfig(config, config.videoModel || config.model);
    if (isMuseVideoConfig(resolvedConfig)) return durationSeconds === MUSE_VIDEO_DURATION_SECONDS;
    if (/^veo-3(?:[.-]|$)/i.test(modelOptionName(resolvedConfig.videoModel || resolvedConfig.model))) return [4, 6, 8].includes(durationSeconds);
    if (isDolaVideoConfig(resolvedConfig)) {
        // Dola 只接受离散时长，范围判断会把 11 秒这类非法值放行。
        return dolaDurationOptions(modelOptionName(resolvedConfig.videoModel || resolvedConfig.model)).includes(durationSeconds);
    }
    const range = readVideoDurationRange(config);
    return durationSeconds >= range.min && durationSeconds <= range.max;
}

/** 供生成面板、Agent 和短剧编排共用的完整合法档位。 */
export function readVideoDurationOptions(config: AiConfig): number[] {
    const range = readVideoDurationRange(config);
    const minimum = config.videoModelBillingConfigurations?.find(item => item.model === (config.videoModel || config.model))?.videoBillingConfiguration?.minimumDurationSeconds || 1;
    return Array.from({ length: Math.max(0, Math.min(300, range.max) - range.min + 1) }, (_, index) => range.min + index)
        .filter(seconds => seconds >= minimum && isVideoDurationSupported(config, seconds));
}
