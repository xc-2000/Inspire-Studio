import { nanoid } from "nanoid";
import { defaultConfig, type AiConfig } from "@/features/settings/stores/use-config-store";
import { resolveVideoResolution } from "@/features/settings/lib/video-resolution-configuration";
import { quoteVideoGeneration, videoModelSupportsMode } from "@/features/generation/lib/video-billing";
import type { CanvasAudioNode, CanvasNode, CanvasImageNode, CanvasVideoNode, CanvasVideoCompositionNode } from "../types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import type { CanvasAgentToolResult as HostToolResult } from "../utils/canvas-agent-tools";
import type { InfiniteCanvasConfig } from "./canvas-adapter";
import type { CanvasAgentToolResult } from "./upstream/canvas-agent-tools";
import { readFilmPlanningConstraints } from "./film-planning";
import type { FilmStoryAsset } from "./film-story-plan";

export type FilmWorkflow = {
    scriptNodeId: string;
    shots: { textNodeId: string; imageNodeId: string; videoNodeId: string; referenceImageNodeIds?: string[] }[];
    assets?: { assetId: string; imageNodeId: string; reused: boolean }[];
    productionVersion?: "tapcanvas-adapted/v1";
    compositionNodeId?: string;
    /** 每句对白/旁白对应的配音音频节点，最终合成时按时间轴叠加。 */
    voiceover?: { lineId: string; audioNodeId: string }[];
};
/** 一句配音：成片时间轴起点与可用时长由已冻结剧情的事件时间换算。 */
export type FilmVoiceLine = {
    lineId: string; beatId: string; speaker: string; text: string;
    delivery: "on_screen" | "off_screen" | "voice_over"; voice: string;
    startMs: number; maxDurationMs: number;
};
/** 与合成服务端上限一致。 */
const MAXIMUM_VOICE_LINES = 60;
export type FilmWorkflowInput = {
    title: string;
    script: string;
    aspectRatio?: string;
    targetDurationSeconds?: number;
    durationRationale?: string;
    shots: { title: string; description: string; imagePrompt: string; videoPrompt: string; seconds: number; referenceAssetIds?: string[]; dubbedVideoPrompt?: string }[];
    assets?: FilmStoryAsset[];
    productionVersion?: "tapcanvas-adapted/v1";
    sourceNodeIds?: string[];
    /** 需要配音的台词与旁白；未配置语音模型时不创建配音节点。 */
    voiceover?: FilmVoiceLine[];
};
export type FilmWorkflowOptions = {
    getSnapshot: () => CanvasAgentSnapshot;
    onApplyOps: (ops: CanvasAgentOp[] | undefined, signal: AbortSignal) => Promise<{ snapshot: CanvasAgentSnapshot; result?: HostToolResult }>;
    config: InfiniteCanvasConfig;
    signal?: AbortSignal;
    createId?: () => string;
};

/** Materialize every planned step first; model availability is checked before paid execution. */
export async function createFilmWorkflow(input: FilmWorkflowInput, options: FilmWorkflowOptions): Promise<CanvasAgentToolResult> {
    const signal = options.signal || new AbortController().signal;
    let attemptedWorkflow: FilmWorkflow | undefined;
    try {
        signal.throwIfAborted();
        const config = effectiveConfig(options.config);
        const title = requiredText(input?.title, "成片标题"), script = requiredText(input?.script, "主剧本");
        if (!Array.isArray(input?.shots) || input.shots.length < 1 || input.shots.length > 20) throw new FilmError("invalid_film_plan", "成片需要 1 至 20 个完整镜头");
        const shots = Array.from(input.shots, (shot, index) => {
            const prefix = `镜头 ${index + 1}`;
            const value = { title: requiredText(shot?.title, `${prefix}标题`), description: requiredText(shot?.description, `${prefix}描述`), imagePrompt: requiredText(shot?.imagePrompt, `${prefix}图片提示词`), videoPrompt: requiredText(shot?.videoPrompt, `${prefix}视频提示词`), seconds: shot?.seconds, referenceAssetIds: shot?.referenceAssetIds || [], dubbedVideoPrompt: typeof shot?.dubbedVideoPrompt === "string" && shot.dubbedVideoPrompt.trim() ? shot.dubbedVideoPrompt.trim() : undefined };
            validateSeconds(value.seconds, config, config.videoModel);
            return value;
        });
        const totalSeconds = shots.reduce((sum, shot) => sum + shot.seconds, 0);
        if (input.targetDurationSeconds !== undefined && (!Number.isSafeInteger(input.targetDurationSeconds) || input.targetDurationSeconds !== totalSeconds)) {
            throw new FilmError("film_duration_mismatch", `镜头时长合计 ${totalSeconds} 秒，与计划总时长 ${input.targetDurationSeconds} 秒不一致，请重新编排；尚未创建节点或提交生成`);
        }
        const timing = `成片计划：${shots.length} 个镜头，共 ${totalSeconds} 秒。${input.durationRationale?.trim() ? `\n时长依据：${input.durationRationale.trim()}` : ""}`;
        const snapshot = options.getSnapshot();
        const sourceIds = uniqueSourceIds(input.sourceNodeIds);
        const sourceNodes = sourceIds.map(id => {
            const node = snapshot.nodes.find(item => item.id === id);
            if (!node) throw new FilmError("node_not_found", `参考节点不存在：${id}`);
            if (node.kind !== "image" && node.kind !== "text") throw new FilmError("invalid_film_reference", "完整成片流程只接受文本和图片参考节点");
            return node;
        });
        for (const asset of input.assets || []) {
            if (asset.sourceNodeId && !readyMedia(snapshot.nodes.find(node => node.id === asset.sourceNodeId && node.kind === "image"))) throw new FilmError("film_reference_unavailable", `「${asset.name}」的原图未就绪，未替换为无参考生图`);
        }
        const createId = options.createId || nanoid;
        const reserved = new Set(snapshot.nodes.map(node => node.id));
        const id = (kind: string) => {
            const value = `${kind}-${createId()}`;
            if (reserved.has(value)) throw new FilmError("duplicate_node_id", "无法分配独立节点 ID，请重试");
            reserved.add(value);
            return value;
        };
        const assetBindings = (input.assets || []).map(asset => ({ assetId: asset.id, imageNodeId: asset.sourceNodeId || id("image"), reused: Boolean(asset.sourceNodeId) }));
        const plannedVoice = Array.isArray(input.voiceover) ? input.voiceover.filter(line => line && typeof line.text === "string" && line.text.trim()) : [];
        if (plannedVoice.length > MAXIMUM_VOICE_LINES) throw new FilmError("invalid_film_plan", `配音最多 ${MAXIMUM_VOICE_LINES} 句，请合并台词或减少旁白`);
        const voiceLines = config.audioModel ? plannedVoice : [];
        const voiceover = voiceLines.map(line => ({ lineId: line.lineId, audioNodeId: id("audio") }));
        const workflow: FilmWorkflow = {
            scriptNodeId: id("text"),
            shots: shots.map(shot => ({ textNodeId: id("text"), imageNodeId: id("image"), videoNodeId: id("video"), ...(input.productionVersion ? { referenceImageNodeIds: [...new Set(shot.referenceAssetIds.map(assetId => {
                const binding = assetBindings.find(asset => asset.assetId === assetId);
                if (!binding) throw new FilmError("film_reference_unavailable", `未找到共享资产 ${assetId}`);
                return binding.imageNodeId;
            }))] } : {}) })),
            ...(input.productionVersion ? { productionVersion: input.productionVersion, assets: assetBindings } : {}),
            ...(shots.length > 1 || voiceover.length ? { compositionNodeId: id("composition") } : {}),
            ...(voiceover.length ? { voiceover } : {}),
        };
        attemptedWorkflow = workflow;
        const zoom = snapshot.viewport.k > 0 ? snapshot.viewport.k : 1;
        const x = -snapshot.viewport.x / zoom + 100;
        const y = snapshot.nodes.length ? Math.max(...snapshot.nodes.map(node => node.frame.position.y + node.frame.height)) + 160 : -snapshot.viewport.y / zoom + 100;
        const ops: CanvasAgentOp[] = [{ type: "add_node", id: workflow.scriptNodeId, nodeType: "text", title, position: { x, y }, width: 360, height: 420, attributes: { content: `${script}\n\n${timing}`, status: "success", textRole: "text" } }];
        const edges: CanvasAgentOp[] = [];
        const connect = (sourceNodeId: string, targetNodeId: string) => edges.push({ type: "connect_nodes", id: `edge-${createId()}`, sourceNodeId, targetNodeId });
        assetBindings.forEach((binding, index) => {
            if (binding.reused) return;
            const asset = input.assets![index];
            ops.push({ type: "add_node", id: binding.imageNodeId, nodeType: "image", title: `共享${asset.kind === "character" ? "角色" : asset.kind === "scene" ? "场景" : "道具"} · ${asset.name}`, position: { x, y: y + 500 + index * 320 }, width: 360, height: 240, attributes: {
                includeUpstreamText: false, prompt: asset.imagePrompt, model: config.imageModel, size: input.aspectRatio || options.config.imageSize || config.size, quality: config.quality, imageResolution: config.imageResolution,
                count: 1, status: "idle", generationType: "generation", ...styleAttributes(options.config, "image"),
            } });
            connect(workflow.scriptNodeId, binding.imageNodeId);
        });
        sourceNodes.filter(node => node.kind === "text").forEach(node => connect(node.id, workflow.scriptNodeId));
        const imageReferences = sourceNodes.filter((node): node is CanvasImageNode => node.kind === "image");
        let elapsedSeconds = 0;
        shots.forEach((shot, index) => {
            const ids = workflow.shots[index], rowY = y + index * 380;
            ops.push(
                { type: "add_node", id: ids.textNodeId, nodeType: "text", title: `镜头 ${index + 1} · ${shot.title}`, position: { x: x + 500, y: rowY }, width: 320, height: 240, attributes: { content: `${shot.description}\n\n时间轴：${elapsedSeconds}–${elapsedSeconds + shot.seconds} 秒\n时长：${shot.seconds} 秒`, status: "success", textRole: "text" } },
                { type: "add_node", id: ids.imageNodeId, nodeType: "image", title: `镜头 ${index + 1} · 图片`, position: { x: x + 960, y: rowY }, width: 360, height: 240, attributes: {
                    includeUpstreamText: false, prompt: shot.imagePrompt, model: config.imageModel, size: input.aspectRatio || options.config.imageSize || config.size, quality: config.quality, imageResolution: config.imageResolution,
                    count: 1, status: "idle", generationType: input.productionVersion ? (ids.referenceImageNodeIds?.length ? "edit" : "generation") : imageReferences.length || index > 0 ? "edit" : "generation", ...styleAttributes(options.config, "image"),
                } },
                { type: "add_node", id: ids.videoNodeId, nodeType: "video", title: `镜头 ${index + 1} · 视频`, position: { x: x + 1460, y: rowY }, width: 360, height: 240, attributes: {
                    // 有后期配音时用去掉台词原文的提示词，避免视频模型自己把台词念出来。
                    includeUpstreamText: false, prompt: voiceover.length && shot.dubbedVideoPrompt ? shot.dubbedVideoPrompt : shot.videoPrompt, model: config.videoModel, size: input.aspectRatio || options.config.videoSize || config.size, seconds: String(shot.seconds), vquality: config.vquality,
                    count: 1, status: "idle", videoGenerationMode: "image-to-video", watermark: config.videoWatermark, generateAudio: config.videoGenerateAudio, ...styleAttributes(options.config, "video"),
                } },
            );
            connect(workflow.scriptNodeId, ids.textNodeId);
            connect(ids.textNodeId, ids.imageNodeId);
            if (input.productionVersion) (ids.referenceImageNodeIds || []).forEach(source => connect(source, ids.imageNodeId));
            else {
                imageReferences.forEach(node => connect(node.id, ids.imageNodeId));
                if (index > 0) connect(workflow.shots[0].imageNodeId, ids.imageNodeId);
            }
            connect(ids.imageNodeId, ids.videoNodeId);
            if (workflow.compositionNodeId) connect(ids.videoNodeId, workflow.compositionNodeId);
            elapsedSeconds += shot.seconds;
        });
        const voiceRowY = y + shots.length * 380 + 40;
        voiceLines.forEach((line, index) => {
            const audioNodeId = voiceover[index].audioNodeId;
            ops.push({ type: "add_node", id: audioNodeId, nodeType: "audio", title: `配音 · ${line.speaker}：${line.text.length > 14 ? `${line.text.slice(0, 14)}…` : line.text}`,
                position: { x: x + 500 + (index % 4) * 380, y: voiceRowY + Math.floor(index / 4) * 200 }, width: 340, height: 170,
                attributes: { speechText: line.text.trim(), speechVoice: line.voice, speechSpeaker: line.speaker, speechModel: "", timelineStartMs: Math.max(0, Math.round(line.startMs)), status: "idle" } });
            connect(workflow.scriptNodeId, audioNodeId);
            if (workflow.compositionNodeId) connect(audioNodeId, workflow.compositionNodeId);
        });
        // 有配音时视频原声默认静音：视频模型即使仍念了台词也不会和配音重复；需要环境音可在合成节点调高。
        if (workflow.compositionNodeId) ops.push({ type: "add_node", id: workflow.compositionNodeId, nodeType: "videoComposition", title: `${title} · 成片`, position: { x: x + 1980, y }, width: 340, height: 240, ...(voiceover.length ? { attributes: { compositionOriginalVolume: 0 } } : {}) });
        const applied = await options.onApplyOps([...ops, ...edges], signal);
        signal.throwIfAborted();
        if (applied.result?.ok === false) return hostFailure(applied.result, workflow);
        validateGraph(workflow, applied.snapshot);
        const voiceNote = voiceover.length ? `，以及 ${voiceover.length} 段配音` : plannedVoice.length ? "；当前没有默认语音模型，台词与旁白不会配音" : "";
        return { ok: true, status: "planned", workflow, nodeIds: workflowNodeIds(workflow), shotCount: shots.length, totalSeconds, shotSeconds: shots.map(shot => shot.seconds), voiceLineCount: voiceover.length, message: `已按AI计划创建主剧本、逐镜文本、图片、视频和成片节点${voiceNote}` };
    } catch (error) {
        const result = errorResult(error, signal);
        const existing = new Set(options.getSnapshot().nodes.map(node => node.id));
        return attemptedWorkflow && workflowNodeIds(attemptedWorkflow).some(id => existing.has(id))
            ? { ...result, workflow: attemptedWorkflow, nodeIds: workflowNodeIds(attemptedWorkflow).filter(id => existing.has(id)) } : result;
    }
}

/** Execute the reserved node IDs in dependency order; the host keeps its existing concurrency limit. */
export async function runFilmWorkflow(workflow: FilmWorkflow, options: FilmWorkflowOptions): Promise<CanvasAgentToolResult> {
    const signal = options.signal || new AbortController().signal;
    try {
        signal.throwIfAborted();
        validateGraph(workflow, options.getSnapshot());
        if (options.config.autoGenerateMedia === false) return { ok: true, status: "planned", workflow, nodeIds: workflowNodeIds(workflow), message: "完整流程图已保留，自动生成已关闭，尚未提交付费任务" };
        const running = workflowNodeIds(workflow).map(id => options.getSnapshot().nodes.find(node => node.id === id)).filter(node => node?.execution.phase === "running");
        if (running.length) return { ok: false, code: "film_workflow_running", status: "waiting", workflow, nodeIds: running.map(node => node!.id), message: "已有任务仍在执行，等待完成后继续，未重复提交" };
        const config = effectiveConfig(options.config);
        // Check all outstanding video requirements before creating paid images.
        for (const asset of workflow.assets || []) {
            const image = findMedia(options.getSnapshot(), asset.imageNodeId, "image");
            if (asset.reused && !readyMedia(image)) throw new FilmError("film_reference_unavailable", "用户原图未就绪，请恢复原图；未用新图片替代");
            if (!readyMedia(image) && !(image.generation.model || config.imageModel)) throw new FilmError("model_not_configured", "请先配置共享资产的图片模型");
        }
        const pendingVoice = (workflow.voiceover || []).filter(item => !readyAudio(options.getSnapshot().nodes.find(node => node.id === item.audioNodeId)));
        if (pendingVoice.length && !config.audioModel) throw new FilmError("model_not_configured", "成片包含配音，但当前没有默认语音模型；请在后台接入语音模型后继续，完整流程图已保留");
        for (const shot of workflow.shots) {
            const image = findMedia(options.getSnapshot(), shot.imageNodeId, "image");
            const video = findMedia(options.getSnapshot(), shot.videoNodeId, "video");
            if (!readyMedia(image) && !(image.generation.model || config.imageModel)) throw new FilmError("model_not_configured", "请先配置图片模型，完整流程图已保留");
            if (!readyMedia(video)) {
                const model = video.generation.model || config.videoModel;
                if (!model) throw new FilmError("model_not_configured", "请先配置视频模型，完整流程图已保留");
                if (!videoModelSupportsMode(config, model, "image-to-video")) throw new FilmError("image_to_video_unsupported", "当前视频模型未配置图生视频能力或价格，请配置后继续；未切换模型");
                validateSeconds(Number(video.generation.seconds), config, model);
                const quote = quoteVideoGeneration({ config, model, mode: "image-to-video", resolution: video.generation.quality || config.vquality, seconds: video.generation.seconds, imageReferenceCount: 1, taskCount: 1 });
                if (!quote.available) throw new FilmError("film_video_configuration", quote.reason);
            }
        }
        const runBatch = async (ids: string[], mode: "image" | "video") => {
            signal.throwIfAborted();
            const snapshot = options.getSnapshot();
            validateGraph(workflow, snapshot);
            const pending = ids.map(id => findMedia(snapshot, id, mode)).filter(node => !readyMedia(node));
            if (!pending.length) return;
            const ops: CanvasAgentOp[] = [];
            for (const node of pending) {
                if (node.execution.phase === "running") throw new FilmError("film_workflow_running", "已有任务仍在运行，未重复提交");
                if (mediaUrl(node) || node.content.storageKey) throw new FilmError("film_media_incomplete", `「${node.title}」已有未就绪的媒体，请先检查该节点，避免创建替代节点`);
                const references = snapshot.connections.filter(edge => edge.target.nodeId === node.id).map(edge => snapshot.nodes.find(source => source.id === edge.source.nodeId));
                if (references.some(source => source?.kind === "image" && !readyMedia(source))) throw new FilmError("film_reference_unavailable", `「${node.title}」的参考图片尚未成功保存`);
                if (mode === "video" && !references.some(source => source?.kind === "image" && readyMedia(source))) throw new FilmError("film_reference_unavailable", `「${node.title}」缺少真实图片参考`);
                const model = node.generation.model || (mode === "image" ? config.imageModel : config.videoModel);
                const prompt = requiredText(node.generation.prompt, `${node.title}提示词`);
                ops.push({ type: "update_node", id: node.id, attributes: { model, count: 1, ...(mode === "video" ? { videoGenerationMode: "image-to-video" as const } : {} ) } });
                ops.push({ type: "run_generation", nodeId: node.id, mode, prompt, preserveView: true, generationStyleIds: [...node.generation.generationStyleIds], generationStyleSnapshots: [...node.generation.generationStyleSnapshots] });
            }
            const applied = await options.onApplyOps(ops, signal);
            signal.throwIfAborted();
            if (applied.result?.ok === false) {
                const errors = pending.flatMap(node => {
                    const result = applied.snapshot.nodes.find(item => item.id === node.id);
                    const message = result?.execution.errorMessage?.trim();
                    return message ? [`「${result?.title || node.title}」：${message}`] : [];
                });
                throw new FilmError("film_generation_failed", errors.join("\n") || applied.result.message || "镜头生成失败，已保留流程图和成功媒体");
            }
            for (const node of pending) {
                const result = applied.snapshot.nodes.find(item => item.id === node.id);
                if (!readyMedia(result) || result?.kind !== mode) throw new FilmError(result?.execution.phase === "running" ? "film_workflow_running" : "film_generation_incomplete", result?.execution.errorMessage || `「${node.title}」尚未返回已保存的媒体，未继续下游`);
            }
        };
        if (workflow.productionVersion) {
            await runBatch([...new Set((workflow.assets || []).map(asset => asset.imageNodeId))], "image");
            await runBatch(workflow.shots.map(shot => shot.imageNodeId), "image");
        } else {
            await runBatch([workflow.shots[0].imageNodeId], "image");
            await runBatch(workflow.shots.slice(1).map(shot => shot.imageNodeId), "image");
        }
        // 配音便宜且快，放在付费视频之前：台词或音色有问题时尽早暴露，不浪费视频生成。
        await runSpeech(workflow, options, signal);
        await runBatch(workflow.shots.map(shot => shot.videoNodeId), "video");
        signal.throwIfAborted();
        const snapshot = options.getSnapshot();
        validateGraph(workflow, snapshot);
        if (!workflow.compositionNodeId) {
            const video = findMedia(snapshot, workflow.shots[0].videoNodeId, "video");
            if (!readyMedia(video)) throw new FilmError("film_generation_incomplete", "单镜头视频尚未成功保存");
            return successReceipt(workflow, video);
        }
        const composition = snapshot.nodes.find((node): node is CanvasVideoCompositionNode => node.id === workflow.compositionNodeId && node.kind === "videoComposition")!;
        const cached = compositionOutput(composition, workflow, snapshot);
        if (cached) return { ...successReceipt(workflow, cached), reused: true };
        if (composition.execution.phase === "running") throw new FilmError("film_workflow_running", "成片任务仍在运行，未重复提交");
        const applied = await options.onApplyOps([{ type: "run_composition", nodeId: composition.id }], signal);
        signal.throwIfAborted();
        if (applied.result?.ok === false) return hostFailure(applied.result, workflow);
        const current = applied.snapshot.nodes.find((node): node is CanvasVideoCompositionNode => node.id === composition.id && node.kind === "videoComposition");
        const result = current && compositionOutput(current, workflow, applied.snapshot);
        if (!result) throw new FilmError(current?.execution.phase === "running" ? "film_workflow_running" : "film_composition_incomplete", current?.execution.errorMessage || "合成尚未返回当前全部镜头的已保存成片");
        return { ...successReceipt(workflow, result), ...(typeof applied.result?.data?.taskId === "string" ? { taskId: applied.result.data.taskId } : {}) };
    } catch (error) { return { ...errorResult(error, signal), workflow, nodeIds: workflowNodeIds(workflow) }; }
}

function workflowNodeIds(workflow: FilmWorkflow): string[] { return !workflow || !Array.isArray(workflow.shots) ? [] : [workflow.scriptNodeId, ...new Set((workflow.assets || []).map(asset => asset.imageNodeId)), ...workflow.shots.flatMap(shot => shot ? [shot.textNodeId, shot.imageNodeId, shot.videoNodeId] : [""]), ...(workflow.voiceover || []).map(item => item?.audioNodeId || ""), ...(workflow.compositionNodeId ? [workflow.compositionNodeId] : [])]; }

/** 只为尚未成功的配音节点提交语音合成；运行中的不重复提交。 */
async function runSpeech(workflow: FilmWorkflow, options: FilmWorkflowOptions, signal: AbortSignal) {
    const snapshot = options.getSnapshot();
    const pending = (workflow.voiceover || []).map(item => snapshot.nodes.find((node): node is CanvasAudioNode => node.id === item.audioNodeId && node.kind === "audio")).filter((node): node is CanvasAudioNode => Boolean(node) && !readyAudio(node));
    if (!pending.length) return;
    if (pending.some(node => node.execution.phase === "running")) throw new FilmError("film_workflow_running", "配音仍在生成，未重复提交");
    if (pending.some(node => !node.speech?.text?.trim())) throw new FilmError("invalid_film_plan", "配音节点缺少台词文字，请恢复后继续");
    const applied = await options.onApplyOps(pending.map(node => ({ type: "run_speech" as const, nodeId: node.id })), signal);
    signal.throwIfAborted();
    if (applied.result?.ok === false) throw new FilmError("film_speech_failed", `配音生成失败，已保留流程图：${applied.result.message || "请检查语音模型"}`);
    for (const node of pending) {
        const result = applied.snapshot.nodes.find(item => item.id === node.id);
        if (!readyAudio(result)) throw new FilmError(result?.execution.phase === "running" ? "film_workflow_running" : "film_speech_failed", result?.execution.errorMessage || `「${node.title}」尚未返回已保存的配音`);
    }
}
function readyAudio(node?: CanvasNode): boolean { return Boolean(node && node.kind === "audio" && node.execution.phase !== "running" && node.execution.phase !== "failed" && node.content.storageKey?.trim() && /^(?:https?:\/\/|\/(?!\/))/.test((node.content.objectStorage?.url || node.content.source || "").trim())); }
function validateGraph(workflow: FilmWorkflow, snapshot: CanvasAgentSnapshot) {
    if (!workflow || !Array.isArray(workflow.shots) || workflow.shots.length < 1 || workflow.shots.length > 20) throw new FilmError("invalid_film_workflow", "成片流程数据不完整");
    const ids = workflowNodeIds(workflow);
    if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new FilmError("invalid_film_workflow", "成片流程节点 ID 不完整或重复");
    const expect = (id: string, kind: CanvasNode["kind"]) => { if (!snapshot.nodes.some(node => node.id === id && node.kind === kind)) throw new FilmError("film_node_missing", `成片节点不存在或类型已改变：${id}`); };
    const edge = (source: string, target: string) => { if (!snapshot.connections.some(item => item.source.nodeId === source && item.target.nodeId === target)) throw new FilmError("film_connection_missing", "成片流程连线缺失，请恢复文本、图片与视频之间的依赖连线"); };
    expect(workflow.scriptNodeId, "text");
    for (const asset of workflow.assets || []) {
        expect(asset.imageNodeId, "image");
        if (!asset.reused) edge(workflow.scriptNodeId, asset.imageNodeId);
    }
    workflow.shots.forEach((shot, index) => {
        expect(shot.textNodeId, "text"); expect(shot.imageNodeId, "image"); expect(shot.videoNodeId, "video");
        edge(workflow.scriptNodeId, shot.textNodeId); edge(shot.textNodeId, shot.imageNodeId); edge(shot.imageNodeId, shot.videoNodeId);
        if (workflow.productionVersion) {
            for (const ref of shot.referenceImageNodeIds || []) { expect(ref, "image"); edge(ref, shot.imageNodeId); }
        } else if (index) edge(workflow.shots[0].imageNodeId, shot.imageNodeId);
    });
    if (workflow.shots.length > 1 && !workflow.compositionNodeId) throw new FilmError("film_node_missing", "多镜头成片缺少合成节点");
    if (workflow.voiceover?.length && !workflow.compositionNodeId) throw new FilmError("film_node_missing", "带配音的成片缺少合成节点");
    if (workflow.compositionNodeId) {
        expect(workflow.compositionNodeId, "videoComposition");
        workflow.shots.forEach(shot => edge(shot.videoNodeId, workflow.compositionNodeId!));
        for (const item of workflow.voiceover || []) { expect(item.audioNodeId, "audio"); edge(workflow.scriptNodeId, item.audioNodeId); edge(item.audioNodeId, workflow.compositionNodeId); }
        const node = snapshot.nodes.find(item => item.id === workflow.compositionNodeId) as CanvasVideoCompositionNode;
        if (node.composition.editingOptions || node.composition.inputVideoNodeIds.length !== workflow.shots.length || node.composition.inputVideoNodeIds.some((id, index) => id !== workflow.shots[index].videoNodeId)) throw new FilmError("film_composition_order_changed", "合成节点的镜头顺序或剪辑设置已变化，未提交生成");
    }
}
function findMedia(snapshot: CanvasAgentSnapshot, id: string, kind: "image"): CanvasImageNode;
function findMedia(snapshot: CanvasAgentSnapshot, id: string, kind: "video"): CanvasVideoNode;
function findMedia(snapshot: CanvasAgentSnapshot, id: string, kind: "image" | "video"): CanvasImageNode | CanvasVideoNode;
function findMedia(snapshot: CanvasAgentSnapshot, id: string, kind: "image" | "video"): CanvasImageNode | CanvasVideoNode {
    const node = snapshot.nodes.find(item => item.id === id);
    if (!node || (node.kind !== "image" && node.kind !== "video") || node.kind !== kind) throw new FilmError("film_node_missing", `成片媒体节点不存在：${id}`);
    return node;
}
function mediaUrl(node: CanvasImageNode | CanvasVideoNode) { return (node.content.objectStorage?.url || node.content.source || "").trim(); }
function readyMedia(node?: CanvasNode): boolean { return Boolean(node && (node.kind === "image" || node.kind === "video") && node.execution.phase === "succeeded" && node.content.storageKey?.trim() && /^(?:https?:\/\/|\/(?!\/))/.test(mediaUrl(node))); }
function compositionOutput(node: CanvasVideoCompositionNode, workflow: FilmWorkflow, snapshot: CanvasAgentSnapshot): CanvasVideoNode | undefined {
    if (node.execution.phase !== "succeeded" || node.composition.editingOptions || node.composition.inputVideoNodeIds.length !== workflow.shots.length || node.composition.inputStorageKeys?.length !== workflow.shots.length) return undefined;
    if (workflow.shots.some((shot, index) => {
        const video = snapshot.nodes.find(item => item.id === shot.videoNodeId);
        return video?.kind !== "video" || !readyMedia(video) || node.composition.inputVideoNodeIds[index] !== video.id || node.composition.inputStorageKeys![index] !== video.content.storageKey;
    })) return undefined;
    // 配音重新生成后旧成片不再有效。
    const voiceKeys = (workflow.voiceover || []).map(item => snapshot.nodes.find(candidate => candidate.id === item.audioNodeId)).map(audio => audio?.kind === "audio" ? audio.content.storageKey || "" : "");
    const mixedKeys = node.composition.inputAudioStorageKeys || [];
    if (voiceKeys.length !== mixedKeys.length || voiceKeys.some(key => !key || !mixedKeys.includes(key))) return undefined;
    const result = snapshot.nodes.find(item => item.id === node.composition.resultVideoNodeId);
    return result?.kind === "video" && readyMedia(result) ? result : undefined;
}
function successReceipt(workflow: FilmWorkflow, video: CanvasVideoNode): CanvasAgentToolResult { return { ok: true, status: "success", workflow, nodeIds: [...workflowNodeIds(workflow), video.id], nodeId: video.id, resultVideoNodeId: video.id, ...(workflow.compositionNodeId ? { compositionNodeId: workflow.compositionNodeId } : {}), storageKey: video.content.storageKey, mediaUrl: mediaUrl(video), message: "完整流程已完成，成片已保存" }; }
function requiredText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new FilmError("invalid_film_plan", `${label}不能为空`); return value.trim(); }
function uniqueSourceIds(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 20) throw new FilmError("invalid_film_reference", "参考节点必须是最多 20 项的 ID 数组"); const ids = Array.from(value, id => requiredText(id, "参考节点 ID")); if (new Set(ids).size !== ids.length) throw new FilmError("invalid_film_reference", "参考节点 ID 不能重复"); return ids; }
function validateSeconds(seconds: number, config: AiConfig, model: string) {
    const duration = readFilmPlanningConstraints({ ...config, model, videoModel: model }).videoDuration;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300 || (model && !duration.options.includes(seconds))) {
        throw new FilmError("unsupported_video_duration", `当前视频模型不支持 ${seconds} 秒，合法秒数为 ${duration.options.join("、") || "暂无"}；请按剧情重新规划，尚未提交生成`);
    }
}
function effectiveConfig(config: InfiniteCanvasConfig): AiConfig {
    const merged = { ...defaultConfig, ...config, quality: config.imageQuality || config.quality || defaultConfig.quality };
    return { ...merged, vquality: config.videoQuality || config.vquality || resolveVideoResolution(merged, merged.videoModel || merged.model, "image-to-video") };
}
function styleAttributes(config: InfiniteCanvasConfig, mode: "image" | "video") { return { generationStyleIds: config.generationStyleIdsByType?.[mode] || [], generationStyleSnapshots: (config.generationStyleSnapshots || config.styleSnapshots || []).filter(style => style.generationType === mode) }; }
function hostFailure(result: HostToolResult, workflow: FilmWorkflow): CanvasAgentToolResult { return { ok: false, code: "film_execution_failed", status: result.data?.status === "running" ? "waiting" : "error", workflow, nodeIds: workflowNodeIds(workflow), message: result.message || "成片步骤执行失败，现有节点已保留", ...(typeof result.data?.taskId === "string" ? { taskId: result.data.taskId } : {}) }; }
function errorResult(error: unknown, signal: AbortSignal): CanvasAgentToolResult { signal.throwIfAborted(); if (error instanceof Error && error.name === "AbortError") throw error; const code = error instanceof FilmError ? error.code : "film_execution_failed"; return { ok: false, code, status: code === "film_workflow_running" ? "waiting" : "error", message: error instanceof Error ? error.message : "成片执行失败，现有节点已保留" }; }
class FilmError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
