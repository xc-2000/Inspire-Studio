import type { CanvasNode } from "../types";
import { buildDramaShotImageInputs } from "@/features/open-drama/drama-shot-image-inputs";

/** Resolve the current canonical character assets, not the last rendered shot's face. */
export function readCanvasDramaImageInputs(node: CanvasNode | undefined, nodes: CanvasNode[], prompt: string) {
    // These tools select their own original/upstream images. Canonical shot image
    // numbers would otherwise describe a different set of submitted references.
    if (node?.kind === "image" && (node.generation.editMask || node.generation.settingGraph)) return null;
    if (!node?.dramaStoryboardId || !node.dramaShotId) return null;
    const board = nodes.find(item => item.id === node.dramaStoryboardId);
    if (!board || board.kind !== "storyboard") throw new Error("镜头所属分镜已移除，请重新连接分镜后生成");
    const shot = board.storyboard.shots.find(item => item.id === node.dramaShotId);
    if (!shot) throw new Error("镜头已从分镜中移除，请重新展开镜头后生成");
    return buildDramaShotImageInputs(board, shot, prompt);
}
