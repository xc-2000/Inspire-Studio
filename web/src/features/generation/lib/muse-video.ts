import { resolveModelRequestConfig, type AiConfig } from "@/features/settings/stores/use-config-store";

export const MUSE_VIDEO_DURATION_SECONDS = 10;

/** 判断视频请求是否使用 Muse 接口格式。 */
export function isMuseVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl" | "apiFormat">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.videoModel || config.model) : config;
    return requestConfig.apiFormat === "muse";
}

/** Muse 在项目中固定按约 10 秒请求。 */
export function normalizeMuseDuration(_value: string | number) {
    return MUSE_VIDEO_DURATION_SECONDS;
}
