import type { AiConfig } from "../stores/use-config-store";

/** 使用完整渠道模型值匹配，避免不同渠道的同名模型串用时长。 */
export function readConfiguredVideoDurations(config: AiConfig, model = config.videoModel || config.model): number[] {
    const values = config.videoModelBillingConfigurations?.find(item => item.model === model)?.videoBillingConfiguration?.supportedDurationsSeconds;
    return [...new Set((values || []).filter(value => Number.isSafeInteger(value) && value > 0 && value <= 300))].sort((a, b) => a - b);
}

export function nearestVideoDuration(options: readonly number[], value: string | number): number {
    const requested = Number(value);
    return options.reduce((best, seconds) => Number.isFinite(requested) && Math.abs(seconds - requested) < Math.abs(best - requested) ? seconds : best, options[0] ?? 1);
}
