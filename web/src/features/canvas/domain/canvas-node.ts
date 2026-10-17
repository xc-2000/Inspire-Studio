import type {
    CanvasAudioNode,
    CanvasBackgroundNode,
    CanvasExecutionState,
    CanvasImageContent,
    CanvasImageGenerationSettings,
    CanvasImageGrouping,
    CanvasImageNode,
    CanvasNode,
    CanvasNodeFrame,
    CanvasStoryboardAsset,
    CanvasStoryboardNode,
    CanvasStoryboardShot,
    CanvasTextNode,
    CanvasVideoCompositionData,
    CanvasVideoCompositionNode,
    CanvasVideoContent,
    CanvasVideoGenerationSettings,
    CanvasVideoNode,
} from "../types.ts";
import type { ObjectStorageFile } from "@/shared/types/object-storage";
import type { GenerationStyleSnapshot } from "@/services/api/server";
import type { VideoGenerationMode } from "@/features/settings/stores/use-config-store";

export type CanvasNodeAttributeStatus = "idle" | "loading" | "success" | "error";

export type CanvasNodeAttributes = {
    content?: string;
    prompt?: string;
    includeUpstreamText?: boolean;
    status?: CanvasNodeAttributeStatus;
    errorDetails?: string;
    taskId?: string;
    progress?: number;
    startedAt?: string;
    completedAt?: string;
    fontSize?: number;
    textRole?: "text" | "generation-prompt";
    model?: string;
    generationType?: "generation" | "edit";
    size?: string;
    quality?: string;
    imageResolution?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    videoGenerationMode?: VideoGenerationMode;
    watermark?: string;
    generateAudio?: string;
    references?: string[];
    referenceObjectStorages?: ObjectStorageFile[];
    editMask?: import("@/features/generation/types/image").ReferenceImage;
    videoReferences?: string[];
    videoReferenceObjectStorages?: ObjectStorageFile[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    trimStartMs?: number;
    trimEndMs?: number;
    waveformPeaks?: number[];
    /** 音频节点：语音合成文字、模型、音色、语速、表演指示与说话人。 */
    speechText?: string;
    speechModel?: string;
    speechVoice?: string;
    speechSpeed?: number;
    speechInstructions?: string;
    speechSpeaker?: string;
    /** 音频节点：叠加到成片时的时间轴起点（毫秒）与音量。 */
    timelineStartMs?: number;
    timelineVolume?: number;
    audioReferences?: import("@/features/generation/types/media").ReferenceAudio[];
    objectStorage?: ObjectStorageFile;
    generationStyleIds?: number[];
    generationStyleSnapshots?: GenerationStyleSnapshot[];
    settingGraph?: import("../types.ts").CanvasSettingGraphSkillSnapshot;
    storyboardShots?: CanvasStoryboardShot[];
    storyboardAssets?: CanvasStoryboardAsset[];
    videoCompositionInputVideoNodeIds?: string[];
    /** 合成节点：叠加配音时视频原声的音量倍数，0 为静音。 */
    compositionOriginalVolume?: number;
    videoCompositionResultVideoNodeId?: string;
};

export function isImageNode(node: CanvasNode): node is CanvasImageNode {
    return node.kind === "image";
}

export function isTextNode(node: CanvasNode): node is CanvasTextNode {
    return node.kind === "text";
}

/** 判断是否为音频节点。 */
export function isAudioNode(node: CanvasNode): node is CanvasAudioNode {
    return node.kind === "audio";
}

export function isVideoNode(node: CanvasNode): node is CanvasVideoNode {
    return node.kind === "video";
}

export function isVideoCompositionNode(node: CanvasNode): node is CanvasVideoCompositionNode {
    return node.kind === "videoComposition";
}

export function isStoryboardNode(node: CanvasNode): node is CanvasStoryboardNode {
    return node.kind === "storyboard";
}

/** 判断节点是否为背景板。 */
export function isBackgroundNode(node: CanvasNode): node is CanvasBackgroundNode {
    return node.kind === "background";
}

export function updateCanvasNodeTitle<Node extends CanvasNode>(node: Node, title: string): Node {
    const normalizedTitle = title.trim();
    return normalizedTitle && normalizedTitle !== node.title ? { ...node, title: normalizedTitle } : node;
}

/** 更新背景板颜色。 */
export function updateCanvasBackgroundColor(node: CanvasBackgroundNode, backgroundColor: string): CanvasBackgroundNode {
    const normalizedColor = backgroundColor.trim();
    return normalizedColor && normalizedColor !== node.backgroundColor ? { ...node, backgroundColor: normalizedColor } : node;
}

/** 更新背景板成员标识，并自动去重。 */
export function updateCanvasBackgroundMembers(node: CanvasBackgroundNode, memberNodeIds: string[]): CanvasBackgroundNode {
    const normalized = Array.from(new Set(memberNodeIds.filter(Boolean))).filter((id) => id !== node.id);
    if (normalized.length === node.memberNodeIds.length && normalized.every((id, index) => id === node.memberNodeIds[index])) return node;
    return { ...node, memberNodeIds: normalized };
}

export function updateCanvasNodeFrame<Node extends CanvasNode>(node: Node, patch: Partial<CanvasNodeFrame>): Node {
    const frame = mergeDefined(node.frame, patch);
    return {
        ...node,
        frame: {
            ...frame,
            position: patch.position ? { ...patch.position } : node.frame.position,
        },
    };
}

export function updateCanvasNodeExecution<Node extends CanvasNode>(node: Node, patch: Partial<CanvasExecutionState>): Node {
    return {
        ...node,
        execution: mergeDefined(node.execution, patch),
    };
}

export function updateImageNodeContent(node: CanvasImageNode, patch: Partial<CanvasImageContent>): CanvasImageNode {
    return {
        ...node,
        content: mergeDefined(node.content, patch),
    };
}

export function updateTextNodeContent(node: CanvasTextNode, patch: Partial<CanvasTextNode["content"]>): CanvasTextNode {
    return {
        ...node,
        content: mergeDefined(node.content, patch),
    };
}

export function updateImageNodeGeneration(node: CanvasImageNode, patch: Partial<CanvasImageGenerationSettings>): CanvasImageNode {
    return {
        ...node,
        generation: mergeDefined(node.generation, patch),
    };
}

export function updateImageNodeGrouping(node: CanvasImageNode, patch: Partial<CanvasImageGrouping>): CanvasImageNode {
    return {
        ...node,
        grouping: mergeDefined(node.grouping, patch),
    };
}

export function updateVideoNodeContent(node: CanvasVideoNode, patch: Partial<CanvasVideoContent>): CanvasVideoNode {
    return {
        ...node,
        content: mergeDefined(node.content, patch),
    };
}

export function updateVideoNodeGeneration(node: CanvasVideoNode, patch: Partial<CanvasVideoGenerationSettings>): CanvasVideoNode {
    return {
        ...node,
        generation: mergeDefined(node.generation, patch),
    };
}

export function updateVideoCompositionNodeData(node: CanvasVideoCompositionNode, patch: Partial<CanvasVideoCompositionData>): CanvasVideoCompositionNode {
    return {
        ...node,
        composition: mergeDefined(node.composition, patch),
    };
}

export function updateStoryboardNodeContent(node: CanvasStoryboardNode, patch: Partial<CanvasStoryboardNode["content"]>): CanvasStoryboardNode {
    return {
        ...node,
        content: mergeDefined(node.content, patch),
    };
}

export function updateStoryboardNodeData(node: CanvasStoryboardNode, patch: Partial<CanvasStoryboardNode["storyboard"]>): CanvasStoryboardNode {
    return {
        ...node,
        storyboard: mergeDefined(node.storyboard, patch),
    };
}

export function applyCanvasNodeAttributes(node: CanvasNode, attributes?: CanvasNodeAttributes): CanvasNode {
    if (!attributes) return node;
    const phase = mapExecutionPhase(attributes.status, node.execution.phase);
    const executionPatch = {
        errorMessage: attributes.errorDetails,
        taskId: attributes.taskId,
        progress: attributes.progress,
        startedAt: attributes.startedAt,
        completedAt: attributes.completedAt,
    };
    const executed: CanvasNode =
        attributes.status === "success"
            ? {
                  ...node,
                  execution: {
                      phase: "succeeded",
                      ...((attributes.startedAt ?? node.execution.startedAt) ? { startedAt: attributes.startedAt ?? node.execution.startedAt } : {}),
                      ...(attributes.completedAt ? { completedAt: attributes.completedAt } : {}),
                  },
              }
            : attributes.status === "idle"
              ? { ...node, execution: { phase: "idle" as const } }
              : updateCanvasNodeExecution(node, { phase, ...executionPatch });
    const framed = updateCanvasNodeFrame(executed, {
        naturalWidth: attributes.naturalWidth,
        naturalHeight: attributes.naturalHeight,
        freeResize: attributes.freeResize,
    });

    if (isAudioNode(framed)) {
        const speechPatch = [attributes.speechText, attributes.speechModel, attributes.speechVoice, attributes.speechSpeed, attributes.speechInstructions, attributes.speechSpeaker].some((value) => value !== undefined);
        const speech = speechPatch ? mergeDefined(framed.speech || { text: "", model: "", voice: "" }, {
            text: attributes.speechText, model: attributes.speechModel, voice: attributes.speechVoice,
            speed: attributes.speechSpeed, instructions: attributes.speechInstructions, speaker: attributes.speechSpeaker,
        }) : framed.speech;
        return {
            ...framed,
            ...(speech ? { speech } : {}),
            content: mergeDefined(framed.content, { source: attributes.content, storageKey: attributes.storageKey, mimeType: attributes.mimeType, bytes: attributes.bytes, durationMilliseconds: attributes.durationMs, objectStorage: attributes.objectStorage, waveformPeaks: attributes.waveformPeaks, trimStartMilliseconds: attributes.trimStartMs, trimEndMilliseconds: attributes.trimEndMs, timelineStartMilliseconds: attributes.timelineStartMs, timelineVolume: attributes.timelineVolume }),
        };
    }
    if (isTextNode(framed)) {
        return updateTextNodeContent(framed, {
            text: attributes.content ?? framed.content.text,
            fontSize: attributes.fontSize ?? framed.content.fontSize,
            role: attributes.textRole,
        });
    }
    if (isImageNode(framed)) {
        const withContent = updateImageNodeContent(framed, {
            source: attributes.content ?? framed.content.source,
            storageKey: attributes.storageKey,
            mimeType: attributes.mimeType,
            bytes: attributes.bytes,
            objectStorage: attributes.objectStorage,
        });
        const withGeneration = updateImageNodeGeneration(withContent, {
            operation: attributes.generationType,
            prompt: attributes.prompt,
            includeUpstreamText: attributes.includeUpstreamText,
            model: attributes.model,
            size: attributes.size,
            quality: attributes.quality,
            resolution: attributes.imageResolution,
            count: attributes.count,
            references: attributes.references,
            referenceObjectStorages: attributes.referenceObjectStorages,
            editMask: attributes.editMask,
            generationStyleIds: attributes.generationStyleIds,
            generationStyleSnapshots: attributes.generationStyleSnapshots,
            settingGraph: attributes.settingGraph,
        });
        return updateImageNodeGrouping(withGeneration, {
            isRoot: attributes.isBatchRoot,
            rootId: attributes.batchRootId,
            childIds: attributes.batchChildIds,
            usesReferenceImages: attributes.batchUsesReferenceImages,
            primaryImageId: attributes.primaryImageId,
            expanded: attributes.imageBatchExpanded,
        });
    }
    if (isStoryboardNode(framed)) {
        const withContent = updateStoryboardNodeContent(framed, {
            instruction: attributes.content,
            model: attributes.model,
        });
        return updateStoryboardNodeData(withContent, {
            shots: attributes.storyboardShots,
            assets: attributes.storyboardAssets,
        });
    }
    if (isVideoCompositionNode(framed)) {
        return updateVideoCompositionNodeData(framed, {
            inputVideoNodeIds: attributes.videoCompositionInputVideoNodeIds,
            resultVideoNodeId: attributes.videoCompositionResultVideoNodeId,
            originalAudioVolume: attributes.compositionOriginalVolume,
        });
    }
    if (isBackgroundNode(framed)) return framed;
    const withContent = updateVideoNodeContent(framed, {
        source: attributes.content ?? framed.content.source,
        storageKey: attributes.storageKey,
        mimeType: attributes.mimeType,
        bytes: attributes.bytes,
        durationMilliseconds: attributes.durationMs,
        objectStorage: attributes.objectStorage,
    });
    return updateVideoNodeGeneration(withContent, {
        prompt: attributes.prompt,
        includeUpstreamText: attributes.includeUpstreamText,
        model: attributes.model,
        size: attributes.size,
        seconds: attributes.seconds,
        quality: attributes.vquality,
        videoGenerationMode: attributes.videoGenerationMode,
        watermark: attributes.watermark,
        generateAudio: attributes.generateAudio,
        count: attributes.count,
        references: attributes.references,
        referenceObjectStorages: attributes.referenceObjectStorages,
        audioReferences: attributes.audioReferences,
        videoReferences: attributes.videoReferences,
        videoReferenceObjectStorages: attributes.videoReferenceObjectStorages,
        generationStyleIds: attributes.generationStyleIds,
        generationStyleSnapshots: attributes.generationStyleSnapshots,
    });
}

function mergeDefined<Value extends object>(source: Value, patch: Partial<Value>): Value {
    const result = { ...source };
    Object.entries(patch).forEach(([key, value]) => {
        if (value !== undefined) (result as Record<string, unknown>)[key] = value;
    });
    return result;
}

function mapExecutionPhase(status: CanvasNodeAttributeStatus | undefined, fallback: CanvasExecutionState["phase"]): CanvasExecutionState["phase"] {
    if (status === "loading") return "running";
    if (status === "success") return "succeeded";
    if (status === "error") return "failed";
    if (status === "idle") return "idle";
    return fallback;
}
