import { readVideoDurationOptions } from "@/features/generation/lib/video-duration";
import type { AiConfig } from "@/features/settings/stores/use-config-store";

/** Prefer short legal shots; fixed/discrete providers must never receive invented intermediate seconds. */
export function selectDramaPlanningShotSeconds(supported: readonly number[]): number[] {
    const valid = [...new Set(supported.filter(seconds => Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 300))].sort((left, right) => left - right);
    const short = valid.filter(seconds => seconds <= 10);
    return short.length ? short : valid.length ? [valid[0]] : [];
}

export function readDramaPlanningShotSeconds(config: AiConfig): number[] {
    const model = config.videoModel;
    if (!model || !config.videoModels.includes(model)) return [];
    const videoConfig = { ...config, model, videoModel: model };
    const supported = readVideoDurationOptions(videoConfig);
    return selectDramaPlanningShotSeconds(supported);
}

export function dramaPlanningShotSecondsLabel(seconds: readonly number[]): string {
    if (!seconds.length) return "暂无可用镜长";
    if (seconds.length > 3 && seconds.every((value, index) => index === 0 || value === seconds[index - 1] + 1)) return `${seconds[0]}–${seconds[seconds.length - 1]} 秒`;
    return `${seconds.join(" / ")} 秒`;
}
