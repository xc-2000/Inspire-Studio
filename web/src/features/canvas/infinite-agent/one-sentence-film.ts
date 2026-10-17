import type { CanvasConnection, CanvasNode, CanvasVideoNode } from "../types";
import type { CanvasAgentOp } from "../utils/canvas-agent-ops";
import type { CanvasAgentAction, CanvasAgentToolResult } from "./upstream/canvas-agent-tools";
import type { FilmWorkflow } from "./film-workflow";
import type { FilmModelSelection } from "./film-model-selection";
import { normalizeFilmStoryPlan, type FilmStoryPlan } from "./film-story-plan";

export type OneSentenceFilm = {
    models?: FilmModelSelection;
    brief: string;
    nodeIds: string[];
    status: "running" | "interrupted" | "completed";
    resultNodeId?: string;
    workflow?: FilmWorkflow;
    storyPlan?: FilmStoryPlan;
    pipelineMode?: "full" | "existing-clips";
    blocker?: string;
};

export type OneSentenceFilmRequest = { film: OneSentenceFilm; resume: boolean };

/** Ordinary generation, questions about the feature, and declined automation keep their existing flow. */
export function resolveOneSentenceFilmRequest(message: string, previous?: OneSentenceFilm): OneSentenceFilmRequest | undefined {
    const text = message.trim();
    const content = text.replace(/^【(?:一句话|一键)成片】\s*/, "").trim();
    if (/(?:不要|不想|不用|别|无需).{0,6}(?:一句话成片|一键成片|成片)/.test(content)) return undefined;
    if (/^(?:请|帮我)?\s*(?:继续|接着|恢复)(?:上次|上一次|之前|这个|这次)?(?:的)?(?:成片|一键成片|一句话成片)(?=$|[\s！!。.,，:：；;])/u.test(content)) {
        return previous ? { film: { ...previous, nodeIds: [...previous.nodeIds], status: "running" }, resume: true } : undefined;
    }
    const hasPrefix = /^【(?:一句话|一键)成片】/.test(text);
    const hasRequest = /(?:一句话|一键)成片/.test(text)
        && !/(?:吗|么|呢)[?？]?$|[?？]$/.test(text)
        && !/(?:不要|不想|不用|别|无需).{0,6}(?:一句话|一键)成片|(?:介绍|解释|什么是|如何|怎么).{0,8}(?:一句话|一键)成片|(?:一句话|一键)成片.{0,8}(?:是什么|什么意思|怎么用|如何使用|功能介绍)/.test(text);
    if (!hasPrefix && !hasRequest) return undefined;
    const brief = content;
    const existingClipsOnly = /(?:只|仅|直接).{0,10}(?:复用|使用|用|将|把)?(?:现有|已有|这些|选中).{0,6}(?:视频|片段).{0,12}(?:合成|拼接|成片)|(?:只|仅).{0,8}(?:合成|拼接).{0,12}(?:现有|已有|这些|选中).{0,6}(?:视频|片段)|复用(?:现有|已有).{0,6}(?:视频|片段).{0,6}直接(?:合成|拼接)/.test(content);
    return { film: { brief: brief || text, nodeIds: [], status: "running", pipelineMode: existingClipsOnly ? "existing-clips" : "full" }, resume: false };
}

export function mergeOneSentenceFilmNodes(film: OneSentenceFilm, ids: string[]): OneSentenceFilm {
    return { ...film, nodeIds: [...new Set([...film.nodeIds, ...ids.filter(Boolean)])] };
}

/** IDs are reserved before awaiting long media work; consumers still resolve them against real nodes. */
export function recordOneSentenceFilmOperations(film: OneSentenceFilm, ops?: CanvasAgentOp[]): OneSentenceFilm {
    return mergeOneSentenceFilmNodes(film, (ops || []).flatMap(op =>
        (op.type === "add_node" || op.type === "create_group") && op.id ? [op.id]
            : (op.type === "run_generation" || op.type === "run_composition") ? [op.nodeId] : []));
}

/** Record only actual nodes and sources used by an action, including nodes created before a failed task. */
export function recordOneSentenceFilmAction(
    film: OneSentenceFilm,
    action: CanvasAgentAction,
    result: CanvasAgentToolResult | undefined,
    beforeIds: Set<string>,
    nodes: CanvasNode[],
    uncreatedReservations?: ReadonlySet<string>,
): OneSentenceFilm {
    const existing = new Set(nodes.map(node => node.id));
    const ids = nodes.filter(node => !beforeIds.has(node.id)).map(node => node.id);
    const usesSources = ["generate_image", "edit_image", "generate_video", "compose_videos", "create_film_workflow"].includes(action.name);
    if (usesSources && Array.isArray(action.arguments.sourceNodeIds)) {
        ids.push(...action.arguments.sourceNodeIds.filter((id): id is string => typeof id === "string"));
    }
    if (usesSources && typeof action.arguments.nodeId === "string") ids.push(action.arguments.nodeId);
    for (const key of ["nodeId", "compositionNodeId", "resultNodeId", "resultVideoNodeId"] as const) {
        if (typeof result?.[key] === "string") ids.push(result[key]);
    }
    if (Array.isArray(result?.nodeIds)) ids.push(...result.nodeIds.filter((id): id is string => typeof id === "string"));
    // A failed host application may have placed only part of the graph. Retain its
    // valid workflow receipt so continuation inspects it instead of building a duplicate.
    const workflow = action.name === "create_film_workflow" || action.name === "run_film_workflow" ? readFilmWorkflow(result?.workflow) : undefined;
    if (workflow) ids.push(workflow.scriptNodeId, ...(workflow.assets || []).map(asset => asset.imageNodeId), ...workflow.shots.flatMap(shot => [shot.textNodeId, shot.imageNodeId, shot.videoNodeId]), ...(workflow.voiceover || []).map(item => item.audioNodeId), ...(workflow.compositionNodeId ? [workflow.compositionNodeId] : []));
    // Only discard this action's new reservations that never became real nodes. Existing
    // missing nodes remain useful recovery evidence, and other running actions own their IDs.
    const settled = uncreatedReservations?.size ? {
        ...film,
        nodeIds: film.nodeIds.filter(id => !uncreatedReservations.has(id) || existing.has(id) || beforeIds.has(id)),
    } : film;
    const updated = mergeOneSentenceFilmNodes(settled, ids.filter(id => existing.has(id)));
    if (action.name === "plan_film_story" && result?.ok && result.storyPlan) updated.storyPlan = normalizeFilmStoryPlan(result.storyPlan);
    if (workflow) updated.workflow = workflow;
    if (action.name === "create_film_workflow" || action.name === "run_film_workflow") {
        if ((result?.ok === false || (action.name === "run_film_workflow" && result?.status === "planned")) && typeof result.message === "string" && result.message.trim()) {
            updated.blocker = result.message.trim();
        } else if (action.name === "run_film_workflow" && result?.ok && ["success", "completed"].includes(String(result.status))) {
            delete updated.blocker;
        }
    }
    if ((action.name === "compose_videos" || action.name === "run_film_workflow") && result?.ok) {
        const resultId = result.resultVideoNodeId || result.resultNodeId || result.nodeId;
        if (typeof resultId === "string" && nodes.some(node => node.id === resultId && node.kind === "video")) {
            updated.resultNodeId = resultId;
        }
    }
    return updated;
}

export function readFilmWorkflow(value: unknown): FilmWorkflow | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.scriptNodeId !== "string" || !candidate.scriptNodeId || !Array.isArray(candidate.shots) || !candidate.shots.length) return undefined;
    const shots = candidate.shots.flatMap(item => {
        if (!item || typeof item !== "object") return [];
        const shot = item as Record<string, unknown>;
        return typeof shot.textNodeId === "string" && shot.textNodeId && typeof shot.imageNodeId === "string" && shot.imageNodeId && typeof shot.videoNodeId === "string" && shot.videoNodeId
            ? [{ textNodeId: shot.textNodeId, imageNodeId: shot.imageNodeId, videoNodeId: shot.videoNodeId, ...(Array.isArray(shot.referenceImageNodeIds) && shot.referenceImageNodeIds.every(id => typeof id === "string") ? { referenceImageNodeIds: shot.referenceImageNodeIds as string[] } : {}) }] : [];
    });
    if (shots.length !== candidate.shots.length) return undefined;
    const assets = Array.isArray(candidate.assets) ? candidate.assets.flatMap(item => {
        if (!item || typeof item !== "object") return [];
        const asset = item as Record<string, unknown>;
        return typeof asset.assetId === "string" && typeof asset.imageNodeId === "string" && typeof asset.reused === "boolean" ? [{ assetId: asset.assetId, imageNodeId: asset.imageNodeId, reused: asset.reused }] : [];
    }) : [];
    if (candidate.productionVersion && (candidate.productionVersion !== "tapcanvas-adapted/v1" || !Array.isArray(candidate.assets) || assets.length !== candidate.assets.length || shots.some(shot => !shot.referenceImageNodeIds))) return undefined;
    const voiceover = Array.isArray(candidate.voiceover) ? candidate.voiceover.flatMap(item => {
        if (!item || typeof item !== "object") return [];
        const voice = item as Record<string, unknown>;
        return typeof voice.lineId === "string" && typeof voice.audioNodeId === "string" && voice.audioNodeId ? [{ lineId: voice.lineId, audioNodeId: voice.audioNodeId }] : [];
    }) : [];
    if (Array.isArray(candidate.voiceover) && voiceover.length !== candidate.voiceover.length) return undefined;
    return { scriptNodeId: candidate.scriptNodeId, shots, ...(candidate.productionVersion === "tapcanvas-adapted/v1" ? { productionVersion: candidate.productionVersion, assets } : {}), ...(typeof candidate.compositionNodeId === "string" && candidate.compositionNodeId ? { compositionNodeId: candidate.compositionNodeId } : {}), ...(voiceover.length ? { voiceover } : {}) };
}

export function oneSentenceFilmPrompt(film: OneSentenceFilm, resume: boolean, speechAvailable = false): string {
    const full = film.pipelineMode === "full";
    const workflowInstructions = full
        ? `本次必须完成「主剧本 → 每镜文字 → 每镜图片 → 每镜视频 → 最终成片」完整图工作流，不能跳过文字或图片，不能用独立片段冒充完成。
${film.workflow ? `已保存工作流：${JSON.stringify(film.workflow)}。继续时直接调用 run_film_workflow({}) 复用这个图，不能重复调用 create_film_workflow 或另建同内容节点。` : "先调用 plan_film_story({title,script,visualStyle,aspectRatio,targetDurationSeconds,durationRationale,assets,beats}) 自主编排并冻结整片剧情；aspectRatio必须填写用户指定画幅，未指定时沿用当前视频画幅，不能只写进提示词，再调用 create_film_workflow({clips:[{beatId,imagePrompt,timeline:{scene,shots:[{action,camera,sound,storyEventIds,speechEventIds}]}}]}) 编写逐片段镜头。beats每项必须写事件storyEvents和对白dialogueScript（无对白用[]），assetIds只引用该段实际出现的共享人物/场景/道具；参考图在asset.sourceNodeId填真实ID。每段storyEvents的sourceBeatId是事件ID，dialogueScript的lineId是对白ID；timeline逐一绑定这些ID，事件有序完整覆盖、对白仅出现一次。相邻片段entryState逐字复制前段exitState，在事件中写出转场、选择、反应和结果；不要重置世界状态。模型能力决定单次生成时长，timeline内部镜头由AI自由编排，不套固定镜头数或机械切秒。宿主直接复用TapCanvas的分镜编译和校验生成提示词，继承已冻结的时长、风格与身份。"}
创建成功后调用 run_film_workflow({})，该工具按图执行全部图片、视频及最终合成；必须等待真实结果。full模式不能改用 generate_video、generate_image 或 compose_videos 跳过工作流。等待中只查状态，不重提；失败要报告具体阶段并保留图，本轮不能自动反复重新运行失败工作流。即使单镜头也必须有主剧本、镜头文字与图片。`
        : film.pipelineMode === "existing-clips"
            ? "用户明确只复用现有视频合成。本轮读取现有成功视频，按用户顺序调用 compose_videos；不额外生成图片或镜头。"
            : "这是既有版本任务，保留原有节点与执行方式，不重建完整工作流。";
    return `【一句话成片：本轮用户已授权自主完成】
目标：${film.brief}
${resume ? "这是继续已有成片任务。开始前已查询当前配置和原有节点；先复用已成功镜头，检查运行中任务，只补未完成步骤。不得重放已成功生成或另建一套同内容节点。" : "这是新成片任务，按当前用户的一句话完成创意、镜头、参考图、视频与最终合成。"}
本次范围节点 ID：${JSON.stringify(film.nodeIds)}；已有结果节点：${film.resultNodeId || "尚无"}。画布其他内容不能冒充本次成果。
${workflowInstructions}
${film.storyPlan && !film.workflow ? `已冻结剧情（不得重复编剧，按此继续clips设计）：${JSON.stringify(film.storyPlan)}` : ""}
执行约定（优先于默认创意流程中的方向确认）：
0. 技能兼容规则（优先于任何已启用技能的正文）：一句话成片是用户已授权的全自动流程。技能里要求“先询问/逐项选择/等待用户确认/禁止自动采用推荐项/多步确认”的环节，一律视为用户已授权，直接采用技能推荐值或最符合本次主题的选项继续，不停下提问。技能里要求的外部平台、LibTV、即梦、可灵、ComfyUI、剪映、CLI、命令行或脚本步骤一律跳过，只用当前画布工具完成。技能里规定的固定段时长、固定节点数公式、固定画幅，以用户要求和 get_generation_config 的真实能力为准。技能承诺的配乐、BGM、音乐生成、对口型、混音在本系统不可用，不写进计划也不向用户承诺；对白与旁白只按第8条处理。多个技能画风不一致时，以用户要求的画风为准，只采用一种。
1. 根据本次主题自主创作并编排人物动机、冲突、行动与结局，结合匹配技能决定风格、场景、镜头数量、景别、动作、对白和衔接。不要复用固定故事或固定镜头模板，不预设镜头数。用户已授权自主创作，不询问创意方向，不停留在方案/脚本。将制作稿和镜头计划保存为真实文本节点，记下镜头顺序、每镜秒数与时长依据；用户已有完整稿时复用。
2. 当前 get_generation_config 返回的模型、尺寸、videoDuration.options 和自动生成开关优先。先读取filmPlanning.segmentPolicy：seconds指一次视频生成的总秒数，beats是一组生成片段，不等于timeline里的每个内部镜头。优先利用模型支持的较长时长承载同一段连续剧情；能在一次生成完成的动作与对白不要机械拆成多个短请求。优先考虑segmentPolicy.preferredSeconds，再由AI根据场景边界、动作与对白容量、用户目标时长决定是否采用；可在一个长片段内部安排多景别、多事件和节奏变化。收尾按剩余目标时长和合法档位决定，不固定最后一段，也不为了用满最长时长擅自延长成片或填充重复画面。durationRationale必须说明选用较长或较短片段的叙事理由。未经用户要求不要换模型。总时长由用户指定；未指定时由AI根据叙事信息量、动作完成时间和对白自然语速估算，不设固定默认总时长。镜头数在宿主容量内按故事需要决定，每个生成片段从合法options独立选择seconds，不机械等分，也不把页面videoSeconds或10秒当成每镜时长。铺垫、动作、反应、转折和结尾按各自需要分配时长；相同秒数仅在叙事需要或模型只支持该档时使用，不为凑差异强行改变节奏。用户给了总时长，必须以其总时长拆成合法时长组合，不能擅自缩短或增加；无法按当前模型完成时明确说明阻塞，不发送非法时长。若options只有一个值，说明真实渠道限制，仍自主编排内容、片段数量和内部镜头；不能假称支持任意秒数。
3. 视频为图生视频，首帧图片是该段唯一的视觉锚点：clip.imagePrompt 必须让该段所有出场的关键角色同框、完整、清晰可辨，并写出体型比例；同一段内硬切越多越容易走形，优先用连续运镜代替硬切，硬切后的内部镜头不引入首帧没有的角色。资产identity写可直接画出的外观（物种、体型比例、轮廓、服装配色），不要只写性格。visualStyle只写一种渲染方式（二维或三维/写实），技能之间画风冲突时按用户要求取舍。
4. 每个镜头只生成 1 份视频、每张必要参考只生成 1 张图片，不沿用全局备选数量扩大付费调用。有用户参考图必须真实引用。为相同人物/商品/地点使用共享视觉锚点，图生视频 sourceNodeIds 引用实际成功的图片，提示词保持主体外观、空间方位、动作承接和光线连续。只生成必要参考；模型不支持某能力时使用当前可用路径，不虚构能力。
5. 依赖媒体必须等工具返回真实成功，再生成后续内容；运行中只查状态，不重复提交。互相独立的镜头可并行，依赖参考的镜头必须按序。失败时保留现有节点并说明原因，不能无上限付费重试。
6. ${full ? "完整工作流通过 run_film_workflow 自动按shots顺序合成；必须核对每镜文字、图片、视频和最终成片都真实成功，不能只交付脚本、图片或零散片段。" : "多镜头必须将成功视频节点按剧本顺序调用 compose_videos({sourceNodeIds:[真实视频ID...],title:\"成片标题\",nodeId?:已有合成节点ID})，等待合成工具真实完成；纯文字“已完成”或几段独立视频都不算成片。明确单镜头时可直接交付该成功视频。"}
7. 只依据真实 succeeded、持久化 storageKey 与可用视频 URL 宣布完成。不要把排队、计划、合成节点本身或历史视频当成新成片。若还未完成，说明实际进度和阻塞，并告诉用户可以“继续成片”。
${speechAvailable
        ? `8. 已接入语音合成（TTS）：dialogueScript 中每一句对白和旁白都会由宿主自动配音，并按所在内部镜头首个剧情事件的时间混入最终成片，原片音轨自动压低。由AI按剧情决定是否需要旁白或对白：纯画面更有力时保持 dialogueScript 为空，需要交代信息、情绪或角色关系时再写，不为凑配音而加台词。每句要短，按中文约每秒4字估算朗读时长，必须放得进它所在事件的时间段；同一片段的多句要留出间隔。视频模型不出声、无法对口型：优先用 voice_over（旁白、内心独白）或 off_screen（画外音）；on_screen 对白只用于短句，并让角色在该镜头中背对、远景或侧脸。给有台词的角色资产填写 voice，有旁白时填写 narratorVoice，均从 get_generation_config.speech.voices 选择，不同角色用不同音色。不能承诺配乐或音效，配音以外的声音以视频实际音轨为准。`
        : "8. 保留源视频实际音轨。当前没有可用的语音模型，不得承诺已配音或配乐；dialogueScript 可为空，若实际静音如实说明。不要伪造旁白、字幕或音乐制作结果。"}`;
}

function readyVideo(node: CanvasNode | undefined): node is CanvasVideoNode {
    if (node?.kind !== "video" || node.execution.phase !== "succeeded" || !node.content.storageKey?.trim()) return false;
    const url = node.content.objectStorage?.url || node.content.source;
    return Boolean(url && /^(?:https?:\/\/|\/(?!\/))/.test(url));
}

function fullWorkflowIssue(film: OneSentenceFilm, nodes: CanvasNode[], connections?: CanvasConnection[]): string | undefined {
    if (film.pipelineMode !== "full") return undefined;
    const workflow = film.workflow;
    if (!workflow || !workflow.shots.length) return "完整图工作流尚未建立";
    const scope = new Set(film.nodeIds);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const ids = [workflow.scriptNodeId, ...new Set((workflow.assets || []).map(asset => asset.imageNodeId)), ...workflow.shots.flatMap(shot => [shot.textNodeId, shot.imageNodeId, shot.videoNodeId]), ...(workflow.voiceover || []).map(item => item.audioNodeId)];
    if (new Set(ids).size !== ids.length || ids.some(id => !scope.has(id))) return "工作流节点范围不完整或镜头节点重复";
    const script = nodeById.get(workflow.scriptNodeId);
    if (script?.kind !== "text" || script.execution.phase !== "succeeded" || !script.content.text.trim()) return "主剧本尚未真实保存";
    const requiredEdges: Array<[string, string]> = [];
    for (const asset of workflow.assets || []) {
        const image = nodeById.get(asset.imageNodeId);
        if (image?.kind !== "image" || image.execution.phase !== "succeeded" || !image.content.storageKey?.trim() || !/^(?:https?:\/\/|\/(?!\/))/.test(image.content.objectStorage?.url || image.content.source || "")) return "共享参考图片尚未成功保存";
        if (!asset.reused) requiredEdges.push([workflow.scriptNodeId, asset.imageNodeId]);
    }
    for (const [index, shot] of workflow.shots.entries()) {
        const text = nodeById.get(shot.textNodeId);
        if (text?.kind !== "text" || text.execution.phase !== "succeeded" || !text.content.text.trim()) return `第 ${index + 1} 镜文字尚未真实保存`;
        const image = nodeById.get(shot.imageNodeId);
        if (image?.kind !== "image" || image.execution.phase !== "succeeded" || !image.content.storageKey?.trim()
            || !/^(?:https?:\/\/|\/(?!\/))/.test(image.content.objectStorage?.url || image.content.source || "")) return `第 ${index + 1} 镜图片尚未成功保存`;
        if (!readyVideo(nodeById.get(shot.videoNodeId))) return `第 ${index + 1} 镜视频尚未成功保存`;
        requiredEdges.push([workflow.scriptNodeId, shot.textNodeId], [shot.textNodeId, shot.imageNodeId], [shot.imageNodeId, shot.videoNodeId]);
        for (const ref of shot.referenceImageNodeIds || []) requiredEdges.push([ref, shot.imageNodeId]);
        if (workflow.compositionNodeId) requiredEdges.push([shot.videoNodeId, workflow.compositionNodeId]);
    }
    for (const item of workflow.voiceover || []) {
        const audio = nodeById.get(item.audioNodeId);
        if (audio?.kind !== "audio" || audio.execution.phase === "running" || audio.execution.phase === "failed" || !audio.content.storageKey?.trim()) return "配音尚未成功保存";
        requiredEdges.push([workflow.scriptNodeId, item.audioNodeId]);
        if (workflow.compositionNodeId) requiredEdges.push([item.audioNodeId, workflow.compositionNodeId]);
    }
    if ((workflow.shots.length > 1 || workflow.voiceover?.length) && !workflow.compositionNodeId) return "完整工作流缺少最终合成节点";
    if (workflow.compositionNodeId) {
        const composition = nodeById.get(workflow.compositionNodeId);
        if (!scope.has(workflow.compositionNodeId) || composition?.kind !== "videoComposition") return "工作流指定的合成节点不存在";
        const expected = workflow.shots.map(shot => shot.videoNodeId);
        if (composition.composition.inputVideoNodeIds.length !== expected.length || composition.composition.inputVideoNodeIds.some((id, index) => id !== expected[index])) return "成片没有按计划包含全部镜头或镜头顺序不一致";
    }
    if (connections) {
        const connected = new Set(connections.map(edge => `${edge.source.nodeId}\u0000${edge.target.nodeId}`));
        if (requiredEdges.some(([source, target]) => !connected.has(`${source}\u0000${target}`))) return "文字、图片、视频工作流的必需连线不完整";
    }
    return undefined;
}

/** The model's final sentence is never evidence of a completed film. */
export function finishOneSentenceFilm(film: OneSentenceFilm, nodes: CanvasNode[], connections?: CanvasConnection[]): { film: OneSentenceFilm; reply: string } {
    const scope = new Set(film.nodeIds);
    const scoped = nodes.filter(node => scope.has(node.id));
    const result = nodes.find(node => node.id === film.resultNodeId && scope.has(node.id));
    const workflowIssue = fullWorkflowIssue(film, nodes, connections);
    const composition = scoped.find(node => node.kind === "videoComposition"
        && (film.pipelineMode !== "full" || node.id === film.workflow?.compositionNodeId)
        && node.execution.phase === "succeeded"
        && node.composition.resultVideoNodeId === result?.id
        && node.composition.inputVideoNodeIds.length > 0
        && node.composition.inputStorageKeys?.length === node.composition.inputVideoNodeIds.length
        && node.composition.inputVideoNodeIds.every((id, index) => {
            const source = nodes.find(item => item.id === id);
            return scope.has(id) && readyVideo(source) && source.content.storageKey === node.composition.inputStorageKeys?.[index];
        }));
    const singleShot = /(?:单镜头|一镜到底|(?:只|仅|就)\s*(?:做|生成|要)?\s*(?:1|一)\s*(?:个)?镜头)/.test(film.brief)
        && !/(?:不要|无需|不用|别).{0,4}(?:单镜头|一镜到底)/.test(film.brief);
    const final = workflowIssue ? undefined
        : composition && readyVideo(result) ? result
            : film.pipelineMode === "full" ? (film.workflow?.shots.length === 1 && result?.id === film.workflow.shots[0].videoNodeId && readyVideo(result) ? result : undefined)
                : singleShot ? (readyVideo(result) ? result : scoped.find(readyVideo)) : undefined;
    if (final) {
        return {
            film: { ...film, status: "completed", resultNodeId: final.id, blocker: undefined },
            reply: `成片已完成，已保存到「${final.title || "成片"}」视频节点，可以直接播放或下载。${composition ? "镜头已按顺序合成。" : "本次为单镜头视频。"}${film.workflow?.voiceover?.length ? `已混入 ${film.workflow.voiceover.length} 段配音。` : "音轨以实际视频为准。"}`,
        };
    }
    const ready = scoped.filter(node => readyVideo(node)).length;
    const running = scoped.filter(node => node.execution.phase === "running").length;
    const failed = scoped.filter(node => node.execution.phase === "failed");
    const details = [ready ? `${ready} 段视频已保存` : "尚无已完成的视频", running ? `${running} 个任务仍在执行` : "", failed.length ? `${failed.length} 个步骤失败` : ""].filter(Boolean).join("，");
    const reason = film.blocker || failed.find(node => node.execution.errorMessage)?.execution.errorMessage || workflowIssue;
    return {
        film: { ...film, status: "interrupted" },
        reply: `成片尚未完成：${details}。${reason ? `失败原因：${reason.slice(0, 500)}。` : "尚未核实到本次可播放的最终成片。"}已保留当前节点和进度，点击“继续成片”或发送“继续成片”，会先检查现有结果再继续。`,
    };
}
