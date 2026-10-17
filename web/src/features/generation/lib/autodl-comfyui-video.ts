import { resolveModelRequestConfig, type AiConfig } from "@/features/settings/stores/use-config-store";

export const AUTO_DL_H3_WORKFLOW_ID = "minimax_h3_image_audio_to_video_v2_15s";

export type AutoDlVideoResolution = "480p" | "768p";
export type AutoDlVideoRatio = "16:9" | "9:16";

export const autoDlVideoResolutions = new Set<AutoDlVideoResolution>(["480p", "768p"]);

/** 判断当前视频模型是否为可配置的 AutoDL ComfyUI 工作流。 */
export function isAutoDlComfyUiVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl" | "apiFormat">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.videoModel || config.model) : config;
    return requestConfig.apiFormat === "autodl-comfyui";
}

/** AutoDL 当前工作流只提供 480p 和 768p。 */
export function normalizeAutoDlVideoResolution(value: string): AutoDlVideoResolution {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "480" || normalized === "480p" ? "480p" : "768p";
}

/** AutoDL 当前工作流只提供横屏和竖屏两个输出方向。 */
export function normalizeAutoDlVideoRatio(value: string): AutoDlVideoRatio {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
    const separator = normalized.includes(":") ? ":" : normalized.includes("x") ? "x" : "";
    if (!separator) return normalized === "16:9" ? "16:9" : "9:16";
    const [width, height] = normalized.split(separator).map(Number);
    return Number.isFinite(width) && Number.isFinite(height) && width >= height ? "16:9" : "9:16";
}

/** AutoDL 当前工作流支持 1 到 15 秒整数时长。 */
export function normalizeAutoDlVideoDuration(value: string | number) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return 5;
    return Math.max(1, Math.min(15, parsed));
}
