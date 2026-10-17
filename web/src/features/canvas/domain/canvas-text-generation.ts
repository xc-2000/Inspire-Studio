import type { CanvasTextNode } from "../types.ts";

export function canvasTextGenerationInstruction(content: CanvasTextNode["content"] | undefined, prompt: string): string {
    const original = content?.text.trim();
    if (!original || content?.role === "generation-prompt") return prompt;
    return `请根据要求修改以下文本。\n\n原文：\n${original}\n\n修改要求：\n${prompt}`;
}
