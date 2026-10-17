import type { SkillOption, SkillType } from "@/services/api/server";
import type { CanvasAgentSkillSelection, CanvasAgentSkillSource, CanvasAssistantSession } from "../types";

export const MAX_CANVAS_AGENT_SKILLS = 5;
export const CANVAS_AGENT_SKILL_LIMIT_MESSAGE = `每条消息最多选择 ${MAX_CANVAS_AGENT_SKILLS} 个技能`;
export const CANVAS_AGENT_SKILL_TYPE_LABELS: Record<SkillType, string> = { image: "图片", video: "视频", canvasSettingGraph: "设定图" };

export function normalizeCanvasAgentSkillSelections(value: unknown): CanvasAgentSkillSelection[] {
    if (!Array.isArray(value)) return [];
    const selections: CanvasAgentSkillSelection[] = [];
    const ids = new Set<number>();
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const skill = item as Partial<CanvasAgentSkillSelection>;
        if (!Number.isSafeInteger(skill.id) || !skill.id || skill.id < 1 || typeof skill.name !== "string" || !skill.name.trim() || !skill.targetType || !Object.prototype.hasOwnProperty.call(CANVAS_AGENT_SKILL_TYPE_LABELS, skill.targetType) || ids.has(skill.id)) continue;
        selections.push({ id: skill.id, name: skill.name.trim(), targetType: skill.targetType });
        ids.add(skill.id);
        if (selections.length >= MAX_CANVAS_AGENT_SKILLS) break;
    }
    return selections;
}

export function toggleCanvasAgentSkill(selections: CanvasAgentSkillSelection[], skill: CanvasAgentSkillSelection): { selections: CanvasAgentSkillSelection[]; limitReached: boolean } {
    if (selections.some((selected) => selected.id === skill.id)) return { selections: selections.filter((selected) => selected.id !== skill.id), limitReached: false };
    if (selections.length >= MAX_CANVAS_AGENT_SKILLS) return { selections, limitReached: true };
    return { selections: normalizeCanvasAgentSkillSelections([...selections, skill]), limitReached: false };
}

export function findCanvasAgentSkills(skills: SkillOption[], query: string, targetType?: SkillType): SkillOption[] {
    const keyword = query.trim().toLocaleLowerCase();
    return skills.filter((skill) => (!targetType || skill.targetType === targetType) && (!keyword || `${skill.name} ${skill.description} ${skill.id} ${CANVAS_AGENT_SKILL_TYPE_LABELS[skill.targetType]}`.toLocaleLowerCase().includes(keyword)));
}

export function isDedicatedCanvasAgentSkill(skill: Pick<SkillOption, "workflowType">) { return skill.workflowType === "first-last-frame"; }
export function canvasAgentSkillSourceLabel(source?: CanvasAgentSkillSource) { return source === "auto" ? "自动匹配技能" : source === "manual" ? "手动指定技能" : "使用技能"; }

/** Attach real activated skills to this request's user message, without changing previous turns. */
export function activateCanvasAssistantSkills(session: CanvasAssistantSession, skills: CanvasAgentSkillSelection[], source: CanvasAgentSkillSource, userMessageId?: string, now = new Date().toISOString()): CanvasAssistantSession {
    const target = userMessageId
        ? session.messages.find((message) => message.id === userMessageId && message.role === "user")
        : session.messages.findLast((message) => message.role === "user");
    // A rejected/canceled pending message may have been removed before activation finished.
    if (!target) return session;
    const selections = normalizeCanvasAgentSkillSelections(skills);
    return { ...session, messages: session.messages.map((message) => message.id === target.id ? { ...message, skills: selections, skillSource: source } : message), updatedAt: now };
}
