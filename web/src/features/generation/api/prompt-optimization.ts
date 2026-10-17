import { cancelAiTask, createPromptOptimizationTask, waitAiTask, type PromptOptimizationType } from "@/services/api/server";
import { readOptimizedPrompt as readGuardedPrompt } from "@/features/generation/lib/prompt-optimization-guard";

/**
 * 使用服务端配置的默认文本模型优化图片或视频生成提示词。
 *
 * @param generationType 图片或视频生成类型
 * @param prompt 用户原始提示词
 * @param signal 请求取消信号
 * @returns 优化后的提示词
 */
export async function optimizeGenerationPrompt(generationType: PromptOptimizationType, prompt: string, generationStyleIdsOrSignal?: number[] | AbortSignal, signal?: AbortSignal) {
    const generationStyleIds = Array.isArray(generationStyleIdsOrSignal) ? generationStyleIdsOrSignal : undefined;
    const requestSignal = generationStyleIdsOrSignal instanceof AbortSignal ? generationStyleIdsOrSignal : signal;
    return runPromptOptimization({ generationType, prompt, ...(generationStyleIds?.length ? { generationStyleIds } : {}) }, requestSignal);
}

/** 为失败节点改写清晰、安全的提示词；不重新附加可能与改写结果冲突的风格。 */
export async function rewriteFailedGenerationPrompt(generationType: PromptOptimizationType, prompt: string, failureReason: string, signal?: AbortSignal) {
    return runPromptOptimization({ generationType, prompt, rewriteForRetry: true, failureReason: failureReason.slice(0, 2000) }, signal);
}

/** 改写当前镜头的视频提示词，并向文本模型提供限定的剧情衔接上下文。 */
export async function rewriteStoryboardVideoPrompt(prompt: string, failureReason: string, storyboardContext: string, signal?: AbortSignal) {
    return runPromptOptimization({ generationType: "video", prompt, rewriteForRetry: true, failureReason: failureReason.slice(0, 2000), storyboardContext }, signal);
}

async function runPromptOptimization(input: Parameters<typeof createPromptOptimizationTask>[0], requestSignal?: AbortSignal) {
    if (requestSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    const task = await createPromptOptimizationTask(input);
    if (requestSignal?.aborted) {
        void cancelAiTask(task.id).catch(() => {});
        throw new DOMException("Aborted", "AbortError");
    }
    const onAbort = () => { void cancelAiTask(task.id).catch(() => {}); };
    requestSignal?.addEventListener("abort", onAbort, { once: true });
    try {
        const completed = await waitAiTask(task.id, { signal: requestSignal, cancelOnAbort: false });
        if (requestSignal?.aborted) throw new DOMException("Aborted", "AbortError");
        const content = readOptimizedPrompt(completed.resultData);
        if (!content) throw new Error("AI 没有返回有效的优化提示词");
        return content;
    } finally {
        requestSignal?.removeEventListener("abort", onAbort);
    }
}

/**
 * 从文本任务结果中读取并清理优化后的提示词。
 *
 * 校验逻辑见 prompt-optimization-guard：模型返回聊天式回复时视为无效结果。
 *
 * @param resultData 文本任务结果
 * @returns 清理后的提示词，缺失或为对话式回复时返回空串
 */
export function readOptimizedPrompt(resultData: unknown) {
    return readGuardedPrompt(resultData);
}
