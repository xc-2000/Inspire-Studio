import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { isMuseVideoConfig, MUSE_VIDEO_DURATION_SECONDS } from "@/features/generation/lib/muse-video";
import { resolveVideoResolution } from "@/features/settings/lib/video-resolution-configuration";

/** Normalize fixed provider constraints before quoting, displaying or submitting a node. */
export function normalizeCanvasVideoConfig(config: AiConfig): AiConfig {
    const vquality = config.vquality || resolveVideoResolution(config);
    const videoSeconds = isMuseVideoConfig(config) ? String(MUSE_VIDEO_DURATION_SECONDS) : config.videoSeconds;
    return vquality === config.vquality && videoSeconds === config.videoSeconds ? config : { ...config, vquality, videoSeconds };
}
