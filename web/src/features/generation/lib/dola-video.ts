import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/features/settings/stores/use-config-store";

/**
 * Dola 渠道的模型参数约束。
 *
 * Dola 的上游接口固定只接受 10/15/30 三个时长，并且时长与模型强绑定：
 * seedance-2.0 只支持 10/15 秒，seedance-2.5 才支持 30 秒。
 * 清晰度没有任何接口参数（由上游页面按比例决定），因此界面只暴露实际可计价的一档。
 */

/** Dola 页面比例标签，超出这些取值的比例会被上游忽略。 */
export const DOLA_RATIO_LABELS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

/** seedance-2.0 支持的时长。 */
const DOLA_DURATIONS_20 = [10, 15] as const;

/** seedance-2.5 支持的时长。 */
const DOLA_DURATIONS_25 = [10, 15, 30] as const;

/** 判断当前视频配置是否指向 Dola 渠道。 */
export function isDolaVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "baseUrl" | "apiFormat">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return requestConfig.apiFormat === "dola";
}

/** 按 Dola 模型返回上游允许的离散时长，未知模型按最保守的 2.0 处理。 */
export function dolaDurationOptions(model: string): number[] {
    const name = String(model || "").trim().toLowerCase();
    if (name.includes("2.5") || name.includes("2-5") || name.includes("2_5")) return [...DOLA_DURATIONS_25];
    return [...DOLA_DURATIONS_20];
}

/** 返回 Dola 模型的时长范围，仅用于提交前校验与文案提示。 */
export function dolaDurationRange(model: string): { min: number; max: number } {
    const options = dolaDurationOptions(model);
    return { min: options[0], max: options[options.length - 1] };
}

/** 把任意时长吸附到最近的 Dola 允许取值上。 */
export function normalizeDolaDuration(value: string | number, model: string) {
    const options = dolaDurationOptions(model);
    const seconds = Math.floor(Number(value));
    if (!Number.isSafeInteger(seconds)) return options[0];
    return options.reduce((best, item) => (Math.abs(item - seconds) < Math.abs(best - seconds) ? item : best), options[0]);
}

/** 读取当前 Dola 模型的时长选项，供设置面板渲染离散按钮。 */
export function resolveDolaDurationOptions(config: AiConfig) {
    const resolved = resolveModelRequestConfig(config, config.videoModel || config.model);
    return dolaDurationOptions(modelOptionName(resolved.videoModel || resolved.model));
}

/** Dola 是否支持该比例标签。 */
export function supportsDolaRatio(ratio: string) {
    return (DOLA_RATIO_LABELS as readonly string[]).includes(ratio);
}

/** 按 Dola 允许的离散时长渲染时长文案，避免出现 11s 之类的非法值。 */
export function resolveDolaSecondsLabel(value: string | number, config: AiConfig) {
    const resolved = resolveModelRequestConfig(config, config.videoModel || config.model);
    return `${normalizeDolaDuration(value, modelOptionName(resolved.videoModel || resolved.model))}s`;
}
