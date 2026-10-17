import { createAiTask, waitAiTask, type ServerAiTask, type ServerGenerationSource } from "@/services/api/server";
import type { UploadedFile } from "@/features/storage/services/file-storage";

/** 一次语音合成的输入：文本、音色与可选的语速/表演指示。 */
export type SpeechGenerationInput = {
    text: string;
    model: string;
    voice?: string;
    speed?: number;
    /** 情绪、语气等表演指示；不支持的模型会忽略。 */
    instructions?: string;
    generationSource?: ServerGenerationSource;
    signal?: AbortSignal;
    onTaskCreated?: (taskId: string) => void;
    onProgress?: (progress: number) => void;
};

export { DEFAULT_SPEECH_VOICE, MAX_SPEECH_TEXT_LENGTH, SPEECH_VOICE_OPTIONS } from "../lib/speech-voices";
import { DEFAULT_SPEECH_VOICE, MAX_SPEECH_TEXT_LENGTH } from "../lib/speech-voices";

/** 创建语音合成任务并等待服务端把音频保存到对象存储。 */
export async function requestSpeechGeneration(input: SpeechGenerationInput): Promise<UploadedFile> {
    const text = input.text.trim();
    if (!text) throw new Error("请先输入要配音的文字");
    if (text.length > MAX_SPEECH_TEXT_LENGTH) throw new Error(`单段配音不能超过 ${MAX_SPEECH_TEXT_LENGTH} 字，请拆成多段`);
    if (!input.model.trim()) throw new Error("请先在后台配置并设为默认的语音模型");
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const task = await createAiTask({
        taskType: "audio",
        prompt: text,
        model: input.model.trim(),
        parameters: {
            voice: input.voice?.trim() || DEFAULT_SPEECH_VOICE,
            format: "mp3",
            ...(input.speed && Math.abs(input.speed - 1) > 0.001 ? { speed: input.speed } : {}),
            ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
        },
        references: [],
        generationSource: input.generationSource || "canvas",
    });
    input.onTaskCreated?.(task.id);
    const completed = await waitAiTask(task.id, {
        signal: input.signal,
        onProgress: input.onProgress ? (current) => input.onProgress?.(current.progress) : undefined,
    });
    return speechResultFromTask(completed);
}

export function speechResultFromTask(task: ServerAiTask): UploadedFile {
    const value = task.resultData as { item?: unknown } | null | undefined;
    const item = value && typeof value === "object" ? value.item as Partial<UploadedFile> | undefined : undefined;
    if (!item || typeof item.url !== "string" || !item.url) throw new Error("语音任务没有返回音频");
    return {
        url: item.url,
        storageKey: item.storageKey || "",
        bytes: item.bytes || 0,
        mimeType: item.mimeType || "audio/mpeg",
        durationMs: item.durationMs,
        objectStorage: item.objectStorage,
    } as UploadedFile;
}
