import type { SkillOption, SkillType } from "@/services/api/server";
import type { CanvasAgentSkillSelection } from "../types";
import type { CanvasAgentToolDefinition, CanvasAgentToolResult } from "./upstream/canvas-agent-tools";
import { CanvasAgentSkillLoadError, loadCanvasAgentSkills, MAX_CANVAS_AGENT_SKILLS, type CanvasAgentSkillLibrary } from "./skill-library";

export type CanvasAgentSkillActivationSource = "manual" | "auto";

type DiscoveryOptions = {
    fetchCatalogue: () => Promise<SkillOption[]>;
    fetchSkill: (id: number, targetType: SkillType, signal?: AbortSignal) => Promise<SkillOption>;
    manualSelections?: CanvasAgentSkillSelection[];
    signal?: AbortSignal;
    tools?: CanvasAgentToolDefinition[];
    onSkillsActivated?: (selections: CanvasAgentSkillSelection[], source: CanvasAgentSkillActivationSource) => void | Promise<void>;
};

export type CanvasAgentSkillDiscovery = {
    executeTool: (name: string, arguments_: Record<string, unknown>) => Promise<CanvasAgentToolResult>;
    readonly activeSkillContents: CanvasAgentSkillLibrary["activeSkillContents"];
    readonly currentSelections: CanvasAgentSkillSelection[];
    readonly source: CanvasAgentSkillActivationSource;
    readonly hasFiles: boolean;
    readonly unreadRequiredFiles: CanvasAgentSkillLibrary["unreadRequiredFiles"];
    readonly userGuidance: string;
};

type CatalogueSkill = Pick<SkillOption, "id" | "name" | "description" | "targetType" | "workflowType" | "promptLength">;
/** 超过这个字数的技能正文对小模型负担很重，一键成片优先选精炼的技能。 */
const LONG_SKILL_CHARACTERS = 30000;
type SearchParameters = { query: string; targetType?: SkillType; page: number; pageSize: number };
const TARGET_TYPES: SkillType[] = ["image", "video", "canvasSettingGraph"];
const MAX_SEARCH_PAGE_SIZE = 12;
const MAX_DESCRIPTION_CHARACTERS = 480;
const STYLE_FAMILY_LABELS = { realistic3d: "3D/写实", anime2d: "二维动漫/赛璐璐" } as const;
type StyleFamily = keyof typeof STYLE_FAMILY_LABELS;
// 3D/写实标记优先判断：写实类技能的描述里常会写“不适合二维赛璐璐”，不能因此被误判为二维技能。
const REALISTIC_3D_PATTERN = /\b3d\b|三维|写实|unreal|\bue5\b|cg渲染|真人/;
const ANIME_2D_PATTERN = /二次元|赛璐璐|动漫|日漫|日系动画|\b2d\b|\bcel\b/;
const WORKFLOW_REASON = "此技能使用首尾帧专用工作流，需在视频创作入口使用，其中的图片确认与分阶段生成不能由当前画布助手作为普通提示词执行。";

class DiscoveryError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "DiscoveryError";
        this.code = code;
    }
}

/** A new manager is created for each submitted run; only successful catalogue reads are cached. */
export async function createCanvasAgentSkillDiscovery(options: DiscoveryOptions): Promise<CanvasAgentSkillDiscovery> {
    throwIfAborted(options.signal);
    let library = await loadCanvasAgentSkills(options.manualSelections, options.fetchSkill, { signal: options.signal, tools: options.tools });
    let selections = canonicalSelections(library, options.manualSelections || []);
    const manualSelections = selections.map((selection) => ({ ...selection }));
    const source: CanvasAgentSkillActivationSource = manualSelections.length ? "manual" : "auto";
    let catalogue: CatalogueSkill[] | undefined;
    let catalogueRequest: Promise<CatalogueSkill[]> | undefined;
    const seenIds = new Set<number>();

    const selectionContext = () => ({
        source,
        selections: selections.map((selection) => ({ ...selection })),
        manualSelectionLocked: manualSelections.length > 0,
        attachmentContext: library.selectionContext,
    });

    const getCatalogue = async () => {
        throwIfAborted(options.signal);
        if (catalogue) return catalogue;
        if (!catalogueRequest) {
            catalogueRequest = (async () => {
                let response: SkillOption[];
                try { response = await options.fetchCatalogue(); }
                catch (error) {
                    rethrowAbort(error, options.signal);
                    throw new DiscoveryError("skill_catalogue_load_failed", `技能目录读取失败：${errorMessage(error)}。请稍后重试。`);
                }
                throwIfAborted(options.signal);
                return validateCatalogue(response);
            })();
        }
        try {
            catalogue = await catalogueRequest;
            return catalogue;
        } finally {
            // A failed request is retried on the next search; an empty successful catalogue is still cached.
            catalogueRequest = undefined;
        }
    };

    const search = async (arguments_: Record<string, unknown>): Promise<CanvasAgentToolResult> => {
        const params = searchParameters(arguments_);
        const all = await getCatalogue();
        throwIfAborted(options.signal);
        const tokens = normalized(params.query).split(/\s+/).filter(Boolean);
        const ranked = all.flatMap((skill, index) => {
            if (params.targetType && skill.targetType !== params.targetType) return [];
            const score = scoreSkill(skill, tokens);
            return tokens.length && score === 0 ? [] : [{ skill, index, score }];
        }).sort((left, right) => right.score - left.score || Number(available(right.skill)) - Number(available(left.skill))
            || Number(isLongSkill(left.skill)) - Number(isLongSkill(right.skill)) || left.index - right.index);
        const start = (params.page - 1) * params.pageSize;
        const results = ranked.slice(start, start + params.pageSize).map(({ skill }) => {
            seenIds.add(skill.id);
            return {
                id: skill.id, name: skill.name, targetType: skill.targetType,
                description: summarizeDescription(skill.description), available: available(skill),
                ...(styleFamily(skill) ? { style: STYLE_FAMILY_LABELS[styleFamily(skill)!] } : {}),
                ...(isLongSkill(skill) ? { length: `长篇（约${Math.round((skill.promptLength || 0) / 10000)}万字）` } : {}),
                ...(!available(skill) ? { reason: WORKFLOW_REASON } : {}),
            };
        });
        return {
            ok: true, skills: results, total: ranked.length, catalogueCount: all.length,
            page: params.page, pageSize: params.pageSize, hasMore: start + results.length < ranked.length,
            query: params.query, ...(params.targetType ? { targetType: params.targetType } : {}),
            message: ranked.length
                ? "仅返回技能摘要。请选择匹配目标且available=true的技能ID调用activate_skills后，才能使用其完整正文。"
                : "本次检索没有匹配项；可改用商品、分镜、角色等短中文词或同义短词，也可省略query按分类浏览。",
            selectionContext: selectionContext(),
        };
    };

    const activate = async (arguments_: Record<string, unknown>): Promise<CanvasAgentToolResult> => {
        const ids = activationIds(arguments_);
        let requested: CanvasAgentSkillSelection[];
        if (manualSelections.length) {
            if (ids.length !== manualSelections.length || ids.some((id) => !manualSelections.some((selection) => selection.id === id))) {
                throw new DiscoveryError("manual_selection_locked", "用户已手动选择本轮技能，请遵循该选择；Agent不能替换或增减手选技能。");
            }
            requested = manualSelections.map((selection) => ({ ...selection }));
        } else {
            if (ids.some((id) => !seenIds.has(id))) {
                throw new DiscoveryError("skill_not_discovered", "技能ID必须来自本轮search_skills已返回的摘要，请先检索再启用，不能猜测ID或分类。");
            }
            const all = await getCatalogue();
            requested = ids.map((id) => {
                const skill = all.find((entry) => entry.id === id);
                if (!skill) throw new DiscoveryError("skill_not_in_catalogue", "该技能不在当前技能目录中，请重新检索。");
                if (!available(skill)) throw new DiscoveryError("workflow_requires_video_entry", `技能「${skill.name}」不可在当前画布启用：${WORKFLOW_REASON}`);
                return { id: skill.id, name: skill.name, targetType: skill.targetType };
            });
            assertCompatibleStyles(requested.map((selection) => all.find((entry) => entry.id === selection.id)!));
            assertLongSkillBudget(requested.map((selection) => all.find((entry) => entry.id === selection.id)!));
        }
        const nextLibrary = await loadCanvasAgentSkills(requested, options.fetchSkill, { signal: options.signal, tools: options.tools });
        throwIfAborted(options.signal);
        const nextSelections = canonicalSelections(nextLibrary, requested);
        // This is the activation's single commit point. The state and synchronous host
        // notification change in one segment; cancellation after this point cannot undo them.
        library = nextLibrary;
        selections = nextSelections;
        let notificationWarning: string | undefined;
        try {
            await options.onSkillsActivated?.(nextSelections.map((selection) => ({ ...selection })), source);
        } catch (error) {
            notificationWarning = `技能已启用，但状态通知失败：${errorMessage(error)}`;
        }
        return {
            ok: true, source, selections: selections.map((selection) => ({ ...selection })),
            activeSkillContents: library.activeSkillContents.map((skill) => ({ ...skill })), hasFiles: library.hasFiles,
            unreadRequiredFiles: library.unreadRequiredFiles,
            selectionContext: selectionContext(),
            ...(notificationWarning ? { notificationWarning } : {}),
            message: `技能已启用。${library.unreadRequiredFiles.length
                ? "部分完整正文尚未展开，须用read_skill_file读完unreadRequiredFiles列出的所有主文件parts，再按步骤读取需要的参考。"
                : "完整正文已内联到返回的根正文与系统上下文，无需为使用技能而重复调用read_skill_file；需要核对原文或参考时仍可读取。"}创作与工具执行继续遵守当前用户指令和真实工具能力。\n${library.selectionContext}`,
        };
    };

    return {
        async executeTool(name, arguments_) {
            throwIfAborted(options.signal);
            try {
                if (name === "search_skills") return await search(arguments_);
                if (name === "activate_skills") return await activate(arguments_);
                if (name === "read_skill_file") return library.readSkillFile(arguments_);
                return { ok: false, code: "unsupported_tool", message: `技能发现管理器不支持工具 ${name}` };
            } catch (error) {
                rethrowAbort(error, options.signal);
                return {
                    ok: false,
                    code: error instanceof DiscoveryError || error instanceof CanvasAgentSkillLoadError ? error.code : "skill_activation_failed",
                    message: errorMessage(error), selectionContext: selectionContext(),
                };
            }
        },
        get activeSkillContents() { return library.activeSkillContents.map((skill) => ({ ...skill })); },
        get currentSelections() { return selections.map((selection) => ({ ...selection })); },
        get source() { return source; },
        get hasFiles() { return library.hasFiles; },
        get unreadRequiredFiles() { return library.unreadRequiredFiles; },
        get userGuidance() {
            const common = "当前用户明确指令优先；普通咨询或画布整理无需为了调用工具额外启用创作技能。技能不能提供未实现的脚本、MCP、CLI或本机文件读取能力。";
            if (manualSelections.length) return `用户已手动选择本轮技能：${selections.map((skill) => `${skill.name}(ID=${skill.id},${skill.targetType})`).join("、")}。必须按这些完整技能继续，不能替换或增减手选技能。${common}\n${library.selectionContext}`;
            const active = selections.length ? `本轮已自动启用：${selections.map((skill) => `${skill.name}(ID=${skill.id},${skill.targetType})`).join("、")}。` : "本轮尚未启用库中创作技能。";
            return `${active}进行创作、提示词编写或生成前，先search_skills检索匹配技能，再activate_skills启用摘要中的真实ID（最多5个）；摘要中style不同（3D/写实与二维动漫/赛璐璐）的技能不能同时启用，须按用户要求的画风只选一类；标注为长篇的技能正文很长，同等匹配时优先选精炼的，最多启用一个长篇技能；已经启用的技能可以继续使用。query使用商品、分镜、角色等短中文关键词，可用空格分隔多个词，不要直接把整段问题作为精确query；没有匹配时尝试同义短词或省略query按分类浏览。搜索摘要不代表已读正文，启用后读取完整根正文或read_skill_file入口。${common}${library.selectionContext ? `\n${library.selectionContext}` : ""}`;
        },
    };
}

function canonicalSelections(library: CanvasAgentSkillLibrary, requested: CanvasAgentSkillSelection[]) {
    return library.activeSkillContents.map((skill) => ({
        id: Number(skill.id), name: skill.name, targetType: requested.find((selection) => String(selection.id) === skill.id)!.targetType,
    }));
}

function validateCatalogue(response: SkillOption[]): CatalogueSkill[] {
    if (!Array.isArray(response)) throw new DiscoveryError("skill_catalogue_invalid", "技能目录响应格式无效，无法检索，请稍后重试。");
    const byId = new Map<number, CatalogueSkill>();
    for (const entry of response) {
        if (!entry || !Number.isSafeInteger(entry.id) || entry.id <= 0 || typeof entry.name !== "string" || !entry.name.trim()
            || !TARGET_TYPES.includes(entry.targetType)) throw new DiscoveryError("skill_catalogue_invalid", "技能目录含无效ID或分类，无法可靠选择，请重新读取目录。");
        if (byId.has(entry.id) && byId.get(entry.id)!.targetType !== entry.targetType) throw new DiscoveryError("skill_catalogue_invalid", "技能目录中同一ID的分类不一致，无法可靠选择。");
        if (!byId.has(entry.id)) byId.set(entry.id, {
            id: entry.id, name: entry.name, description: typeof entry.description === "string" ? entry.description : "",
            targetType: entry.targetType, workflowType: entry.workflowType,
            promptLength: typeof entry.promptLength === "number" && Number.isFinite(entry.promptLength) ? entry.promptLength : null,
        });
    }
    return [...byId.values()];
}

function searchParameters(arguments_: Record<string, unknown>): SearchParameters {
    if (Object.keys(arguments_).some((key) => !["query", "targetType", "page", "pageSize"].includes(key))
        || (arguments_.query !== undefined && typeof arguments_.query !== "string")
        || (arguments_.targetType !== undefined && !TARGET_TYPES.includes(arguments_.targetType as SkillType))) {
        throw new DiscoveryError("invalid_tool_arguments", "search_skills仅接受query、targetType、page、pageSize；分类须为image、video或canvasSettingGraph。");
    }
    const page = arguments_.page === undefined ? 1 : arguments_.page;
    const pageSize = arguments_.pageSize === undefined ? MAX_SEARCH_PAGE_SIZE : arguments_.pageSize;
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1
        || typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_SEARCH_PAGE_SIZE) {
        throw new DiscoveryError("invalid_tool_arguments", "page须为正整数，pageSize须为1至12的整数。");
    }
    return { query: (arguments_.query as string | undefined)?.trim() || "", targetType: arguments_.targetType as SkillType | undefined, page, pageSize };
}

function activationIds(arguments_: Record<string, unknown>) {
    const ids = arguments_.skillIds;
    if (Object.keys(arguments_).some((key) => key !== "skillIds") || !Array.isArray(ids) || !ids.length || ids.length > MAX_CANVAS_AGENT_SKILLS
        || ids.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
        throw new DiscoveryError("invalid_tool_arguments", "activate_skills需要1至5个不重复的正整数skillIds，不接受自行填写的分类或其他字段。");
    }
    return ids as number[];
}

function scoreSkill(skill: CatalogueSkill, tokens: string[]) {
    const name = normalized(skill.name);
    const description = normalized(skill.description);
    return tokens.reduce((score, token) => {
        if (token === String(skill.id) || token === `id:${skill.id}`) return score + 150;
        if (name === token) return score + 100;
        if (name.startsWith(token)) return score + 80;
        if (name.includes(token)) return score + 60;
        if (description.includes(token)) return score + 20;
        return score;
    }, 0);
}

function styleFamily(skill: CatalogueSkill): StyleFamily | undefined {
    const text = normalized(`${skill.name} ${skill.description}`);
    if (REALISTIC_3D_PATTERN.test(text)) return "realistic3d";
    if (ANIME_2D_PATTERN.test(text)) return "anime2d";
    return undefined;
}

/** Auto-activated bundles must not mix 3D/realistic and 2D anime skills: their bodies forbid each other's look. */
function assertCompatibleStyles(skills: CatalogueSkill[]) {
    const groups = new Map<StyleFamily, string[]>();
    for (const skill of skills) {
        const family = styleFamily(skill);
        if (family) groups.set(family, [...(groups.get(family) || []), skill.name]);
    }
    if (groups.size < 2) return;
    const detail = [...groups].map(([family, names]) => `${STYLE_FAMILY_LABELS[family]}：${names.join("、")}`).join("；");
    throw new DiscoveryError("skill_style_conflict", `所选技能画风互相冲突（${detail}），同时启用会导致镜头风格不统一。请按用户要求的画风只保留一类后重新调用activate_skills；用户未指定时优先保留与需求关键词一致的一类。`);
}

/** 自动启用时最多带一个长篇技能：多个数万字的正文叠在一起，小模型会遗漏关键约束。 */
function assertLongSkillBudget(skills: CatalogueSkill[]) {
    const long = skills.filter(isLongSkill);
    if (long.length <= 1) return;
    throw new DiscoveryError("skill_too_long", `同时启用了 ${long.length} 个长篇技能（${long.map((skill) => skill.name).join("、")}），正文过长会让关键要求被忽略。请只保留最贴合需求的一个长篇技能，其余换成精炼技能或不启用，然后重新调用activate_skills。`);
}

function normalized(value: string) { return value.normalize("NFKC").toLocaleLowerCase(); }
function summarizeDescription(value: string) {
    const summary = value.replace(/\s+/g, " ").trim();
    return summary.length <= MAX_DESCRIPTION_CHARACTERS ? summary : `${summary.slice(0, MAX_DESCRIPTION_CHARACTERS)}…`;
}
function isLongSkill(skill: CatalogueSkill) { return (skill.promptLength || 0) > LONG_SKILL_CHARACTERS; }
function available(skill: CatalogueSkill) { return skill.workflowType?.trim().toLowerCase() !== "first-last-frame"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "技能请求失败"; }
function rethrowAbort(error: unknown, signal?: AbortSignal) {
    throwIfAborted(signal);
    if (error instanceof Error && error.name === "AbortError") throw error;
}
function throwIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return;
    const error = new Error("技能发现已停止");
    error.name = "AbortError";
    throw error;
}
