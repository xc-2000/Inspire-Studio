import type { ReferenceImage } from "@/features/generation/types/image";
import { mergeUniqueReferences } from "./canvas-video-generation-references";

export type CanvasImageGenerationReferenceInputs = {
    masked: boolean;
    isEdit: boolean;
    isSettingGraph: boolean;
    /** null means saved media could not be resolved; [] means none were saved. */
    savedReferences: ReferenceImage[] | null;
    sourceReferences: ReferenceImage[];
    upstreamReferences: ReferenceImage[];
    /** Canonical drama identities must stay before supplemental references and previous renders. */
    identityReferences?: ReferenceImage[];
};

/** Keep edits attached to their actual reference images, even after input edges are removed. */
export function selectCanvasImageGenerationReferences(input: CanvasImageGenerationReferenceInputs): ReferenceImage[] {
    if (input.masked) {
        if (input.savedReferences === null) throw new Error("蒙版编辑的已保存原图读取失败，请恢复原图参考后重试。");
        if (input.savedReferences.length !== 1) throw new Error("蒙版编辑需要且仅支持一张已保存原图，请恢复正确参考后重试。");
        return [...input.savedReferences];
    }
    // A setting graph must use its upstream material instead of its previous output.
    if (input.isSettingGraph) return [...input.upstreamReferences];
    if (input.identityReferences?.length) {
        if (input.savedReferences === null) throw new Error("镜头参考图片读取失败，请恢复参考素材后重试。");
        return mergeUniqueReferences(input.identityReferences, mergeUniqueReferences(input.savedReferences, input.upstreamReferences));
    }
    if (input.sourceReferences.length) return [...input.sourceReferences];
    if (input.upstreamReferences.length) return [...input.upstreamReferences];
    if (input.isEdit) {
        if (input.savedReferences === null) throw new Error("编辑节点的已保存参考图读取失败，请恢复参考图后重试，不能改为文生图。");
        if (!input.savedReferences.length) throw new Error("编辑节点缺少参考图，请重新连接输入图片或恢复已保存参考，不能改为文生图。");
        return [...input.savedReferences];
    }
    return [];
}
