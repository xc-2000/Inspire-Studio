import type { GenerationStyleOption } from "@/services/api/server";
import type { CanvasAgentSkillSelection, CanvasAssistantSession, CanvasNode, CanvasNodeKind } from "../types.ts";
import { CANVAS_AGENT_SKILL_TYPE_LABELS, canvasAgentSkillSourceLabel, normalizeCanvasAgentSkillSelections } from "./canvas-agent-skill-library";

export interface CanvasAssistantDraft {
    prompt: string;
    nodeIds: string[];
    styles: GenerationStyleOption[];
    skills?: CanvasAgentSkillSelection[];
}

export const EMPTY_ASSISTANT_DRAFT: CanvasAssistantDraft = { prompt: "", nodeIds: [], styles: [] };

export function removeAssistantDraftNodes(draft: CanvasAssistantDraft, removedIds: ReadonlySet<string>): CanvasAssistantDraft {
    return {
        ...draft,
        nodeIds: draft.nodeIds.filter((id) => !removedIds.has(id)),
        prompt: draft.prompt.split(/(\s+)/).filter((part) => !removedIds.has(part)).join("").trim(),
    };
}

export function assistantDraftKey(userId: string, projectId: string, sessionId: string | null) {
    return `inspire:canvas-draft:v1:${JSON.stringify([userId, projectId, sessionId])}`;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Separate keys keep pending input out of chat history and other projects/accounts. */
export function createAssistantDraftStore(storage: () => DraftStorage) {
    const drafts = new Map<string, CanvasAssistantDraft>();
    const listeners = new Set<() => void>();
    const read = (key: string): CanvasAssistantDraft => {
        if (!drafts.has(key)) {
            let draft = EMPTY_ASSISTANT_DRAFT;
            try {
                const raw = storage().getItem(key);
                if (raw) draft = parseAssistantDraft(JSON.parse(raw));
            } catch { /* An unavailable browser store must not disable the composer. */ }
            drafts.set(key, draft);
        }
        return drafts.get(key)!;
    };
    return {
        read,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        update(key: string, updater: (draft: CanvasAssistantDraft) => CanvasAssistantDraft) {
            const next = updater(read(key));
            drafts.set(key, next);
            let persisted = true;
            try {
                if (!next.prompt && !next.nodeIds.length && !next.styles.length && !next.skills?.length) storage().removeItem(key);
                else storage().setItem(key, JSON.stringify(next));
            } catch { persisted = false; }
            listeners.forEach((listener) => listener());
            return persisted;
        },
    };
}

export function parseAssistantDraft(value: unknown): CanvasAssistantDraft {
    if (!value || typeof value !== "object") return EMPTY_ASSISTANT_DRAFT;
    const draft = value as Partial<CanvasAssistantDraft>;
    return {
        prompt: typeof draft.prompt === "string" ? draft.prompt : "",
        nodeIds: Array.isArray(draft.nodeIds) ? [...new Set(draft.nodeIds.filter((id) => typeof id === "string"))] : [],
        styles: Array.isArray(draft.styles) ? draft.styles.filter((style) => style && Number.isFinite(style.id) && typeof style.name === "string" && (style.generationType === "image" || style.generationType === "video")).map((style) => ({
            id: style.id, name: style.name, generationType: style.generationType,
            coverUrl: typeof style.coverUrl === "string" ? style.coverUrl : "",
            category: typeof style.category === "string" ? style.category : "",
        })) : [],
        ...(Array.isArray(draft.skills) ? { skills: normalizeCanvasAgentSkillSelections(draft.skills) } : {}),
    };
}

export const ASSISTANT_NODE_LABELS: Record<CanvasNodeKind, string> = {
    text: "文本", image: "图片", video: "视频", audio: "音频", storyboard: "分镜", videoComposition: "视频合成", background: "背景板",
};

export function findAssistantNodes(nodes: CanvasNode[], query: string, kind?: CanvasNodeKind) {
    const keyword = query.trim().toLocaleLowerCase();
    return nodes.filter((node) => (!kind || node.kind === kind) && (!keyword || [node.title, node.id, ASSISTANT_NODE_LABELS[node.kind], node.kind === "text" ? node.content.text : ""].join(" ").toLocaleLowerCase().includes(keyword)));
}

export function findAssistantSessions(sessions: CanvasAssistantSession[], query: string) {
    const keyword = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => !keyword || session.title.toLocaleLowerCase().includes(keyword) || session.messages.some((message) => message.text.toLocaleLowerCase().includes(keyword)))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function exportAssistantSession(session: CanvasAssistantSession) {
    const roleLabels = { user: "我", assistant: "画布助手", system: "创作计划", tool: "工具执行", error: "任务提醒" };
    const lines = [`# ${session.title.replace(/[\r\n]+/g, " ") || "画布对话"}`, "", `创建时间：${session.createdAt}`, ""];
    for (const message of session.messages) {
        lines.push(`## ${roleLabels[message.role]}${message.title ? ` · ${message.title.replace(/[\r\n]+/g, " ")}` : ""}`, "", message.text, "");
        if (message.meta) lines.push(message.meta, "");
        if (message.references?.length) lines.push(`引用节点：${message.references.map((reference) => reference.title || reference.id).join("、")}`, "");
        if (message.generationStyles?.length) lines.push(`使用风格：${message.generationStyles.map((style) => style.name).join("、")}`, "");
        if (message.skills?.length) lines.push(`${canvasAgentSkillSourceLabel(message.skillSource)}：${message.skills.map((skill) => `${CANVAS_AGENT_SKILL_TYPE_LABELS[skill.targetType]} · ${skill.name}`).join("、")}`, "");
    }
    // Export readable conversation only, excluding internal tool payloads and media URLs.
    const name = session.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "画布对话";
    return { filename: `${name}.md`, text: `${lines.join("\n").trim()}\n` };
}
