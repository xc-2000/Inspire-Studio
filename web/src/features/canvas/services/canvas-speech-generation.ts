"use client";

import { requestSpeechGeneration } from "@/features/generation/api/speech";
import { readAudioMetadata } from "@/features/storage/services/audio-storage";
import { downloadServerMedia } from "@/services/api/server";
import type { CanvasNodeAttributes } from "../domain/canvas-node";
import type { CanvasAudioSpeechSettings } from "../types";

export type CanvasSpeechGenerationInput = {
    settings: CanvasAudioSpeechSettings;
    /** 已解析的语音模型（节点未指定时用默认语音模型）。 */
    model: string;
    signal?: AbortSignal;
    onTaskCreated?: (taskId: string) => void;
    onProgress?: (progress: number) => void;
};

/** 节点语音设置转换为节点属性补丁，供新建与更新共用。 */
export function speechSettingsAttributes(settings: Partial<CanvasAudioSpeechSettings>): CanvasNodeAttributes {
    return {
        speechText: settings.text,
        speechModel: settings.model,
        speechVoice: settings.voice,
        speechSpeed: settings.speed,
        speechInstructions: settings.instructions,
        speechSpeaker: settings.speaker,
    };
}

/**
 * 生成配音并返回可直接写入音频节点的属性。
 * 波形通过服务端代理下载解码，避免对象存储跨域；解码失败时仍交付音频，只是不画波形。
 */
export async function generateCanvasSpeech(input: CanvasSpeechGenerationInput): Promise<CanvasNodeAttributes> {
    const media = await requestSpeechGeneration({
        text: input.settings.text,
        model: input.model,
        voice: input.settings.voice,
        speed: input.settings.speed,
        instructions: input.settings.instructions,
        generationSource: "canvas",
        signal: input.signal,
        onTaskCreated: input.onTaskCreated,
        onProgress: input.onProgress,
    });
    let waveformPeaks: number[] = [];
    let durationMs = media.durationMs;
    try {
        const blob = media.storageKey ? await downloadServerMedia(media.storageKey) : null;
        if (blob) {
            const metadata = await readAudioMetadata(blob);
            waveformPeaks = metadata.waveformPeaks;
            durationMs = durationMs || metadata.durationMs;
        }
    } catch {
        // 波形只是展示；音频本身已保存成功。
    }
    return {
        content: media.url,
        storageKey: media.storageKey,
        mimeType: media.mimeType,
        bytes: media.bytes,
        durationMs,
        waveformPeaks,
        objectStorage: media.objectStorage,
        status: "success",
    };
}
