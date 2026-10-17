import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { requestCreditCost } from "@/features/generation/constants/credit-calculation";
import { quoteVideoGeneration } from "@/features/generation/lib/video-billing";
import type { CanvasGenerationMode } from "../types.ts";

export function estimateCanvasAgentGenerationCosts(items: Array<{ mode: CanvasGenerationMode; config: AiConfig; count?: number }>) {
    let credits = 0;
    let unavailable = 0;
    let tokenBilled = false;
    const lines = items.map(({ mode, config, count: forcedCount }) => {
        const count = forcedCount ?? Math.max(1, Math.floor(Number(config.count) || 1));
        const description = `${mode === "image" ? "图片" : mode === "video" ? "视频" : "文本"} · ${config.model} × ${count}`;
        if (mode === "text") {
            tokenBilled = true;
            return `${description}：按实际 token 使用量计费`;
        }
        if (mode === "video") {
            const quote = quoteVideoGeneration({ config, model: config.model, mode: config.videoGenerationMode, resolution: config.vquality, seconds: config.videoSeconds, taskCount: count, requireReferences: false });
            if (!quote.available) { unavailable++; return `${description}：暂不可报价（${quote.reason}）`; }
            credits += quote.credits;
            return `${description} · ${config.videoSeconds} 秒 · ${config.vquality}：${quote.credits.toLocaleString()} 积分`;
        }
        if (!config.modelCosts.some((cost) => cost.model === config.model && cost.taskType === "image")) {
            unavailable++;
            return `${description}：暂不可报价（未配置图片积分单价）`;
        }
        const cost = requestCreditCost({ modelCosts: config.modelCosts, model: config.model, taskType: "image", count });
        credits += cost;
        return `${description}：${cost.toLocaleString()} 积分`;
    });
    const summary = `${tokenBilled || unavailable ? "可报价部分" : "预计"}合计 ${credits.toLocaleString()} 积分${tokenBilled ? "，另加文本实际用量" : ""}${unavailable ? `，${unavailable} 项待报价` : ""}。最终按实际执行结算。`;
    return { credits, unavailable, tokenBilled, text: [...lines, summary].join("\n") };
}
