import { nanoid } from "nanoid";

import type { CanvasAgentPhase } from "./types";
import { FILM_STORY_PLAN_PROPERTIES, FILM_STORY_PLAN_REQUIRED, FILM_CLIPS_SCHEMA, normalizeFilmStoryPlan, normalizeFilmClips } from "../film-story-plan";

export const CANVAS_AGENT_ACTION_NAMES = [
    "get_canvas_summary",
    "get_selected_nodes",
    "query_canvas_nodes",
    "get_node",
    "get_upstream_nodes",
    "get_downstream_nodes",
    "get_connected_nodes",
    "get_generation_config",
    "get_generation_task",
    "search_skills",
    "activate_skills",
    "read_skill_file",
    "set_agent_state",
    "create_primary_script_node",
    "create_text_node",
    "update_text_node",
    "update_node",
    "delete_node",
    "create_connection",
    "delete_connection",
    "create_group",
    "arrange_nodes",
    "generate_image",
    "edit_image",
    "generate_video",
    "compose_videos",
    "create_film_workflow",
    "plan_film_story",
    "run_film_workflow",
    "generate_audio",
    "get_media_task_status",
] as const;

export type CanvasAgentActionName = (typeof CANVAS_AGENT_ACTION_NAMES)[number];

export type CanvasAgentAction = {
    id: string;
    name: CanvasAgentActionName;
    arguments: Record<string, unknown>;
};

export type CanvasAgentToolResult = {
    ok: boolean;
    code?: string;
    message?: string;
    [key: string]: unknown;
};

export type CanvasAgentToolDefinition = {
    type: "function";
    function: {
        name: CanvasAgentActionName;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
            additionalProperties: false;
        };
    };
};

export type ParsedCanvasAgentJson = {
    parsed: boolean;
    actions: CanvasAgentAction[];
    reply: string;
    error?: string;
};

const STRING = { type: "string" };
const STRING_ARRAY = { type: "array", items: { type: "string" }, maxItems: 50 };
const PHASES: CanvasAgentPhase[] = ["intake", "concept", "script", "breakdown", "references", "storyboard", "video", "audio", "review", "complete"];
const NODE_TYPES = ["image", "panorama", "text", "config", "video", "audio", "director", "group"];
const SKILL_TARGET_TYPES = ["image", "video", "canvasSettingGraph"];
const ACTION_NAME_SET = new Set<string>(CANVAS_AGENT_ACTION_NAMES);

function defineTool(name: CanvasAgentActionName, description: string, properties: Record<string, unknown> = {}, required?: string[]): CanvasAgentToolDefinition {
    return {
        type: "function",
        function: {
            name,
            description,
            parameters: {
                type: "object",
                properties,
                required,
                additionalProperties: false,
            },
        },
    };
}

export const CANVAS_AGENT_SKILL_FILE_TOOL = defineTool("read_skill_file", "按当前已加载 Skill 目录中的精确相对路径，只读获取主文件 SKILL.md、目录索引、参考文件或文本 parts。正文未内联时先按入口与 nextPath 读完主文件全部 parts；全文已内联时无需重复读取，可按需核对正文或引用文件。", { skillId: STRING, path: STRING }, ["skillId", "path"]);

export const CANVAS_AGENT_SKILL_DISCOVERY_TOOLS: CanvasAgentToolDefinition[] = [
    defineTool("search_skills", "按关键词和分类搜索可用 Skill 的 ID、名称和说明；返回结果不包含完整正文。先搜索候选，再按真实结果中的 ID 激活需要的 Skill。", {
        query: STRING,
        targetType: { type: "string", enum: SKILL_TARGET_TYPES },
        page: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        pageSize: { type: "integer", minimum: 1, maximum: 12 },
    }),
    defineTool("activate_skills", "激活本轮搜索结果中的 1 至 5 个 Skill，读取完整定义供下一轮执行；只能使用真实 Skill 数值 ID。用户已手动选择 Skill 时遵循现有选择。", {
        skillIds: { type: "array", items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, minItems: 1, maxItems: 5, uniqueItems: true },
    }, ["skillIds"]),
];

export const CANVAS_AGENT_TOOLS: CanvasAgentToolDefinition[] = [
    defineTool("plan_film_story", "一键成片第一阶段：AI自主编剧并冻结完整剧情、时长、共享资产和逐片段事件/对白。秒数从当前videoDuration.options选择；遵循filmPlanning.segmentPolicy，优先把连续剧情放进一次较长生成，每段内部可有多个镜头，AI决定何时拆段和收尾；在durationRationale说明时长依据。总时长等于各段之和。相邻片段entryState原样承接上一段exitState，转场写入事件。重复人物/场景/道具登记共享资产；用户参考图填写真实sourceNodeId。返回成功后按此计划调用create_film_workflow编写逐段镜头。此步不生成媒体。", FILM_STORY_PLAN_PROPERTIES, FILM_STORY_PLAN_REQUIRED),
    defineTool("create_film_workflow", "一键成片第二阶段：先完成plan_film_story，再仅提交clips。逐段编写首帧和分镜timeline，由TapCanvas编译器检查事件和对白覆盖；继承冻结的剧本、身份、风格与各段时长，创建共享资产、逐段文本/图片/视频及合成节点。本工具只建图，成功后调用run_film_workflow；已有图时直接复用。title/script/shots等字段只兼容旧记录，新任务不要填写。", {
        title: STRING,
        script: STRING,
        targetDurationSeconds: { type: "integer", minimum: 1, maximum: 600, description: "本次成片总时长；用户指定时沿用，否则AI根据故事需要决定。必须等于各镜seconds之和。" },
        durationRationale: { type: "string", description: "时长来源及叙事节奏依据，说明不同镜头的动作/对白为什么需要对应时长。" },
        sourceNodeIds: STRING_ARRAY,
        clips: { ...FILM_CLIPS_SCHEMA, description: "第二阶段：完整沿用plan_film_story返回的beats顺序与ID。每段写首帧提示词和timeline；storyEventIds绑定sourceBeatId，speechEventIds绑定lineId，必须覆盖所有事件和对白。宿主复用TapCanvas编译器生成最终视频提示词，时长/角色/风格继承已冻结计划。" },
        shots: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false,
            properties: { title: STRING, description: STRING, imagePrompt: STRING, videoPrompt: STRING, seconds: { type: "integer", minimum: 1, maximum: 300, description: "一次视频生成的总秒数，必须属于当前videoDuration.options；按segmentPolicy由AI优先利用较长档位保留连续剧情，内部可有多个镜头，不能复用页面默认秒数统一填充。" } },
            required: ["title", "description", "imagePrompt", "videoPrompt", "seconds"] } },
    }, ["clips"]),
    defineTool("run_film_workflow", "执行本次已保存的完整成片工作流：先生成分镜图，再用每镜对应图片生成视频，最后按镜头顺序合成。只更新原有节点，复用已成功素材，运行中的任务不重复提交。遇失败停下并保留全部节点；用户继续成片后再恢复。"),
    defineTool("get_canvas_summary", "读取当前画布摘要、节点、连线、模型配置和任务状态。"),
    defineTool("get_selected_nodes", "读取用户当前选中的真实画布节点。"),
    defineTool("query_canvas_nodes", "当默认上下文中没有目标节点 ID 时，按 ID、关键词或类型只读查询画布节点；找到 ID 后再用 get_node 读取详情。", {
        nodeId: STRING,
        keyword: STRING,
        type: { type: "string", enum: NODE_TYPES },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
    }),
    defineTool("get_node", "按真实节点 ID 读取节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_upstream_nodes", "读取指定节点的所有直接上游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_downstream_nodes", "读取指定节点的所有直接下游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_connected_nodes", "读取指定节点直接连接的上下游节点。", { nodeId: STRING }, ["nodeId"]),
    defineTool("get_generation_config", "读取全局模型和渠道，以及当前画布 Agent 独立保存的图片质量、图片尺寸、视频清晰度、视频尺寸、时长和声音配置。"),
    defineTool("get_generation_task", "读取指定媒体或合成节点的真实任务状态及成片结果。", { nodeId: STRING }, ["nodeId"]),
    defineTool(
        "set_agent_state",
        "保存当前创作阶段、已确认方案和正式参考，供刷新后继续。",
        {
            phase: { type: "string", enum: PHASES },
            brief: STRING,
            targetDurationSeconds: { type: "number", minimum: 1 },
            approvedPlan: STRING,
            approvedNodeIds: STRING_ARRAY,
            referenceNodeIds: STRING_ARRAY,
        },
        ["phase"],
    ),
    defineTool(
        "create_primary_script_node",
        "仅用于新创作流程首次创建正式主剧本或总制作稿，固定使用主剧本节点尺寸。",
        { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY, projectTitle: STRING },
        ["title", "content", "projectTitle"],
    ),
    defineTool(
        "create_text_node",
        "创建镜头、角色、产品、场景、声音说明和其他普通文本节点；不得用于首次正式主剧本。",
        { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY },
        ["title", "content"],
    ),
    defineTool("update_text_node", "更新现有文本节点的标题或正文。", { nodeId: STRING, title: STRING, content: STRING }, ["nodeId"]),
    defineTool("update_node", "只更新现有节点标题；不允许任意字段覆盖。", { nodeId: STRING, title: STRING }, ["nodeId", "title"]),
    defineTool("delete_node", "使用画布现有删除链路删除节点及关联连线。", { nodeId: STRING }, ["nodeId"]),
    defineTool("create_connection", "在两个真实节点之间创建来源连线。", { fromNodeId: STRING, toNodeId: STRING }, ["fromNodeId", "toNodeId"]),
    defineTool("delete_connection", "删除指定真实连线。", { connectionId: STRING }, ["connectionId"]),
    defineTool("create_group", "把两个或更多节点放进本项目 group 节点。", { title: STRING, nodeIds: STRING_ARRAY }, ["nodeIds"]),
    defineTool("arrange_nodes", "整理指定节点；不传 nodeIds 时整理当前画布顶层节点。", { nodeIds: STRING_ARRAY }),
    defineTool(
        "generate_image",
        "创建图片节点和来源连线，并按 Agent 自动生成设置决定是否提交现有图片任务链路。sourceNodeIds 只放真实直接来源，独立生成必须传空数组；其中图片按数组顺序编号为图片1、图片2。",
        {
            prompt: STRING,
            title: STRING,
            sourceNodeIds: STRING_ARRAY,
            size: STRING,
            count: { type: "integer", minimum: 1, maximum: 15 },
        },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool(
        "edit_image",
        "创建图片编辑节点和来源连线，并按 Agent 自动生成设置决定是否提交现有图片编辑链路；必须提供至少一个真实图片来源节点，图片按 sourceNodeIds 顺序编号。",
        { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, size: STRING, count: { type: "integer", minimum: 1, maximum: 15 } },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool(
        "generate_video",
        "创建视频节点和来源连线，并按 Agent 自动生成设置决定是否提交现有视频任务链路。sourceNodeIds 只放真实直接来源，独立生成必须传空数组；其中图片、视频、音频分别按各自顺序编号。",
        {
            prompt: { type: "string", description: "完整视频提示词，可包含多个内部镜头。有已确认定稿且用户未要求修改时，直接完整填入定稿，不得摘要、删减或另写一版；保留镜头顺序、时间区间、对白/旁白全文和资产引用说明。各镜头时长之和须等于本次视频总时长；不能将各镜统一改成默认 videoSeconds，也不因有分镜就强制拆成多个生成任务。" },
            model: { type: "string", description: "当前视频模型名称，仅用于标注；实际使用前端配置的模型，不覆盖配置。" },
            title: STRING,
            sourceNodeIds: STRING_ARRAY,
            size: STRING,
            seconds: { type: "integer", minimum: -1, maximum: 300, description: "本次视频任务的总时长（秒），不是每个内部镜头的时长。按 videoDuration 的合法范围或离散值填写已确认时长；仅省略时使用当前 videoSeconds 默认值，不得把默认值当成上限。-1 仅用于支持智能时长的模型。" },
            generateAudio: { type: "boolean" },
        },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool(
        "compose_videos",
        "将 2 至 20 个已成功且已保存的视频按 sourceNodeIds 的顺序合成最终成片。等待全部片段成功后调用，不得跳过失败镜头。自动复用同顺序来源的合成节点和任务，nodeId 可指定已有合成节点；返回真实成片节点后才能宣布完成。",
        {
            sourceNodeIds: { type: "array", items: STRING, minItems: 2, maxItems: 20, uniqueItems: true },
            title: STRING,
            nodeId: STRING,
        },
        ["sourceNodeIds"],
    ),
    defineTool(
        "generate_audio",
        "创建音频节点和来源连线，并按 Agent 自动生成设置决定是否提交现有音频任务链路。prompt 是实际朗读文本，instructions 是音色/演绎说明；sourceNodeIds 只放真实直接来源，独立生成必须传空数组。",
        { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, voice: STRING, instructions: STRING },
        ["prompt", "sourceNodeIds"],
    ),
    defineTool("get_media_task_status", "读取图片、视频、音频或合成节点的任务状态及真实成片结果。", { nodeId: STRING }, ["nodeId"]),
];

export function normalizeCanvasAgentAction(name: unknown, args: unknown, id = nanoid()): CanvasAgentAction {
    if (typeof name !== "string" || !ACTION_NAME_SET.has(name)) throw new Error("模型返回了不允许的工具");
    if (args !== undefined && !isRecord(args)) throw new Error(name + " 的 arguments 必须是对象");
    const input = isRecord(args) ? args : {};
    const definition = canvasAgentToolDefinition(name);
    const { properties, required = [] } = definition.function.parameters;
    const unknownKeys = Object.keys(input).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
    if (unknownKeys.length) throw new Error(name + " 不支持参数：" + unknownKeys.join("、"));
    // Retain old persisted tool calls; new film runs are gated to the two-stage contract by the adapter.
    const legacyFilm = name === "create_film_workflow" && input.clips === undefined && input.shots !== undefined;
    const missingKeys = (legacyFilm ? ["title", "script", "shots"] : required).filter((key) => input[key] === undefined);
    if (missingKeys.length) throw new Error(name + " 的 arguments 缺少必填参数：" + missingKeys.join("、"));
    const actionName = name as CanvasAgentActionName;
    let normalized: Record<string, unknown> = {};

    switch (actionName) {
        case "get_canvas_summary":
        case "get_selected_nodes":
        case "get_generation_config":
            break;
        case "query_canvas_nodes": {
            const nodeType = optionalString(input.type);
            if (nodeType && !NODE_TYPES.includes(nodeType)) throw new Error("无效的节点类型");
            normalized = {
                ...(optionalString(input.nodeId) ? { nodeId: optionalString(input.nodeId) } : {}),
                ...(optionalString(input.keyword) ? { keyword: optionalString(input.keyword) } : {}),
                ...(nodeType ? { type: nodeType } : {}),
                page: boundedInteger(input.page, 1, Number.MAX_SAFE_INTEGER) || 1,
                pageSize: boundedInteger(input.pageSize, 1, 50) || 20,
            };
            break;
        }
        case "get_node":
        case "get_upstream_nodes":
        case "get_downstream_nodes":
        case "get_connected_nodes":
        case "get_generation_task":
        case "get_media_task_status":
        case "delete_node":
            normalized = { nodeId: requiredString(input.nodeId, "nodeId") };
            break;
        case "read_skill_file":
            normalized = { skillId: requiredString(input.skillId, "skillId"), path: requiredString(input.path, "path") };
            break;
        case "search_skills": {
            const query = optionalString(input.query);
            const targetType = input.targetType === undefined ? undefined : requiredString(input.targetType, "targetType");
            if (targetType && !SKILL_TARGET_TYPES.includes(targetType)) throw new Error("无效的 Skill 分类");
            normalized = {
                ...(query ? { query } : {}),
                ...(targetType ? { targetType } : {}),
                page: boundedInteger(input.page, 1, Number.MAX_SAFE_INTEGER) ?? 1,
                pageSize: boundedInteger(input.pageSize, 1, 12) ?? 12,
            };
            break;
        }
        case "activate_skills": {
            if (!Array.isArray(input.skillIds) || input.skillIds.length < 1 || input.skillIds.length > 5) throw new Error("skillIds 必须是 1 至 5 个 Skill 数值 ID 的数组");
            const skillIds = [...input.skillIds].map((value) => {
                const skillId = boundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
                if (skillId === undefined) throw new Error("skillIds 必须是正整数数组");
                return skillId;
            });
            if (new Set(skillIds).size !== skillIds.length) throw new Error("skillIds 不允许重复 ID");
            normalized = { skillIds };
            break;
        }
        case "delete_connection":
            normalized = { connectionId: requiredString(input.connectionId, "connectionId") };
            break;
        case "create_connection":
            normalized = {
                fromNodeId: requiredString(input.fromNodeId, "fromNodeId"),
                toNodeId: requiredString(input.toNodeId, "toNodeId"),
            };
            break;
        case "create_primary_script_node":
            normalized = {
                title: requiredString(input.title, "title"),
                content: requiredString(input.content, "content"),
                sourceNodeIds: stringArray(input.sourceNodeIds),
                projectTitle: requiredString(input.projectTitle, "projectTitle"),
            };
            break;
        case "create_text_node":
            normalized = {
                title: requiredString(input.title, "title"),
                content: requiredString(input.content, "content"),
                sourceNodeIds: stringArray(input.sourceNodeIds),
            };
            break;
        case "update_text_node":
            normalized = {
                nodeId: requiredString(input.nodeId, "nodeId"),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.content) ? { content: optionalString(input.content) } : {}),
            };
            if (!normalized.title && !normalized.content) throw new Error("update_text_node 缺少 title 或 content");
            break;
        case "update_node":
            normalized = { nodeId: requiredString(input.nodeId, "nodeId"), title: requiredString(input.title, "title") };
            break;
        case "set_agent_state": {
            const phase = requiredString(input.phase, "phase") as CanvasAgentPhase;
            if (!PHASES.includes(phase)) throw new Error("无效的 Agent 创作阶段");
            const targetDurationSeconds = positiveNumber(input.targetDurationSeconds);
            normalized = {
                phase,
                ...(optionalString(input.brief) ? { brief: optionalString(input.brief) } : {}),
                ...(targetDurationSeconds !== undefined ? { targetDurationSeconds } : {}),
                ...(optionalString(input.approvedPlan) ? { approvedPlan: optionalString(input.approvedPlan) } : {}),
                ...(input.approvedNodeIds !== undefined ? { approvedNodeIds: stringArray(input.approvedNodeIds) } : {}),
                ...(input.referenceNodeIds !== undefined ? { referenceNodeIds: stringArray(input.referenceNodeIds) } : {}),
            };
            break;
        }
        case "create_group": {
            const nodeIds = stringArray(input.nodeIds);
            if (nodeIds.length < 2) throw new Error("create_group 至少需要两个节点");
            normalized = { nodeIds, ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}) };
            break;
        }
        case "arrange_nodes":
            normalized = { nodeIds: stringArray(input.nodeIds) };
            break;
        case "generate_image":
        case "edit_image": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.size) ? { size: optionalString(input.size) } : {}),
                ...(boundedInteger(input.count, 1, 15) ? { count: boundedInteger(input.count, 1, 15) } : {}),
            };
            if (actionName === "edit_image" && sourceNodeIds && !sourceNodeIds.length) throw new Error("edit_image 缺少图片来源节点");
            break;
        }
        case "generate_video": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            const seconds = boundedInteger(input.seconds, -1, 30);
            if (input.model !== undefined) optionalString(input.model);
            if (input.generateAudio !== undefined && typeof input.generateAudio !== "boolean") throw new Error("generateAudio 必须是布尔值");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.size) ? { size: optionalString(input.size) } : {}),
                ...(seconds !== undefined ? { seconds } : {}),
                ...(typeof input.generateAudio === "boolean" ? { generateAudio: input.generateAudio } : {}),
            };
            break;
        }
        case "compose_videos": {
            if (!Array.isArray(input.sourceNodeIds) || input.sourceNodeIds.length < 2 || input.sourceNodeIds.length > 20) throw new Error("compose_videos 需要 2 至 20 个有序视频节点 ID");
            const sourceNodeIds = Array.from(input.sourceNodeIds, (value) => requiredString(value, "sourceNodeIds"));
            if (new Set(sourceNodeIds).size !== sourceNodeIds.length) throw new Error("compose_videos 的来源视频节点不能重复");
            normalized = {
                sourceNodeIds,
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(input.nodeId !== undefined ? { nodeId: requiredString(input.nodeId, "nodeId") } : {}),
            };
            break;
        }
        case "plan_film_story": {
            normalized = { ...normalizeFilmStoryPlan(input) };
            break;
        }
        case "create_film_workflow": {
            if (input.clips !== undefined) {
                normalized = { clips: normalizeFilmClips(input.clips) };
                break;
            }
            if (!Array.isArray(input.shots) || input.shots.length < 1 || input.shots.length > 20) throw new Error("成片需要1至20个镜头");
            const shots = input.shots.map((value) => {
                if (!isRecord(value)) throw new Error("每个镜头必须包含文字、图片提示词、视频提示词和秒数");
                if (Object.keys(value).some(key => !["title", "description", "imagePrompt", "videoPrompt", "seconds"].includes(key))) throw new Error("镜头包含不支持的字段");
                const seconds = boundedInteger(value.seconds, 1, 30);
                if (seconds === undefined) throw new Error("每个镜头必须指定合法秒数");
                return { title: requiredString(value.title, "title"), description: requiredString(value.description, "description"), imagePrompt: requiredString(value.imagePrompt, "imagePrompt"), videoPrompt: requiredString(value.videoPrompt, "videoPrompt"), seconds };
            });
            const targetDurationSeconds = input.targetDurationSeconds === undefined ? undefined : boundedInteger(input.targetDurationSeconds, 1, 600);
            if (input.targetDurationSeconds !== undefined && targetDurationSeconds === undefined) throw new Error("成片总时长必须为1至600的整数秒");
            normalized = { title: requiredString(input.title, "title"), script: requiredString(input.script, "script"), shots, sourceNodeIds: stringArray(input.sourceNodeIds),
                ...(targetDurationSeconds === undefined ? {} : { targetDurationSeconds }),
                ...(input.durationRationale === undefined ? {} : { durationRationale: requiredString(input.durationRationale, "durationRationale") }) };
            break;
        }
        case "run_film_workflow":
            normalized = {};
            break;
        case "generate_audio": {
            const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
            normalized = {
                prompt: requiredString(input.prompt, "prompt"),
                ...(sourceNodeIds ? { sourceNodeIds } : {}),
                ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}),
                ...(optionalString(input.voice) ? { voice: optionalString(input.voice) } : {}),
                ...(optionalString(input.instructions) ? { instructions: optionalString(input.instructions) } : {}),
            };
            break;
        }
    }

    return { id, name: actionName, arguments: normalized };
}

export async function parseCanvasAgentJson(content: string, { allowRepair = false }: { allowRepair?: boolean } = {}): Promise<ParsedCanvasAgentJson> {
    const json = extractJsonObject(content);
    let actionPayload = /[{,]\s*["']?actions["']?\s*:/.test(content);
    if (!json && !actionPayload) return { parsed: false, actions: [], reply: content.trim() };
    try {
        let payload: unknown;
        try {
            payload = JSON.parse(json);
        } catch {
            if (!allowRepair) throw new Error("工具 JSON 不是合法 JSON");
            const repairSource = json || stripJsonFence(content);
            const sourceStructure = inspectJsonStructure(repairSource);
            if (!sourceStructure.complete) throw new Error("JSON 输出被截断，本批操作未执行");
            const { jsonrepair } = await import("jsonrepair");
            const repaired = jsonrepair(repairSource);
            if (inspectJsonStructure(repaired).tokens !== sourceStructure.tokens) throw new Error("JSON 修复改变了操作结构，本批操作未执行");
            payload = JSON.parse(repaired);
        }
        if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, "actions")) return { parsed: false, actions: [], reply: content.trim() };
        actionPayload = true;
        if (!Array.isArray(payload.actions)) throw new Error("actions 必须是数组");
        if (payload.actions.length > 12) throw new Error("单次最多执行 12 个画布操作，请拆分调用");
        const outerKeys = Object.keys(payload).filter((key) => key !== "actions" && key !== "reply");
        if (outerKeys.length) throw new Error("JSON 外层不支持字段：" + outerKeys.join("、") + "；工具参数必须放在对应 action 的 arguments 中");
        const actions = payload.actions.map((item) => {
            if (!isRecord(item)) throw new Error("actions 中的每项必须是工具调用对象");
            const name = item.tool || item.name;
            const misplacedKeys = Object.keys(item).filter((key) => !["id", "tool", "name", "arguments"].includes(key));
            let args = item.arguments;
            if (misplacedKeys.length) {
                if (typeof name !== "string" || !ACTION_NAME_SET.has(name)) throw new Error("模型返回了不允许的工具");
                if (args !== undefined && !isRecord(args)) throw new Error(name + " 的 arguments 必须是对象");
                const supported = canvasAgentToolDefinition(name).function.parameters.properties;
                const unsupported = misplacedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(supported, key));
                if (unsupported.length) throw new Error(name + " 不支持参数：" + unsupported.join("、"));
                const normalizedArgs = { ...(isRecord(args) ? args : {}) };
                const conflicts = misplacedKeys.filter((key) => Object.prototype.hasOwnProperty.call(normalizedArgs, key));
                if (conflicts.length) throw new Error(conflicts.join("、") + " 同时出现在 arguments 内外层");
                misplacedKeys.forEach((key) => { normalizedArgs[key] = item[key]; });
                args = normalizedArgs;
            }
            return normalizeCanvasAgentAction(name, args, typeof item.id === "string" && item.id ? item.id : nanoid());
        });
        return { parsed: true, actions, reply: typeof payload.reply === "string" ? payload.reply.trim() : "" };
    } catch (error) {
        if (actionPayload) return { parsed: false, actions: [], reply: "", error: error instanceof Error ? error.message : "工具 JSON 格式错误" };
        return { parsed: false, actions: [], reply: content.trim() };
    }
}

function canvasAgentToolDefinition(name: string) {
    return name === "read_skill_file" ? CANVAS_AGENT_SKILL_FILE_TOOL : [...CANVAS_AGENT_TOOLS, ...CANVAS_AGENT_SKILL_DISCOVERY_TOOLS].find((tool) => tool.function.name === name)!;
}

export function canvasAgentActionLabel(action: CanvasAgentAction) {
    const labels: Record<CanvasAgentActionName, string> = {
        get_canvas_summary: "正在读取画布",
        get_selected_nodes: "正在读取选中节点",
        query_canvas_nodes: "正在查找画布节点",
        get_node: "正在读取节点",
        get_upstream_nodes: "正在读取上游节点",
        get_downstream_nodes: "正在读取下游节点",
        get_connected_nodes: "正在读取关联节点",
        get_generation_config: "正在读取生成配置",
        get_generation_task: "正在读取任务状态",
        search_skills: "正在搜索创作技能",
        activate_skills: "正在启用创作技能",
        read_skill_file: "正在读取技能内容",
        set_agent_state: "正在保存创作进度",
        create_primary_script_node: "正在创建主剧本节点",
        create_text_node: "正在创建文本节点",
        update_text_node: "正在更新文本节点",
        update_node: "正在更新节点",
        delete_node: "正在删除节点",
        create_connection: "正在创建连线",
        delete_connection: "正在删除连线",
        create_group: "正在创建分组",
        arrange_nodes: "正在整理画布",
        generate_image: "正在创建图片节点",
        edit_image: "正在创建图片编辑节点",
        generate_video: "正在创建视频节点",
        compose_videos: "正在合成最终视频",
        create_film_workflow: "正在展开剧本、分镜图和视频节点",
        plan_film_story: "正在编排剧情、共享角色和片段时长",
        run_film_workflow: "正在按节点依赖制作成片",
        generate_audio: "正在创建音频节点",
        get_media_task_status: "正在读取媒体任务",
    };
    return labels[action.name];
}

export function isCanvasAgentMediaAction(action: CanvasAgentAction) {
    return action.name === "generate_image" || action.name === "edit_image" || action.name === "generate_video" || action.name === "generate_audio";
}

export function userLikelyRequestedCanvasAction(text: string) {
    return /(?:创建|新增|插入|修改|更新|删除|连接|连线|分组|整理|生成|生图|执行|拆成|拆分|放到画布|开始做|(?:做|制作|添加|补充|移除|去掉).{0,8}(?:视频|音频|配音|旁白))/i.test(text);
}

function extractJsonObject(content: string) {
    const trimmed = stripJsonFence(content);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : "";
}

function stripJsonFence(content: string) {
    return content.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
}

function inspectJsonStructure(value: string) {
    const start = value.indexOf("{");
    if (start < 0) return { complete: false, tokens: "" };
    const stack: string[] = [];
    let quote = "";
    let escaped = false;
    let tokens = "";
    let rootEnd = -1;

    for (let index = start; index < value.length; index++) {
        const char = value[index];
        if (rootEnd >= 0) continue;
        if (quote) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === "{" || char === "[") {
            stack.push(char);
            tokens += char;
            continue;
        }
        if (char !== "}" && char !== "]") continue;
        tokens += char;
        const open = stack.pop();
        if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return { complete: false, tokens };
        if (!stack.length) rootEnd = index;
    }
    return { complete: rootEnd >= 0 && !value.slice(rootEnd + 1).trim(), tokens };
}

function requiredString(value: unknown, key: string) {
    if (typeof value !== "string") throw new Error(key + " 必须是字符串");
    const text = value.trim();
    if (!text) throw new Error(key + " 不能为空");
    return text;
}

function optionalString(value: unknown) {
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error("可选文本参数必须是字符串");
    return value.trim();
}

function stringArray(value: unknown, key = "节点 ID") {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(key + " 必须是字符串数组");
    if (value.length > 50) throw new Error("节点 ID 数组最多允许 50 项，请拆分调用");
    return [...new Set(value.map((item) => {
        if (typeof item !== "string" || !item.trim()) throw new Error(key + " 必须是字符串数组");
        return item.trim();
    }))];
}

function optionalStringArray(value: unknown, key: string) {
    if (value === undefined) return undefined;
    return stringArray(value, key);
}

function positiveNumber(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new Error("数值必须是大于等于 1 的数字");
    return value;
}

function boundedInteger(value: unknown, min: number, max: number) {
    const number = boundedNumber(value, min, max);
    if (number !== undefined && !Number.isInteger(number)) throw new Error("数值必须是整数");
    return number;
}

function boundedNumber(value: unknown, min: number, max: number) {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("数值必须在 " + min + " 到 " + max + " 之间");
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
