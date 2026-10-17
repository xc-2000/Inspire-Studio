import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { readVideoDurationOptions, readVideoDurationRange } from "@/features/generation/lib/video-duration";
import { readVideoModelBillingConfiguration } from "@/features/generation/lib/video-billing";

/** Constraints for the AI planner, not a default storyboard or duration distribution. */
export function readFilmPlanningConstraints(config: AiConfig) {
    const model = config.videoModel || config.model;
    const range = readVideoDurationRange({ ...config, model, videoModel: model });
    const configuredMinimum = readVideoModelBillingConfiguration(config, model)?.videoBillingConfiguration?.minimumDurationSeconds;
    const minimum = typeof configuredMinimum === "number" && Number.isSafeInteger(configuredMinimum) && configuredMinimum > 0 ? configuredMinimum : 1;
    const options = readVideoDurationOptions({ ...config, model, videoModel: model });
    const longest = options.at(-1) ?? null;
    return {
        strategy: "story-driven" as const,
        shotCount: { min: 1, max: 20 },
        totalDuration: "用户指定时长优先，否则由AI根据叙事、动作与对白自主决定",
        videoDuration: { ...range, min: Math.max(range.min, minimum), options },
        segmentPolicy: {
            durationScope: "one-generated-video" as const,
            preferredSeconds: longest,
            preference: "long-continuous-scene" as const,
            instruction: longest === null
                ? "当前模型暂无合法时长，先解决配置，不能提交生成。"
                : `当前单次最多支持 ${longest} 秒。由AI判断剧情能否在一次较长生成中连贯完成；优先把同一连续剧情的动作、对白和多个内部镜头合并到一个视频片段，优先考虑 ${longest} 秒。一次生成可包含多个内部镜头，不要把每个景别变化都拆成独立请求。只有明确转场、叙事节奏或用户时长要求需要时才拆段或选较短合法档位；这是编排偏好，不强制每段等长。收尾也由AI判断，剩余时长从合法options选择，不固定最后一段。不能用静止、重复动作或拉长停顿凑秒数。`,
        },
        durationNote: options.length === 1
            ? `当前渠道仅支持单次生成 ${options[0]} 秒，这是模型限制；按剧情决定片段数与内部镜头节奏，不得伪称支持其他生成秒数。`
            : "每次生成从options独立选择合适秒数，并遵循segmentPolicy优先保留较长连续剧情；页面手动生成的默认秒数不是成片片段的默认值。",
    };
}
