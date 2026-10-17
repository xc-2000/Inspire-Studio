import { cancelAiTask, createImagePromptReverseTask, waitAiTask, type ImagePromptReverseInput, type ServerAiTask } from "@/services/api/server";

export type ImagePromptReverseResult = {
    promptZh: string;
    promptEn: string;
    negativePrompt: string;
    style?: string;
};

const INVALID_RESULT_MESSAGE = "AI 没有返回有效的图片提示词，请更换模型后重试";

/** Only use structured prompt fields: error messages and conversational replies are never prompt results. */
export function parseImagePromptReverseResult(resultData: unknown): ImagePromptReverseResult {
    let value = resultData;
    if (isRecord(value) && "content" in value) value = value.content;
    else if (isRecord(value) && "reverseImage" in value) value = value.reverseImage;
    if (typeof value === "string") {
        const text = value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1").trim();
        try {
            value = JSON.parse(text);
        } catch {
            throw new Error(INVALID_RESULT_MESSAGE);
        }
    }
    if (!isRecord(value)) throw new Error(INVALID_RESULT_MESSAGE);
    const promptZh = readText(value.promptZh);
    const promptEn = readText(value.promptEn);
    if (!promptZh && !promptEn) throw new Error(INVALID_RESULT_MESSAGE);
    const style = readText(value.style);
    return { promptZh, promptEn, negativePrompt: readText(value.negativePrompt), ...(style ? { style } : {}) };
}

/** Start one image-reading task and cancel it even if cancellation happens before creation returns. */
export async function reverseImagePrompt(input: ImagePromptReverseInput, options: { signal?: AbortSignal; onProgress?: (task: ServerAiTask) => void } = {}): Promise<ImagePromptReverseResult> {
    const { signal } = options;
    if (signal?.aborted) throw abortError();
    if (!input.image.storageKey?.trim()) throw new Error("请先准备可读取的图片后再反推");
    const task = await createImagePromptReverseTask(input);
    if (signal?.aborted) {
        void cancelAiTask(task.id).catch(() => {});
        throw abortError();
    }
    let rejectCanceled: ((reason: Error) => void) | undefined;
    const canceled = new Promise<never>((_, reject) => { rejectCanceled = reject; });
    const onAbort = () => {
        void cancelAiTask(task.id).catch(() => {});
        rejectCanceled?.(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        // The race also ends the local wait if the first task-status request is still pending.
        const completed = await Promise.race([
            waitAiTask(task.id, { signal, cancelOnAbort: false, onProgress: options.onProgress }),
            canceled,
        ]);
        if (signal?.aborted) throw abortError();
        return parseImagePromptReverseResult(completed.resultData);
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function abortError() {
    return new DOMException("Aborted", "AbortError");
}
