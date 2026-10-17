import type { AiConfig, VideoBillingConfiguration, VideoGenerationMode, VideoResolution } from "../stores/use-config-store";

export const CONFIGURABLE_VIDEO_RESOLUTIONS: VideoResolution[] = ["auto", "480p", "720p", "768p", "1080p", "2k", "4k"];

export function configuredVideoResolutions(configuration: VideoBillingConfiguration | null | undefined, modes: readonly string[]): VideoResolution[] {
    return CONFIGURABLE_VIDEO_RESOLUTIONS.filter(resolution => modes.some(mode => {
        const price = configuration?.modePrices?.[mode as VideoGenerationMode]?.[resolution];
        return Number.isSafeInteger(price) && (price as number) >= 0;
    }));
}

/** Match the full channel/model key. Keep an explicit supported selection; otherwise use the model default. */
export function resolveVideoResolution(config: AiConfig, model = config.videoModel || config.model, mode = config.videoGenerationMode, requested?: string, allowed?: readonly VideoResolution[]): VideoResolution {
    const entry = config.videoModelBillingConfigurations?.find(item => item.model === model);
    const configuration = entry?.videoBillingConfiguration;
    const available = allowed ?? configuredVideoResolutions(configuration, [mode]);
    const current = requested?.trim().toLowerCase() as VideoResolution | undefined;
    if (current && available.includes(current)) return current;
    const preferred = configuration?.defaultResolution;
    if (preferred && available.includes(preferred)) return preferred;
    if (available.includes("720p")) return "720p";
    // Older/unfinished configurations retain their explicit resolution, so validation can explain missing prices.
    return available[0] || (current && CONFIGURABLE_VIDEO_RESOLUTIONS.includes(current) ? current : "720p");
}
