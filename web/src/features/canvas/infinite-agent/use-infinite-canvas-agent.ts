"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { getCurrentUserInfo, getSkill, listSkills } from "@/services/api/server";
import type { AgentChatHistoryMessage, CreationSettings } from "../api/agent";
import type { CanvasAgentSkillSelection, CanvasAgentSkillSource, CanvasAssistantReference, CanvasAssistantSession } from "../types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import type { CanvasAgentToolResult as HostToolResult } from "../utils/canvas-agent-tools";
import { buildInfiniteCanvasContext, executeInfiniteCanvasAction, supportedCanvasAgentTools } from "./canvas-adapter";
import { createCanvasAgentState, runCanvasAgent } from "./upstream/canvas-agent-runtime";
import { InfiniteAgentRunGuard, recoverInfiniteAgentMemory, type InfiniteAgentMemory } from "./session";
import { createCanvasAgentSkillDiscovery } from "./skill-discovery";
import { CANVAS_AGENT_SKILL_DISCOVERY_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL } from "./upstream/canvas-agent-tools";
import { finishOneSentenceFilm, mergeOneSentenceFilmNodes, recordOneSentenceFilmAction, recordOneSentenceFilmOperations, resolveOneSentenceFilmRequest } from "./one-sentence-film";
import { applyFilmModels, defaultFilmModels, filmModelSelectionError } from "./film-model-selection";

type Props = {
    config: AiConfig;
    getSnapshot: () => CanvasAgentSnapshot;
    getSession: () => CanvasAssistantSession | undefined;
    onCheckpoint: (sessionId: string, memory: InfiniteAgentMemory) => void;
    onSkillsActivated: (sessionId: string, skills: CanvasAgentSkillSelection[], source: CanvasAgentSkillSource, userMessageId?: string) => void;
    onApplyOps: (ops: CanvasAgentOp[] | undefined, signal: AbortSignal) => Promise<{ snapshot: CanvasAgentSnapshot; result?: HostToolResult }>;
    onFocusNodes?: (nodeIds: string[]) => void;
    onTaskComplete: (messageId: string, text: string) => void;
    onCanceled: () => void;
    onQueueStatus: (status: "queued" | "running") => void;
    onError: (message: string) => void;
};

/** Runs the vendored upstream Agent; only model transport and canvas tools are adapted. */
export function useInfiniteCanvasAgent(props: Props) {
    const latest = useRef(props);
    latest.current = props;
    const guard = useRef(new InfiniteAgentRunGuard());
    const [activity, setActivity] = useState("");
    useEffect(() => () => guard.current.cancel(), []);

    const sendMessage = useCallback(async (
        message: string,
        references: CanvasAssistantReference[] = [],
        model?: string,
        history: AgentChatHistoryMessage[] = [],
        generationStyleIdsByType?: { image?: number[]; video?: number[] },
        settings?: Omit<CreationSettings, "model" | "generationStyleIdsByType">,
        skills: CanvasAgentSkillSelection[] = [],
    ) => {
        const current = latest.current;
        const session = current.getSession();
        if (!session) throw new Error("对话尚未准备好，请稍后重试");
        const old = recoverInfiniteAgentMemory(session.infiniteAgent);
        const filmRequest = resolveOneSentenceFilmRequest(message, old?.film);
        const fullFilm = filmRequest?.film.pipelineMode === "full";
        const filmModels = fullFilm ? (filmRequest.resume ? filmRequest.film.models : settings?.filmModels) || defaultFilmModels(current.config) : undefined;
        if (filmModels) {
            const error = filmModelSelectionError(current.config, filmModels);
            if (error) throw new Error(error);
            filmRequest!.film.models = { ...filmModels };
        }
        const chosenModel = filmModels?.textModel || model || current.config.agentModel || current.config.textModel;
        if (!chosenModel) throw new Error("请先选择画布助手的文本模型");
        const controller = guard.current.start();
        if (!controller) return false;
        const fullFilmOnly = new Set(["plan_film_story", "create_film_workflow", "run_film_workflow"]);
        // The workflow already places each shot in text/image/video columns. A generic
        // dependency layout would shift shared-reference shots into different columns.
        const fullFilmBypass = new Set(["create_primary_script_node", "create_text_node", "generate_image", "edit_image", "generate_video", "compose_videos", "delete_node", "delete_connection", "create_group", "arrange_nodes"]);
        const tools = [...supportedCanvasAgentTools.filter(tool => fullFilm ? !fullFilmBypass.has(tool.function.name) : !fullFilmOnly.has(tool.function.name)), ...CANVAS_AGENT_SKILL_DISCOVERY_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL];
        const userMessageId = session.messages.findLast(item => item.role === "user")?.id;
        let reportSkillsActivated: (skills: CanvasAgentSkillSelection[], source: CanvasAgentSkillSource) => void = () => undefined;
        // Validate selected skills before accepting the draft or making a paid model call.
        // A missing/disabled skill must not silently turn into the default workflow.
        let discovery: Awaited<ReturnType<typeof createCanvasAgentSkillDiscovery>>;
        try {
            if (skills.length) setActivity("正在加载所选技能");
            discovery = await createCanvasAgentSkillDiscovery({
                manualSelections: skills, fetchSkill: getSkill, signal: controller.signal, tools,
                fetchCatalogue: async () => {
                    const results = await Promise.allSettled((["image", "video", "canvasSettingGraph"] as const).map(type => listSkills(type, controller.signal)));
                    controller.signal.throwIfAborted();
                    const failed = results.find(result => result.status === "rejected");
                    if (failed?.status === "rejected") throw failed.reason;
                    return results.flatMap(result => result.status === "fulfilled" ? result.value.skills : []);
                },
                onSkillsActivated: (selected, source) => reportSkillsActivated(selected, source),
            });
            controller.signal.throwIfAborted();
        } catch (error) {
            guard.current.finish(controller);
            setActivity("");
            if (controller.signal.aborted) throw new Error("已取消技能加载，输入内容已保留");
            throw error;
        }
        const requestId = nanoid();
        const baseRunConfig = {
            ...current.config, agentModel: chosenModel, textModel: chosenModel,
            // Canvas speech is paused even when a global or saved speech model exists.
            audioModel: "",
            filmPlanning: fullFilm,
            ...(filmRequest ? { canvasImageCount: "1", canvasVideoCount: "1" } : {}),
            videoModel: settings?.videoModel || current.config.videoModel,
            videoSeconds: settings?.seconds || current.config.videoSeconds,
            videoGenerationMode: settings?.videoGenerationMode || current.config.videoGenerationMode,
            imageModel: settings?.imageModel || current.config.imageModel,
            imageSize: settings?.imageSize || (settings?.settingGraphNodeId ? settings.size || settings.settingGraphSkillSnapshot?.aspectRatio : undefined) || current.config.size,
            imageResolution: settings?.imageResolution || (settings?.settingGraphNodeId ? settings.resolution : undefined) || current.config.imageResolution,
            imageQuality: settings?.imageQuality || (settings?.settingGraphNodeId ? settings.quality : undefined) || current.config.quality,
            videoSize: settings?.size || current.config.size,
            generationStyleIdsByType,
            generationStyleSnapshots: settings?.generationStyleSnapshots,
            settingGraphNodeId: settings?.settingGraphNodeId,
            settingGraphSkillSnapshot: settings?.settingGraphSkillSnapshot,
        };
        const config = filmModels ? { ...baseRunConfig, ...applyFilmModels(baseRunConfig, filmModels) } : baseRunConfig;
        let memory: InfiniteAgentMemory = {
            state: filmRequest && !filmRequest.resume ? createCanvasAgentState() : old?.state || createCanvasAgentState(),
            protocolMessages: old?.protocolMessages || history.map(item => ({ role: item.role, content: item.text })),
            contextCheckpoint: old?.contextCheckpoint, jsonFallbackMode: old?.jsonFallbackMode,
            activeSkills: discovery.currentSelections, skillSource: skills.length ? "manual" : undefined,
            film: filmRequest ? mergeOneSentenceFilmNodes(filmRequest.film, references.map(reference => reference.id).filter(id => current.getSnapshot().nodes.some(node => node.id === id))) : old?.film,
            requestId, status: "running", updatedAt: new Date().toISOString(),
        };
        const save = (patch: Partial<InfiniteAgentMemory>) => {
            memory = { ...memory, ...patch, updatedAt: new Date().toISOString() };
            current.onCheckpoint(session.id, memory);
        };
        reportSkillsActivated = (selected, source) => {
            save({ activeSkills: selected, skillSource: source });
            current.onSkillsActivated(session.id, selected, source, userMessageId);
        };
        save({});
        if (discovery.currentSelections.length) reportSkillsActivated(discovery.currentSelections, "manual");
        current.onQueueStatus("running");
        setActivity(filmRequest ? filmRequest.resume ? "正在检查已有成片进度" : "正在规划故事与镜头" : "正在理解画布和创作目标");
        // Return acceptance immediately so the composer clears once, while the loop continues.
        void (async () => {
            let workflowRunResult: Awaited<ReturnType<typeof executeInfiniteCanvasAction>> | undefined;
            try {
                const result = await runCanvasAgent({
                    config: { ...config, model: chosenModel },
                    initialState: memory.state,
                    protocolMessages: memory.protocolMessages,
                    contextCheckpoint: memory.contextCheckpoint,
                    preferredJsonMode: memory.jsonFallbackMode,
                    oneSentenceFilm: filmRequest ? { getFilm: () => memory.film!, resume: filmRequest.resume } : undefined,
                    userText: (settings?.settingGraphNodeId
                        ? `${message}\n本次只更新设定图节点 ${settings.settingGraphNodeId}，直接引用该节点已有上游素材，不新建重复图片节点。`
                        : message) + `\n\n${discovery.userGuidance}`
                        + (!skills.length && old?.activeSkills?.length ? `\n上一轮使用的技能：${JSON.stringify(old.activeSkills)}。这些仅为续写线索，本轮请重新搜索并启用，以确认最新内容和启用状态。` : ""),
                    references: references.filter(reference => ["text", "image", "video", "audio"].includes(reference.type)) as Parameters<typeof runCanvasAgent>[0]["references"],
                    getActiveSkillContents: () => discovery.activeSkillContents,
                    getUnreadRequiredSkillFiles: () => discovery.unreadRequiredFiles,
                    tools,
                    getContext: state => buildInfiniteCanvasContext(current.getSnapshot(), state, config),
                    executeAction: async action => {
                        controller.signal.throwIfAborted();
                        if (!tools.some(tool => tool.function.name === action.name)) return { ok: false, code: "film_workflow_required", message: fullFilm ? "一句话成片必须先创建完整文本、图片、视频工作流，再执行 run_film_workflow，不可跳过步骤" : "当前模式不提供此工具" };
                        if (action.name === "run_film_workflow" && workflowRunResult) return { ...workflowRunResult, reused: true, message: workflowRunResult.ok ? "本轮工作流已执行，已复用原有结果" : "本轮工作流已停止，已有节点和失败信息已保留；用户点击继续成片后再恢复，未重复提交" };
                        if (["search_skills", "activate_skills", "read_skill_file"].includes(action.name)) return discovery.executeTool(action.name as "search_skills" | "activate_skills" | "read_skill_file", action.arguments);
                        const beforeIds = new Set(current.getSnapshot().nodes.map(node => node.id));
                        const newReservationIds = new Set<string>();
                        const observedIds = new Set(beforeIds);
                        let actionResult: Awaited<ReturnType<typeof executeInfiniteCanvasAction>> | undefined;
                        try {
                            actionResult = await executeInfiniteCanvasAction(action, {
                                getSnapshot: current.getSnapshot,
                                onApplyOps: async (ops, signal) => {
                                    if (filmRequest && memory.film) {
                                        const priorIds = new Set(memory.film.nodeIds);
                                        const reserved = recordOneSentenceFilmOperations(memory.film, ops);
                                        reserved.nodeIds.filter(id => !priorIds.has(id)).forEach(id => newReservationIds.add(id));
                                        save({ film: reserved });
                                    }
                                    const pending = current.onApplyOps(ops, signal);
                                    // The host places nodes before awaiting generation; preserve that evidence
                                    // even if the task fails or the user removes a node while it is running.
                                    current.getSnapshot().nodes.forEach(node => observedIds.add(node.id));
                                    const applied = await pending;
                                    applied.snapshot.nodes.forEach(node => observedIds.add(node.id));
                                    return applied;
                                },
                                config, signal: controller.signal, filmWorkflow: memory.film?.workflow, filmStoryPlan: memory.film?.storyPlan,
                                setAgentState: patch => save({ state: { ...memory.state, ...patch } }),
                            });
                            if (action.name === "run_film_workflow") workflowRunResult = actionResult;
                            if (action.name === "create_film_workflow" && actionResult.ok && Array.isArray(actionResult.nodeIds)) {
                                current.onFocusNodes?.(actionResult.nodeIds.filter((id): id is string => typeof id === "string"));
                            }
                            return actionResult;
                        } finally {
                            // Even canceled generation may already have created a node or submitted a task.
                            if (filmRequest && memory.film) {
                                const snapshot = current.getSnapshot();
                                snapshot.nodes.forEach(node => observedIds.add(node.id));
                                const neverCreated = new Set([...newReservationIds].filter(id => !observedIds.has(id)));
                                save({ film: recordOneSentenceFilmAction(memory.film, action, actionResult, beforeIds, snapshot.nodes, neverCreated) });
                            }
                        }
                    },
                    onEvent: event => { if (!controller.signal.aborted) setActivity(event.label); },
                    onCheckpoint: checkpoint => save(checkpoint),
                    signal: controller.signal,
                });
                controller.signal.throwIfAborted();
                const { reply, ...checkpoint } = result;
                if (filmRequest && memory.film) {
                    const finalSnapshot = current.getSnapshot();
                    const verified = finishOneSentenceFilm(memory.film, finalSnapshot.nodes, finalSnapshot.connections);
                    // Persist the verified statement too, so a later turn cannot inherit a false success claim.
                    const messages = [...checkpoint.protocolMessages];
                    if (messages.at(-1)?.role === "assistant") messages[messages.length - 1] = { role: "assistant", content: verified.reply };
                    else messages.push({ role: "assistant", content: verified.reply });
                    save({ ...checkpoint, protocolMessages: messages, film: verified.film, status: verified.film.status === "completed" ? "completed" : "interrupted" });
                    current.onTaskComplete(requestId, verified.reply);
                } else {
                    save({ ...checkpoint, status: "completed" });
                    current.onTaskComplete(requestId, reply);
                }
            } catch (error) {
                save({ status: "interrupted", ...(filmRequest && memory.film ? { film: { ...memory.film, status: "interrupted" as const } } : {}) });
                if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) current.onCanceled();
                else current.onError(error instanceof Error ? error.message : "画布助手执行失败");
            } finally {
                guard.current.finish(controller);
                setActivity("");
                // Text turns use their own billed endpoint, outside the media task balance feed.
                if (useUserStore.getState().token) void getCurrentUserInfo().then(user => {
                    const store = useUserStore.getState();
                    if (store.user?.id === String(user.id)) store.setUser(user);
                }).catch(() => undefined);
            }
        })();
        return true;
    }, []);

    const cancelMessage = useCallback(async () => { guard.current.cancel(); setActivity("正在停止当前操作"); }, []);
    const resetSession = useCallback(() => !guard.current.running, []);
    return { sendMessage, cancelMessage, resetSession, activity };
}
