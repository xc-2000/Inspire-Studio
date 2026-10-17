import { nanoid } from "nanoid";

import { defaultConfig, type AiConfig } from "@/features/settings/stores/use-config-store";
import { resolveVideoResolution } from "@/features/settings/lib/video-resolution-configuration";
import { isVideoDurationSupported, readVideoDurationRange } from "@/features/generation/lib/video-duration";
import type { GenerationStyleSnapshot } from "@/services/api/server";
import type { CanvasSettingGraphSkillSnapshot, CanvasNode, CanvasVideoCompositionNode, CanvasVideoNode } from "../types";
import { arrangeCanvasNodes } from "../domain/canvas-arrangement";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import type { CanvasAgentToolResult as HostToolResult } from "../utils/canvas-agent-tools";
import type { CanvasAgentContext, CanvasAgentContextNode } from "./upstream/canvas-agent-context";
import type { CanvasAgentState, CanvasNodeType } from "./upstream/types";
import { CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./upstream/canvas-agent-tools";
import { createFilmWorkflow, runFilmWorkflow, type FilmWorkflow, type FilmWorkflowInput } from "./film-workflow";
import { DEFAULT_SPEECH_VOICE, MAX_SPEECH_TEXT_LENGTH, SPEECH_VOICE_OPTIONS } from "@/features/generation/lib/speech-voices";
import { readFilmPlanningConstraints } from "./film-planning";
import { normalizeFilmStoryPlan, compileFilmStoryPlan, type FilmStoryPlan } from "./film-story-plan";

/** Only tools backed by the current project's real editing and generation paths. */
export const supportedCanvasAgentTools = CANVAS_AGENT_TOOLS.filter((tool) => !["read_skill_file", "generate_audio"].includes(tool.function.name)).map((tool) => {
    const properties = { ...tool.function.parameters.properties };
    if (tool.function.name === "generate_video") delete properties.generateAudio;
    if (tool.function.name === "set_agent_state") properties.phase = { type: "string", enum: ["intake", "concept", "script", "breakdown", "references", "storyboard", "video", "review", "complete"] };
    if (tool.function.name === "query_canvas_nodes") properties.type = { type: "string", enum: ["image", "text", "video", "audio", "director", "group"] };
    return { ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, properties } } };
});

export type InfiniteCanvasConfig = Partial<AiConfig> & {
    filmPlanning?: boolean;
    autoGenerateMedia?: boolean;
    imageSize?: string;
    videoSize?: string;
    imageQuality?: string;
    videoQuality?: string;
    generationStyleIdsByType?: { image?: number[]; video?: number[] };
    generationStyleSnapshots?: GenerationStyleSnapshot[];
    /** Alias accepted by host call sites that already collect selected style snapshots. */
    styleSnapshots?: GenerationStyleSnapshot[];
    settingGraphNodeId?: string;
    settingGraphSkillSnapshot?: CanvasSettingGraphSkillSnapshot;
};

export type InfiniteCanvasActionOptions = {
    getSnapshot: () => CanvasAgentSnapshot;
    onApplyOps: (ops: CanvasAgentOp[] | undefined, signal: AbortSignal) => Promise<{ snapshot: CanvasAgentSnapshot; result?: HostToolResult }>;
    config: InfiniteCanvasConfig;
    signal?: AbortSignal;
    setAgentState?: (patch: Partial<CanvasAgentState>) => void | Promise<void>;
    createId?: () => string;
    filmWorkflow?: FilmWorkflow;
    filmStoryPlan?: FilmStoryPlan;
};

const MAX_CONTEXT_NODES = 120;
const MAX_CONTEXT_TEXT = 4000;
const statusByPhase = { idle: "idle", running: "loading", succeeded: "success", failed: "error" } as const;

/** Build the upstream Agent's factual context without exposing channel keys or media Base64. */
export function buildInfiniteCanvasContext(snapshot: CanvasAgentSnapshot, state: CanvasAgentState, config: InfiniteCanvasConfig): CanvasAgentContext {
    const existing = new Set(snapshot.nodes.map((node) => node.id));
    const selectedNodeIds = snapshot.selectedNodeIds.filter((id) => existing.has(id));
    const priorities = new Set([...selectedNodeIds, ...state.approvedNodeIds, ...state.referenceNodeIds]);
    const immediate = new Set(priorities);
    snapshot.connections.forEach((edge) => {
        if (immediate.has(edge.source.nodeId) || immediate.has(edge.target.nodeId)) {
            priorities.add(edge.source.nodeId);
            priorities.add(edge.target.nodeId);
        }
    });
    snapshot.nodes.forEach((node) => { if (node.execution.phase === "running" || node.execution.phase === "failed") priorities.add(node.id); });
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const nodes = [...priorities].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
    nodes.push(...snapshot.nodes.filter((node) => !priorities.has(node.id)));
    const included = nodes.slice(0, MAX_CONTEXT_NODES);
    const includedIds = new Set(included.map((node) => node.id));
    return {
        project: { id: snapshot.projectId, title: snapshot.title, nodeCount: snapshot.nodes.length, connectionCount: snapshot.connections.length },
        agentState: { ...state, approvedNodeIds: state.approvedNodeIds.filter((id) => existing.has(id)), referenceNodeIds: state.referenceNodeIds.filter((id) => existing.has(id)) },
        selectedNodeIds,
        nodes: included.map((node) => summarizeNode(node, snapshot)),
        connections: snapshot.connections.filter((edge) => includedIds.has(edge.source.nodeId) && includedIds.has(edge.target.nodeId)).map((edge) => ({ id: edge.id, fromNodeId: edge.source.nodeId, toNodeId: edge.target.nodeId })),
        generation: generationContext(config),
        tasks: included.filter((node) => Boolean(node.execution.taskId)).map((node) => taskSummary(node, snapshot)),
    };
}

/** Execute upstream tools through the existing undo, cancellation, generation and R2 boundary. */
export async function executeInfiniteCanvasAction(action: CanvasAgentAction, options: InfiniteCanvasActionOptions): Promise<CanvasAgentToolResult> {
    options = { ...options, config: { ...options.config, audioModel: "" } };
    const signal = options.signal || new AbortController().signal;
    throwIfAborted(signal);
    const definition = supportedCanvasAgentTools.find((tool) => tool.function.name === action.name);
    if (!definition) return failure("unsupported_tool", `当前画布不支持工具 ${action.name}`);
    try {
        const unknown = Object.keys(action.arguments || {}).filter((key) => !(key in definition.function.parameters.properties));
        if (unknown.length) return failure("invalid_parameter", `${action.name} 不支持参数：${unknown.join("、")}`);
        const normalized = normalizeCanvasAgentAction(action.name, action.arguments, action.id);
        const args = normalized.arguments;
        const snapshot = options.getSnapshot();
        const createId = options.createId || nanoid;
        const nodeId = stringValue(args.nodeId);
        const node = snapshot.nodes.find((item) => item.id === nodeId);
        const requireNode = () => { if (!node) throw new AdapterError("node_not_found", `找不到节点 ${nodeId}`); return node; };
        const validateIds = (ids: string[]) => ids.map((id) => {
            const found = snapshot.nodes.find((item) => item.id === id);
            if (!found) throw new AdapterError("node_not_found", `找不到节点 ${id}`);
            return found;
        });
        const apply = async (ops: CanvasAgentOp[]) => {
            throwIfAborted(signal);
            const result = await options.onApplyOps(ops, signal);
            throwIfAborted(signal);
            return result;
        };

        switch (normalized.name) {
            case "plan_film_story": {
                if (options.filmStoryPlan) return { ok: true, status: "planned", storyPlan: options.filmStoryPlan, reused: true, message: "剧情已冻结，请继续编写片段镜头设计，未重复编剧" };
                const storyPlan = normalizeFilmStoryPlan(args);
                const config = { ...defaultConfig, ...options.config };
                const duration = readFilmPlanningConstraints(config).videoDuration;
                if (config.videoModel && storyPlan.beats.some(beat => !duration.options.includes(beat.seconds))) return failure("unsupported_video_duration", `计划包含当前渠道不支持的秒数；合法秒数：${duration.options.join("、")}。请修正计划，尚未创建节点或生成媒体`);
                for (const asset of storyPlan.assets) {
                    if (!asset.sourceNodeId) continue;
                    const source = snapshot.nodes.find(node => node.id === asset.sourceNodeId);
                    if (source?.kind !== "image" || source.execution.phase !== "succeeded" || !source.content.storageKey || !(source.content.objectStorage?.url || source.content.source)) return failure("film_reference_unavailable", `「${asset.name}」引用的原图不存在或未就绪`);
                }
                return { ok: true, status: "planned", storyPlan, totalSeconds: storyPlan.targetDurationSeconds, shotCount: storyPlan.beats.length, message: "剧情、时长和共享资产已冻结，继续调用create_film_workflow编写片段镜头，不要重写故事" };
            }
            case "create_film_workflow":
                if (options.filmWorkflow) return { ok: true, status: "planned", workflow: options.filmWorkflow, reused: true, message: "本次完整工作流已创建，请执行 run_film_workflow 继续原有节点" };
                if (args.clips !== undefined) {
                    if (!options.filmStoryPlan) return failure("film_story_plan_required", "请先调用plan_film_story完成剧情与时长编排");
                    return await createFilmWorkflow(compileFilmStoryPlan(options.filmStoryPlan, args.clips), options);
                }
                if (options.config.filmPlanning) return failure("film_story_plan_required", "一键成片请先plan_film_story，再传入clips由TapCanvas编译器生成工作流");
                return await createFilmWorkflow(args as unknown as FilmWorkflowInput, options);
            case "run_film_workflow":
                if (!options.filmWorkflow) return failure("film_workflow_required", "请先调用 create_film_workflow 展开完整的文本、图片、视频节点");
                return await runFilmWorkflow(options.filmWorkflow, options);
            case "get_canvas_summary": {
                const context = buildInfiniteCanvasContext(snapshot, emptyState(), options.config);
                const { agentState: _notStoredHere, ...summary } = context;
                return { ok: true, ...summary };
            }
            case "get_selected_nodes":
                return { ok: true, nodes: snapshot.nodes.filter((item) => snapshot.selectedNodeIds.includes(item.id)).map((item) => summarizeNode(item, snapshot)) };
            case "query_canvas_nodes": {
                const keyword = stringValue(args.keyword).toLocaleLowerCase();
                const type = stringValue(args.type);
                const page = Number(args.page) || 1;
                const pageSize = Number(args.pageSize) || 20;
                const filtered = snapshot.nodes.filter((item) => {
                    if (nodeId && item.id !== nodeId) return false;
                    if (type && upstreamNodeType(item) !== type) return false;
                    return !keyword || `${item.id} ${item.title} ${nodeText(item)} ${nodePrompt(item)}`.toLocaleLowerCase().includes(keyword);
                });
                return { ok: true, items: filtered.slice((page - 1) * pageSize, page * pageSize).map((item) => summarizeNode(item, snapshot)), total: filtered.length, page, pageSize };
            }
            case "get_node":
                return { ok: true, node: summarizeNode(requireNode(), snapshot, 32000) };
            case "get_upstream_nodes":
            case "get_downstream_nodes":
            case "get_connected_nodes": {
                requireNode();
                const upstreamIds = new Set(snapshot.connections.filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.source.nodeId));
                const downstreamIds = new Set(snapshot.connections.filter((edge) => edge.source.nodeId === nodeId).map((edge) => edge.target.nodeId));
                const upstream = snapshot.nodes.filter((item) => upstreamIds.has(item.id)).map((item) => summarizeNode(item, snapshot));
                const downstream = snapshot.nodes.filter((item) => downstreamIds.has(item.id)).map((item) => summarizeNode(item, snapshot));
                return normalized.name === "get_connected_nodes" ? { ok: true, upstream, downstream } : { ok: true, nodes: normalized.name === "get_upstream_nodes" ? upstream : downstream };
            }
            case "get_generation_config": {
                const generation = generationContext(options.config);
                const config = effectiveConfig(options.config);
                return {
                    ok: true, ...generation,
                    models: { text: generation.textModel, image: generation.imageModel, video: generation.videoModel },
                    videoDuration: generation.videoModel ? readFilmPlanningConstraints(config).videoDuration : null,
                    videoGenerationMode: config.videoGenerationMode,
                    generationStyleIdsByType: options.config.generationStyleIdsByType || {},
                    speech: config.audioModel
                        ? { available: true, model: config.audioModel, voices: SPEECH_VOICE_OPTIONS.map((voice) => ({ id: voice.value, description: voice.label })), note: "对白与旁白会由宿主自动配音并混入成片" }
                        : { available: false, note: "画布暂不接入独立配音，不要创建或提交配音任务" },
                };
            }
            case "get_generation_task":
            case "get_media_task_status": {
                const target = requireNode();
                if (target.kind !== "image" && target.kind !== "video" && target.kind !== "audio" && target.kind !== "videoComposition") return failure("not_media_node", `节点 ${nodeId} 不是媒体或合成节点`);
                return { ok: true, ...taskSummary(target, snapshot), node: summarizeNode(target, snapshot) };
            }
            case "set_agent_state": {
                validateIds([...strings(args.approvedNodeIds), ...strings(args.referenceNodeIds)]);
                if (args.phase === "audio") return failure("unsupported_phase", "当前画布未接入音频生成阶段");
                if (!options.setAgentState) return failure("state_storage_unavailable", "创作进度保存尚未就绪");
                await options.setAgentState(args as Partial<CanvasAgentState>);
                throwIfAborted(signal);
                return { ok: true, statePatch: args };
            }
            case "create_primary_script_node":
            case "create_text_node": {
                const sourceIds = strings(args.sourceNodeIds);
                const sources = validateIds(sourceIds);
                const id = `text-${createId()}`;
                const position = nextPosition(snapshot, sources);
                const ops: CanvasAgentOp[] = [{ type: "add_node", id, nodeType: "text", title: stringValue(args.title), position, ...(normalized.name === "create_primary_script_node" ? { width: 520, height: 420 } : {}), attributes: { content: stringValue(args.content), status: "success", textRole: "text" } }, ...connectionOps(sourceIds, id, createId)];
                const application = await apply(ops);
                return createdNodeResult(application.snapshot, id, sourceIds);
            }
            case "update_text_node":
            case "update_node": {
                const target = requireNode();
                if (normalized.name === "update_text_node" && target.kind !== "text") return failure("invalid_node_type", "只能用 update_text_node 修改文本节点");
                const application = await apply([{ type: "update_node", id: nodeId, ...(args.title ? { title: stringValue(args.title) } : {}), ...(args.content ? { attributes: { content: stringValue(args.content), status: "success" } } : {}) }]);
                const updated = application.snapshot.nodes.find((item) => item.id === nodeId);
                return updated ? { ok: true, nodeId, node: summarizeNode(updated, application.snapshot) } : failure("node_not_found", `更新后找不到节点 ${nodeId}`);
            }
            case "delete_node": {
                requireNode();
                const application = await apply([{ type: "delete_node", id: nodeId }]);
                const remaining = new Set(application.snapshot.nodes.map((item) => item.id));
                if (remaining.has(nodeId)) return failure("delete_failed", "节点未被删除");
                return { ok: true, deletedNodeIds: snapshot.nodes.filter((item) => !remaining.has(item.id)).map((item) => item.id) };
            }
            case "create_connection": {
                const fromNodeId = stringValue(args.fromNodeId), toNodeId = stringValue(args.toNodeId);
                validateIds([fromNodeId, toNodeId]);
                if (fromNodeId === toNodeId) return failure("self_connection", "节点不能连接到自身");
                const existing = snapshot.connections.find((edge) => edge.source.nodeId === fromNodeId && edge.target.nodeId === toNodeId);
                if (existing) return { ok: true, connectionId: existing.id, alreadyExists: true };
                const id = createId();
                const application = await apply([{ type: "connect_nodes", id, sourceNodeId: fromNodeId, targetNodeId: toNodeId }]);
                return application.snapshot.connections.some((edge) => edge.id === id) ? { ok: true, connectionId: id } : failure("invalid_connection", "现有画布规则不允许这两个节点连接");
            }
            case "delete_connection": {
                const id = stringValue(args.connectionId);
                if (!snapshot.connections.some((edge) => edge.id === id)) return failure("connection_not_found", `找不到连线 ${id}`);
                const application = await apply([{ type: "delete_connections", id }]);
                return application.snapshot.connections.some((edge) => edge.id === id) ? failure("delete_failed", "连线未被删除") : { ok: true, deletedConnectionId: id };
            }
            case "create_group": {
                const ids = strings(args.nodeIds);
                const targets = validateIds(ids);
                const groupMembers = new Set(snapshot.nodes.flatMap((item) => item.kind === "background" ? item.memberNodeIds : []));
                if (targets.some((item) => item.kind === "background" || groupMembers.has(item.id) || (item.kind === "image" && item.grouping.rootId))) return failure("invalid_group", "分组至少需要两个未分组的普通节点");
                const id = `background-${createId()}`;
                const application = await apply([{ type: "create_group", id, ids, title: stringValue(args.title) || "分组" }]);
                const board = application.snapshot.nodes.find((item) => item.id === id && item.kind === "background");
                return board ? { ok: true, groupId: id, nodeIds: ids } : failure("invalid_group", "分组未创建");
            }
            case "arrange_nodes": {
                const requestedIds = strings(args.nodeIds);
                validateIds(requestedIds);
                const grouped = new Set(snapshot.nodes.flatMap((item) => item.kind === "background" ? item.memberNodeIds : item.kind === "image" && item.grouping.isRoot ? item.grouping.childIds : []));
                const ids = requestedIds.length ? requestedIds : snapshot.nodes.filter((item) => !grouped.has(item.id)).map((item) => item.id);
                const arranged = arrangeCanvasNodes(snapshot.nodes, snapshot.connections, new Set(ids), "dag");
                const ops: CanvasAgentOp[] = arranged.flatMap((item, index) => item.frame.position !== snapshot.nodes[index].frame.position ? [{ type: "update_node" as const, id: item.id, patch: { position: item.frame.position, width: item.frame.width, height: item.frame.height } }] : []);
                if (ops.length) await apply(ops);
                return { ok: true, arrangedNodeIds: ids };
            }
            case "generate_image":
            case "edit_image":
            case "generate_video":
                return await executeMedia(normalized, snapshot, options, apply, validateIds, createId);
            case "generate_audio":
                return await executeSpeech(normalized, snapshot, options, apply, validateIds, createId);
            case "compose_videos":
                return await executeComposition(normalized, snapshot, apply, validateIds, createId);
            default:
                return failure("unsupported_tool", `当前画布不支持工具 ${normalized.name}`);
        }
    } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        return failure(error instanceof AdapterError ? error.code : "execution_failed", error instanceof Error ? error.message : "画布工具执行失败");
    }
}

async function executeComposition(action: CanvasAgentAction, snapshot: CanvasAgentSnapshot, apply: (ops: CanvasAgentOp[]) => Promise<{ snapshot: CanvasAgentSnapshot; result?: HostToolResult }>, validateIds: (ids: string[]) => CanvasNode[], createId: () => string): Promise<CanvasAgentToolResult> {
    const sourceIds = strings(action.arguments.sourceNodeIds);
    const sources = validateIds(sourceIds);
    if (sources.some((node) => node.kind !== "video")) return failure("invalid_composition_source", "成片只能引用视频节点，请按镜头顺序提供完整视频列表");
    const unavailable = sources.filter((node) => !isPersistedVideo(node));
    if (unavailable.length) return failure("composition_sources_unavailable", "部分镜头尚未成功或尚未保存，未提交合成；请先完成全部镜头", { unavailableNodeIds: unavailable.map((node) => node.id) });
    const sourceStorageKeys = sources.map((node) => (node as CanvasVideoNode).content.storageKey!.trim());
    const matchesStorageKeys = (node: CanvasVideoCompositionNode) => node.composition.inputStorageKeys?.length === sourceStorageKeys.length
        && node.composition.inputStorageKeys.every((key, index) => key === sourceStorageKeys[index]);
    const requestedId = stringValue(action.arguments.nodeId);
    const matchesSources = (node: CanvasNode): node is CanvasVideoCompositionNode => node.kind === "videoComposition"
        && !node.composition.editingOptions && !node.composition.editingSourceNodeIds
        && node.composition.inputVideoNodeIds.length === sourceIds.length
        && node.composition.inputVideoNodeIds.every((id, index) => id === sourceIds[index]);
    const requested = requestedId ? snapshot.nodes.find((node) => node.id === requestedId) : undefined;
    if (requestedId && !requested) return failure("node_not_found", `找不到合成节点 ${requestedId}`);
    if (requested && !matchesSources(requested)) return failure("composition_sources_mismatch", "指定合成节点的来源、顺序或剪辑设置与本次请求不一致，未修改或提交任务");
    const candidates = snapshot.nodes.filter(matchesSources);
    const existing = requested as CanvasVideoCompositionNode | undefined
        || candidates.find((node) => node.execution.phase === "succeeded" && compositionResult(node, snapshot))
        || candidates.find((node) => node.execution.phase === "running" && matchesStorageKeys(node))
        || candidates.find((node) => node.execution.phase === "running")
        || candidates[0];
    if (existing?.execution.phase === "running" && !matchesStorageKeys(existing)) return failure("composition_sources_stale", "合成中的任务使用了不同版本的镜头，未重复提交；请等待或取消旧任务后重新合成", { compositionNodeId: existing.id, taskId: existing.execution.taskId || "" });
    if (existing?.execution.phase === "succeeded" && matchesStorageKeys(existing)) {
        const result = compositionResult(existing, snapshot);
        return result ? compositionReceipt(existing, result, snapshot, true)
            : failure("composition_result_unavailable", "已有合成任务显示完成，但成片节点或媒体缺失，请先检查已有合成结果", { compositionNodeId: existing.id });
    }
    const id = existing?.id || `composition-${createId()}`;
    const ops: CanvasAgentOp[] = existing ? [] : [
        { type: "add_node", id, nodeType: "videoComposition", title: stringValue(action.arguments.title) || "最终成片", position: nextPosition(snapshot, sources) },
        ...connectionOps(sourceIds, id, createId),
    ];
    ops.push({ type: "run_composition", nodeId: id });
    const application = await apply(ops);
    const host = application.result ? safeHostResult(application.result) : undefined;
    const composition = application.snapshot.nodes.find((node): node is CanvasVideoCompositionNode => node.id === id && node.kind === "videoComposition");
    if (host?.ok === false) return { ...host, ...(host.data || {}), ok: false, compositionNodeId: id };
    if (!composition) return failure("composition_node_missing", "合成任务返回后找不到对应节点", { compositionNodeId: id });
    if (!matchesSources(composition) || !matchesStorageKeys(composition)) return failure("composition_sources_stale", "合成使用的来源或顺序已变化，当前结果不能作为本次成片", { compositionNodeId: id });
    if (composition.execution.phase !== "succeeded") return failure("composition_incomplete", composition.execution.errorMessage || "视频合成尚未成功，不能将当前片段视为最终成片", { ...taskSummary(composition, application.snapshot), compositionNodeId: id });
    const result = compositionResult(composition, application.snapshot);
    if (!result) return failure("composition_result_unavailable", "视频合成没有返回已保存的成片媒体", { compositionNodeId: id });
    return { ...(host || {}), ...(host?.data || {}), ...compositionReceipt(composition, result, application.snapshot, false) };
}

function isPersistedVideo(node?: CanvasNode): node is CanvasVideoNode {
    return Boolean(node?.kind === "video" && node.execution.phase === "succeeded" && node.content.storageKey?.trim() && /^https?:\/\//i.test(mediaSource(node).trim()));
}

function compositionResult(node: CanvasVideoCompositionNode, snapshot?: CanvasAgentSnapshot): CanvasVideoNode | undefined {
    if (node.execution.phase !== "succeeded") return undefined;
    const keys = node.composition.inputStorageKeys;
    if (!snapshot || !keys || keys.length !== node.composition.inputVideoNodeIds.length || !keys.length) return undefined;
    if (node.composition.inputVideoNodeIds.some((id, index) => {
        const source = snapshot.nodes.find((item) => item.id === id);
        return !isPersistedVideo(source) || source.content.storageKey?.trim() !== keys[index];
    })) return undefined;
    const result = snapshot?.nodes.find((item) => item.id === node.composition.resultVideoNodeId);
    return isPersistedVideo(result) ? result : undefined;
}

function compositionReceipt(node: CanvasVideoCompositionNode, result: CanvasVideoNode, snapshot: CanvasAgentSnapshot, reused: boolean): CanvasAgentToolResult {
    return { ok: true, nodeId: result.id, compositionNodeId: node.id, resultVideoNodeId: result.id, status: "success", sourceNodeIds: [...node.composition.inputVideoNodeIds], storageKey: result.content.storageKey, mediaUrl: mediaSource(result), reused, node: summarizeNode(result, snapshot) };
}

async function executeMedia(action: CanvasAgentAction, snapshot: CanvasAgentSnapshot, options: InfiniteCanvasActionOptions, apply: (ops: CanvasAgentOp[]) => Promise<{ snapshot: CanvasAgentSnapshot; result?: HostToolResult }>, validateIds: (ids: string[]) => CanvasNode[], createId: () => string): Promise<CanvasAgentToolResult> {
    const args = action.arguments;
    const mode = action.name === "generate_video" ? "video" : "image";
    const sourceIds = strings(args.sourceNodeIds);
    const sources = validateIds(sourceIds);
    const config = effectiveConfig(options.config);
    const prompt = stringValue(args.prompt);
    const mediaSources = sources.filter((item) => item.kind === "image" || item.kind === "video" || item.kind === "audio");
    if (mediaSources.some((item) => !mediaSource(item) || item.execution.phase === "running" || item.execution.phase === "failed")) return failure("media_reference_unavailable", "参考媒体尚未就绪，请先完成生成或更换参考节点");
    if (mode === "image" && mediaSources.some((item) => item.kind !== "image")) return failure("invalid_reference_type", "图片生成只支持图片和文本来源");
    if (action.name === "edit_image" && !sources.some((item) => item.kind === "image" && mediaSource(item))) return failure("image_reference_required", "图片编辑需要至少一个已有内容的图片节点");
    const model = configuredMediaModel(config, mode);
    if (!model && options.config.autoGenerateMedia !== false) return failure("model_not_configured", `请先配置${mode === "image" ? "图片" : "视频"}模型`);
    const size = stringValue(args.size) || (mode === "image" ? options.config.imageSize || config.size : options.config.videoSize || config.size);
    if (!size) return failure("size_required", "请先配置生成尺寸");
    const seconds = args.seconds === undefined ? Number(config.videoSeconds) : Number(args.seconds);
    if (mode === "video" && !isVideoDurationSupported(config, seconds)) {
        const range = readVideoDurationRange(config);
        return failure("unsupported_video_duration", `当前视频模型不支持 ${seconds} 秒，请使用 ${range.min === range.max ? range.min : `${range.min}–${range.max}`} 秒`, { videoDuration: range });
    }
    const styleIds = options.config.generationStyleIdsByType?.[mode] || [];
    const styleSnapshots = (options.config.generationStyleSnapshots || options.config.styleSnapshots || []).filter((style) => style.generationType === mode);
    const imageSources = sources.filter((item) => item.kind === "image");
    const attributes: CanvasAgentOp["attributes"] = {
        prompt, model, size, status: "idle", generationStyleIds: [...styleIds], generationStyleSnapshots: styleSnapshots,
        ...(mode === "image" ? {
            generationType: imageSources.length ? "edit" : "generation", quality: config.quality, imageResolution: config.imageResolution,
            count: args.count === undefined ? Math.max(1, Math.min(15, Number(config.canvasImageCount || config.count) || 1)) : Number(args.count),
            references: imageSources.map(mediaSource), referenceObjectStorages: imageSources.flatMap((item) => item.kind === "image" && item.content.objectStorage ? [item.content.objectStorage] : []),
        } : { seconds: String(seconds), vquality: config.vquality, videoGenerationMode: config.videoGenerationMode, watermark: config.videoWatermark, generateAudio: config.videoGenerateAudio, count: Number(config.canvasVideoCount) || 1 }),
    };
    const settingGraphId = mode === "image" ? options.config.settingGraphNodeId : undefined;
    const id = settingGraphId || `${mode}-${createId()}`;
    if (settingGraphId) {
        const target = snapshot.nodes.find((item) => item.id === settingGraphId);
        if (!target || target.kind !== "image") return failure("setting_graph_not_found", "设定图目标节点不存在或不是图片节点");
        if (target.execution.phase === "running") return failure("generation_in_progress", "设定图节点正在生成，请等待当前任务完成");
        if (sourceIds.includes(id)) return failure("self_connection", "设定图节点不能引用自身");
        if (options.config.settingGraphSkillSnapshot) attributes.settingGraph = options.config.settingGraphSkillSnapshot;
        attributes.count = 1;
    }
    const ops: CanvasAgentOp[] = [settingGraphId
        ? { type: "update_node", id, attributes }
        : { type: "add_node", id, nodeType: mode, title: stringValue(args.title) || (mode === "image" ? "图片" : "视频"), position: nextPosition(snapshot, sources), attributes },
        ...connectionOps(sourceIds, id, createId).filter((op) => !snapshot.connections.some((edge) => edge.source.nodeId === op.sourceNodeId && edge.target.nodeId === id)),
    ];
    const autoGenerate = options.config.autoGenerateMedia !== false;
    if (autoGenerate) ops.push({ type: "run_generation", nodeId: id, mode, prompt, generationStyleIds: [...styleIds], generationStyleSnapshots: styleSnapshots });
    const application = await apply(ops);
    const created = createdNodeResult(application.snapshot, id, sourceIds);
    if (!created.ok) return created;
    const hostResult = application.result ? safeHostResult(application.result) : undefined;
    if (hostResult?.ok === false) return { ...created, ...hostResult, ...(hostResult.data || {}), ok: false };
    const target = application.snapshot.nodes.find((item) => item.id === id)!;
    if (autoGenerate && target.execution.phase === "failed") return { ...created, ok: false, code: "generation_failed", message: target.execution.errorMessage || "媒体生成失败", ...taskSummary(target) };
    return { ...created, ...(hostResult || {}), ...(hostResult?.data || {}), ...taskSummary(target), ok: true, autoGenerateMedia: autoGenerate };
}

async function executeSpeech(action: CanvasAgentAction, snapshot: CanvasAgentSnapshot, options: InfiniteCanvasActionOptions, apply: (ops: CanvasAgentOp[]) => Promise<{ snapshot: CanvasAgentSnapshot; result?: HostToolResult }>, validateIds: (ids: string[]) => CanvasNode[], createId: () => string): Promise<CanvasAgentToolResult> {
    const args = action.arguments;
    const sourceIds = strings(args.sourceNodeIds);
    const sources = validateIds(sourceIds);
    const text = stringValue(args.prompt).trim();
    if (text.length > MAX_SPEECH_TEXT_LENGTH) return failure("speech_text_too_long", `单段配音不能超过 ${MAX_SPEECH_TEXT_LENGTH} 字，请按台词拆分`);
    const autoGenerate = options.config.autoGenerateMedia !== false;
    const model = effectiveConfig(options.config).audioModel;
    if (!model && autoGenerate) return failure("model_not_configured", "请先配置语音模型");
    const id = `audio-${createId()}`;
    const ops: CanvasAgentOp[] = [
        { type: "add_node", id, nodeType: "audio", title: stringValue(args.title) || "配音", position: nextPosition(snapshot, sources),
            attributes: { speechText: text, speechModel: model, speechVoice: stringValue(args.voice) || DEFAULT_SPEECH_VOICE, speechInstructions: stringValue(args.instructions), status: "idle" } },
        ...connectionOps(sourceIds, id, createId),
    ];
    if (autoGenerate) ops.push({ type: "run_speech", nodeId: id });
    const application = await apply(ops);
    const created = createdNodeResult(application.snapshot, id, sourceIds);
    if (!created.ok) return created;
    const hostResult = application.result ? safeHostResult(application.result) : undefined;
    if (hostResult?.ok === false) return { ...created, ...hostResult, ok: false };
    const target = application.snapshot.nodes.find((item) => item.id === id)!;
    if (autoGenerate && target.execution.phase === "failed") return { ...created, ok: false, code: "generation_failed", message: target.execution.errorMessage || "配音生成失败", ...taskSummary(target) };
    return { ...created, ...taskSummary(target), ok: true, autoGenerateMedia: autoGenerate };
}

function createdNodeResult(snapshot: CanvasAgentSnapshot, id: string, sources: string[]): CanvasAgentToolResult {
    const node = snapshot.nodes.find((item) => item.id === id);
    if (!node) return failure("creation_failed", "画布未返回新节点");
    const connectionIds = sources.map((source) => snapshot.connections.find((edge) => edge.source.nodeId === source && edge.target.nodeId === id)?.id);
    if (connectionIds.some((connectionId) => !connectionId)) return failure("connection_failed", "来源连线未完整创建", { nodeId: id });
    return { ok: true, nodeId: id, connectionIds, node: summarizeNode(node, snapshot) };
}

function connectionOps(ids: string[], target: string, createId: () => string): CanvasAgentOp[] {
    return ids.map((sourceNodeId) => ({ type: "connect_nodes", id: createId(), sourceNodeId, targetNodeId: target }));
}

function summarizeNode(node: CanvasNode, snapshot: CanvasAgentSnapshot, textLimit = MAX_CONTEXT_TEXT): CanvasAgentContextNode & { textTruncated?: boolean; fullTextLength?: number; resultVideoNodeId?: string; inputVideoNodeIds?: string[] } {
    const result = node.kind === "videoComposition" ? compositionResult(node, snapshot) : undefined;
    const media = mediaSource(result || node);
    const group = snapshot.nodes.find((item) => item.kind === "background" && item.memberNodeIds.includes(node.id));
    const generation = node.kind === "image" || node.kind === "video" ? node.generation : undefined;
    const text = nodeText(node);
    return {
        id: node.id, type: upstreamNodeType(node), title: node.title,
        ...(text ? { text: text.slice(0, textLimit), ...(text.length > textLimit ? { textTruncated: true, fullTextLength: text.length } : {}) } : {}),
        ...(node.kind === "image" || node.kind === "video" || node.kind === "audio" || node.kind === "videoComposition" ? { hasMedia: Boolean(media), ...(media && !media.startsWith("data:") && !media.startsWith("blob:") ? { mediaUrl: media } : {}) } : {}),
        ...(node.kind === "videoComposition" ? { inputVideoNodeIds: [...node.composition.inputVideoNodeIds], ...(node.composition.resultVideoNodeId ? { resultVideoNodeId: node.composition.resultVideoNodeId } : {}) } : {}),
        status: statusByPhase[node.execution.phase],
        ...(nodePrompt(node) ? { prompt: nodePrompt(node).slice(0, MAX_CONTEXT_TEXT) } : {}),
        ...(generation ? { model: generation.model, size: generation.size } : {}),
        ...(node.kind === "audio" && node.speech ? { model: node.speech.model } : {}),
        ...(node.kind === "video" ? { seconds: node.generation.seconds } : {}),
        ...(node.execution.taskId ? { taskId: node.execution.taskId } : {}),
        ...(node.execution.errorMessage ? { error: node.execution.errorMessage } : {}),
        ...(group ? { groupId: group.id } : {}),
    };
}

function upstreamNodeType(node: CanvasNode): CanvasNodeType {
    return (node.kind === "background" ? "group" : node.kind === "storyboard" || node.kind === "videoComposition" ? "director" : node.kind) as CanvasNodeType;
}

function nodeText(node: CanvasNode): string {
    if (node.kind === "text") return node.content.text;
    if (node.kind === "storyboard") return JSON.stringify({ instruction: node.content.instruction, visualStyle: node.content.visualStyle, shots: node.storyboard.shots.map((shot) => ({ id: shot.id, shotNumber: shot.shotNumber, visualDescription: shot.visualDescription, durationSeconds: shot.durationSeconds, finalPrompt: shot.finalPrompt, assetIds: shot.assetIds })), assets: node.storyboard.assets.map((asset) => ({ id: asset.id, kind: asset.kind, name: asset.name, description: asset.description })) });
    if (node.kind === "videoComposition") return JSON.stringify(node.composition);
    if (node.kind === "background") return JSON.stringify({ memberNodeIds: node.memberNodeIds });
    return "";
}

function nodePrompt(node: CanvasNode) { return node.kind === "image" || node.kind === "video" ? node.generation.prompt : node.kind === "audio" ? node.speech?.text || "" : ""; }
function mediaSource(node: CanvasNode) { return node.kind === "image" || node.kind === "video" || node.kind === "audio" ? node.content.objectStorage?.url || node.content.source : ""; }
function taskSummary(node: CanvasNode, snapshot?: CanvasAgentSnapshot) {
    const result = node.kind === "videoComposition" ? compositionResult(node, snapshot) : undefined;
    return { nodeId: node.id, type: upstreamNodeType(node), status: statusByPhase[node.execution.phase], taskId: node.execution.taskId || "", ...(node.execution.progress === undefined ? {} : { progress: node.execution.progress }), ...(node.execution.errorMessage ? { error: node.execution.errorMessage } : {}),
        ...(node.kind === "videoComposition" ? { compositionNodeId: node.id, sourceNodeIds: [...node.composition.inputVideoNodeIds], resultReady: Boolean(result), ...(node.composition.resultVideoNodeId ? { resultVideoNodeId: node.composition.resultVideoNodeId } : {}), ...(result ? { mediaUrl: mediaSource(result), storageKey: result.content.storageKey } : {}) } : {}),
    };
}
function generationContext(config: InfiniteCanvasConfig): CanvasAgentContext["generation"] {
    const effective = effectiveConfig(config);
    return { autoGenerateMedia: config.autoGenerateMedia !== false, textModel: effective.agentModel || effective.textModel || effective.model, imageModel: configuredMediaModel(effective, "image"), videoModel: configuredMediaModel(effective, "video"), audioModel: effective.audioModel, imageQuality: effective.quality, imageSize: config.imageSize || effective.size, videoQuality: effective.vquality, videoSize: config.videoSize || effective.size, imageCount: effective.canvasImageCount || effective.count, videoSeconds: config.filmPlanning ? "" : effective.videoSeconds, ...(config.filmPlanning ? { filmPlanning: readFilmPlanningConstraints(effective) } : {}), videoGenerateAudio: "true", audioVoice: DEFAULT_SPEECH_VOICE, audioLanguage: "", audioFormat: "mp3", audioSpeed: "1" };
}
function configuredMediaModel(config: AiConfig, mode: "image" | "video") { return mode === "image" ? config.imageModel || (config.imageModels.includes(config.model) ? config.model : "") : config.videoModel || (config.videoModels.includes(config.model) ? config.model : ""); }

/** Generation receipts may contain actual request references; keep binary and credentials out of Agent memory. */
function safeHostResult(result: HostToolResult): HostToolResult {
    const data = safeValue(result.data, 0);
    return { ok: result.ok, message: result.message, ...(data && typeof data === "object" && !Array.isArray(data) ? { data: data as Record<string, unknown> } : {}) };
}
function safeValue(value: unknown, depth: number): unknown {
    if (depth > 6) return undefined;
    if (typeof value === "string") return /^(?:data:|blob:)/i.test(value) ? "[媒体内容已省略]" : value.slice(0, 32000);
    if (Array.isArray(value)) return value.slice(0, 60).map((item) => safeValue(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:apiKey|api_key|authorization|password|secret|accessToken|refreshToken)$/i.test(key)).map(([key, item]) => [key, safeValue(item, depth + 1)]));
    return value;
}
function effectiveConfig(config: InfiniteCanvasConfig): AiConfig {
    const merged = { ...defaultConfig, ...config, quality: config.imageQuality || config.quality || defaultConfig.quality };
    return { ...merged, audioModel: "", vquality: config.videoQuality || config.vquality || resolveVideoResolution(merged) };
}
function nextPosition(snapshot: CanvasAgentSnapshot, sources: CanvasNode[]) {
    if (sources.length) return { x: Math.max(...sources.map((node) => node.frame.position.x + node.frame.width)) + 120, y: Math.min(...sources.map((node) => node.frame.position.y)) };
    const k = snapshot.viewport.k > 0 ? snapshot.viewport.k : 1;
    return { x: -snapshot.viewport.x / k + 200, y: -snapshot.viewport.y / k + 120 };
}
function stringValue(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function strings(value: unknown) { return Array.isArray(value) ? value as string[] : []; }
function emptyState(): CanvasAgentState { return { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }; }
function failure(code: string, message: string, extra: Record<string, unknown> = {}): CanvasAgentToolResult { return { ok: false, code, message, ...extra }; }
function throwIfAborted(signal: AbortSignal) { if (signal.aborted) throw new DOMException("画布操作已停止", "AbortError"); }
class AdapterError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
