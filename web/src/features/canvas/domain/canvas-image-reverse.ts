import { createTextNode } from "../constants";
import type { CanvasImageNode, CanvasNode } from "../types";
import { createCanvasConnection, findNonOverlappingCanvasNodePosition } from "./canvas-page-node";

export type ReversePromptResult = { promptZh: string; promptEn: string; negativePrompt: string; style?: string };

/** An analysis belongs to this exact image, not whichever image later occupies its node. */
export function matchesReverseImageSource(node: CanvasNode | undefined, source: CanvasImageNode): node is CanvasImageNode {
    return Boolean(node && node.kind === "image" && node.id === source.id && node.content.source &&
        node.content.source === source.content.source && node.content.storageKey === source.content.storageKey &&
        node.execution.phase !== "running" && !node.grouping.isRoot);
}

export function applyReversedImagePrompt(node: CanvasNode | undefined, source: CanvasImageNode, prompt: string): CanvasImageNode {
    if (!matchesReverseImageSource(node, source)) throw new Error("原图片已更换或移除，请重新选择图片反推");
    if (node.generation.prompt !== source.generation.prompt) throw new Error("原提示词已被修改，请重新打开反推后再回填");
    if (!prompt.trim()) throw new Error("提示词不能为空");
    return { ...node, generation: { ...node.generation, prompt: prompt.trim() } };
}

export function reversedPromptText(result: ReversePromptResult) {
    return [result.style?.trim() ? `画面风格：${result.style.trim()}` : "", result.promptZh.trim() ? `中文提示词\n${result.promptZh.trim()}` : "",
        result.promptEn.trim() ? `English prompt\n${result.promptEn.trim()}` : "",
        result.negativePrompt.trim() ? `Negative prompt\n${result.negativePrompt.trim()}` : ""].filter(Boolean).join("\n\n");
}

export function createReversedPromptNode(nodes: CanvasNode[], source: CanvasImageNode, result: ReversePromptResult, id: string, connectionId: string) {
    const current = nodes.find(node => node.id === source.id);
    if (!matchesReverseImageSource(current, source)) throw new Error("原图片已更换或移除，请重新选择图片反推");
    if (!result.promptZh.trim() && !result.promptEn.trim()) throw new Error("反推结果中没有可用的正向提示词");
    const width = 480, height = 440;
    const position = findNonOverlappingCanvasNodePosition(nodes, { x: current.frame.position.x + current.frame.width + 144, y: current.frame.position.y }, width, height);
    const node = createTextNode({ id, position, title: `${current.title || "图片"} · 反推提示词`, text: reversedPromptText(result) });
    node.frame = { ...node.frame, width, height };
    node.execution = { phase: "succeeded" };
    if (current.dramaChapterId) node.dramaChapterId = current.dramaChapterId;
    return { node, connection: createCanvasConnection(connectionId, current.id, id, "right", "left") };
}
