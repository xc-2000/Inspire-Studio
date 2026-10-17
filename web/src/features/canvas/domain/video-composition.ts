import type { CanvasAudioNode, CanvasConnection, CanvasNode, CanvasVideoCompositionNode, CanvasVideoNode } from "../types";
import type { VideoCompositionAudioTrack, VideoEditingOptions } from "@/services/api/video-composition";
import { isAudioNode, isVideoCompositionNode, isVideoNode } from "./canvas-node";

/** 单个合成视频节点可接收的最大输入段数。 */
export const MAXIMUM_VIDEO_COMPOSITION_INPUT_COUNT = 20;
/** 单个合成视频节点可叠加的最大配音/旁白音频数，与服务端一致。 */
export const MAXIMUM_VIDEO_COMPOSITION_AUDIO_TRACK_COUNT = 60;

/**
 * 校验新增画布连线是否符合视频合成节点约束。
 *
 * @param sourceNodeId 源节点ID
 * @param targetNodeId 目标节点ID
 * @param nodes 当前画布节点
 * @param connections 当前画布连线
 * @return 不可创建时的中文原因，可创建时返回null
 */
export function readVideoCompositionConnectionError(
    sourceNodeId: string,
    targetNodeId: string,
    nodes: CanvasNode[],
    connections: CanvasConnection[],
): string | null {
    const source = nodes.find((node) => node.id === sourceNodeId);
    const target = nodes.find((node) => node.id === targetNodeId);
    if (!source || !target || source.id === target.id) return "连接节点不存在或不能连接自身";
    if (!isVideoCompositionNode(source) && !isVideoCompositionNode(target)) return null;
    if (!isVideoCompositionNode(target)) return "合成视频节点只能接收视频或音频节点输入";
    if (isAudioNode(source)) {
        if (connections.some((connection) => connection.source.nodeId === source.id && connection.target.nodeId === target.id)) return "该音频已经连接到合成视频节点";
        const connectedAudioCount = connections.filter((connection) => connection.target.nodeId === target.id && connection.source.nodeId !== source.id
            && nodes.some((node) => node.id === connection.source.nodeId && isAudioNode(node))).length;
        return connectedAudioCount >= MAXIMUM_VIDEO_COMPOSITION_AUDIO_TRACK_COUNT ? `单个合成视频节点最多叠加${MAXIMUM_VIDEO_COMPOSITION_AUDIO_TRACK_COUNT}段音频` : null;
    }
    if (!isVideoNode(source)) return "合成视频节点仅支持直接连接视频或音频节点";
    if (connections.some((connection) => connection.source.nodeId === source.id && connection.target.nodeId === target.id)) {
        return "该视频已经连接到合成视频节点";
    }
    const connectedInputCount = connections.filter((connection) => connection.target.nodeId === target.id && connection.source.nodeId !== source.id
        && nodes.some((node) => node.id === connection.source.nodeId && isVideoNode(node))).length;
    if (connectedInputCount >= MAXIMUM_VIDEO_COMPOSITION_INPUT_COUNT) return "单个合成视频节点最多连接20段视频";
    return null;
}

/**
 * 按当前连线同步合成节点的有序输入列表。
 *
 * 保留用户拖拽后的既有顺序，新接入的视频追加至列表末尾；删除连线或源节点时自动移除。
 *
 * @param nodes 当前画布节点
 * @param connections 当前画布连线
 * @return 同步后的画布节点
 */
export function synchronizeVideoCompositionInputs(nodes: CanvasNode[], connections: CanvasConnection[]): CanvasNode[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    let changed = false;
    const synchronizedNodes = nodes.map((node) => {
        if (!isVideoCompositionNode(node)) return node;
        const incomingIds = uniqueIds(
            connections
                .filter((connection) => connection.target.nodeId === node.id)
                .map((connection) => nodeById.get(connection.source.nodeId))
                .filter((source): source is CanvasVideoNode => Boolean(source && isVideoNode(source)))
                .map((source) => source.id),
        );
        const incomingIdSet = new Set(incomingIds);
        const preservedIds = node.composition.inputVideoNodeIds.filter((inputId) => incomingIdSet.has(inputId));
        const appendedIds = incomingIds.filter((inputId) => !preservedIds.includes(inputId));
        const inputVideoNodeIds = [...preservedIds, ...appendedIds].slice(0, MAXIMUM_VIDEO_COMPOSITION_INPUT_COUNT);
        const resultVideoNodeId = node.composition.resultVideoNodeId && nodeById.has(node.composition.resultVideoNodeId)
            ? node.composition.resultVideoNodeId
            : undefined;
        if (sameIds(inputVideoNodeIds, node.composition.inputVideoNodeIds) && resultVideoNodeId === node.composition.resultVideoNodeId) return node;
        changed = true;
        const composition = { ...node.composition, inputVideoNodeIds };
        if (resultVideoNodeId) composition.resultVideoNodeId = resultVideoNodeId;
        else delete composition.resultVideoNodeId;
        return {
            ...node,
            composition,
        };
    });
    return changed ? synchronizedNodes : nodes;
}

/**
 * 调整合成输入列表中两个视频的相对顺序。
 *
 * @param inputVideoNodeIds 原始有序输入节点ID
 * @param draggedNodeId 被拖动的视频节点ID
 * @param targetNodeId 拖动目标视频节点ID
 * @return 调整后的有序输入节点ID
 */
export function reorderVideoCompositionInputIds(inputVideoNodeIds: string[], draggedNodeId: string, targetNodeId: string): string[] {
    if (draggedNodeId === targetNodeId) return inputVideoNodeIds;
    const sourceIndex = inputVideoNodeIds.indexOf(draggedNodeId);
    const targetIndex = inputVideoNodeIds.indexOf(targetNodeId);
    if (sourceIndex < 0 || targetIndex < 0) return inputVideoNodeIds;
    const next = [...inputVideoNodeIds];
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, draggedNodeId);
    return next;
}

/**
 * 判断合成按钮是否可以提交。
 *
 * @param node 合成视频节点
 * @param videoById 视频节点映射
 * @return 是否存在2至20段已完成且已持久化的视频
 */
export function canComposeVideo(node: CanvasVideoCompositionNode, videoById: Map<string, CanvasVideoNode>, audioTrackCount = 0): boolean {
    const inputIds = node.composition.editingSourceNodeIds || node.composition.inputVideoNodeIds;
    if (node.composition.editingSourceNodeIds?.some(id => !node.composition.inputVideoNodeIds.includes(id))) return false;
    // 单段视频也可以合成，只要叠加了配音；否则至少两段才有拼接意义。
    return inputIds.length >= (node.composition.editingOptions || audioTrackCount > 0 ? 1 : 2)
        && inputIds.length <= MAXIMUM_VIDEO_COMPOSITION_INPUT_COUNT
        && inputIds.every((inputId) => {
            const video = videoById.get(inputId);
            return Boolean(video && video.execution.phase === "succeeded" && video.content.storageKey?.trim());
        });
}

/**
 * 去除重复节点ID并保持原有顺序。
 *
 * @param values 原始节点ID列表
 * @return 去重后的节点ID列表
 */
function uniqueIds(values: string[]): string[] {
    const seen = new Set<string>();
    return values.filter((value) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
    });
}

/**
 * 比较两个节点ID列表是否完全一致。
 *
 * @param first 第一个节点ID列表
 * @param second 第二个节点ID列表
 * @return 是否顺序一致
 */
function sameIds(first: string[], second: string[]): boolean {
    return first.length === second.length && first.every((value, index) => value === second[index]);
}

/** 合成节点上已连接、已保存的配音/旁白音频，按成片时间轴起点排序。 */
export function readVideoCompositionAudioInputs(compositionNodeId: string, nodes: CanvasNode[], connections: CanvasConnection[]): CanvasAudioNode[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    return connections
        .filter((connection) => connection.target.nodeId === compositionNodeId)
        .map((connection) => byId.get(connection.source.nodeId))
        .filter((node): node is CanvasAudioNode => Boolean(node && isAudioNode(node) && !seen.has(node.id) && seen.add(node.id)))
        .sort((left, right) => (left.content.timelineStartMilliseconds || 0) - (right.content.timelineStartMilliseconds || 0) || left.id.localeCompare(right.id));
}

/** 只有成功保存到媒体库的音频能被服务端合成读取。 */
export function isComposableAudioNode(node: CanvasAudioNode): boolean {
    return node.execution.phase !== "running" && node.execution.phase !== "failed" && Boolean(node.content.storageKey?.trim() && node.content.source);
}

/** 把连接的音频节点转换为服务端合成音轨。 */
export function videoCompositionAudioTracks(audioNodes: CanvasAudioNode[]): VideoCompositionAudioTrack[] {
    return audioNodes.filter(isComposableAudioNode).slice(0, MAXIMUM_VIDEO_COMPOSITION_AUDIO_TRACK_COUNT).map((node) => ({
        storageKey: node.content.storageKey!.trim(),
        startMs: Math.max(0, Math.round(node.content.timelineStartMilliseconds || 0)),
        ...(node.content.timelineVolume !== undefined && node.content.timelineVolume !== 1 ? { volume: node.content.timelineVolume } : {}),
    }));
}

/** 在已有剪辑选项上叠加音轨；没有音轨时原样返回，保持旧请求不变。originalVolume 为视频原声音量（0 静音）。 */
export function withVideoCompositionAudioTracks(editing: VideoEditingOptions | undefined, tracks: VideoCompositionAudioTrack[], originalVolume?: number): VideoEditingOptions | undefined {
    if (!tracks.length) return editing;
    const volume = typeof originalVolume === "number" && Number.isFinite(originalVolume) ? Math.min(2, Math.max(0, originalVolume)) : undefined;
    return { ...(editing || { clips: [], subtitles: [], fontSize: 36 }), audioTracks: tracks, ...(volume === undefined ? {} : { originalVolume: volume }) };
}

/** 合成节点上可选的原声音量档位。 */
export const VIDEO_COMPOSITION_ORIGINAL_VOLUME_OPTIONS = [
    { value: 0, label: "原声静音" },
    { value: 0.3, label: "原声 30%" },
    { value: 0.6, label: "原声 60%" },
    { value: 1, label: "原声 100%" },
] as const;
