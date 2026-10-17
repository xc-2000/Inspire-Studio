import type { CanvasAgentJsonFallbackMode, CanvasAgentProtocolMessage, CanvasAgentState } from "./upstream/types";
import type { CanvasAgentSkillSelection, CanvasAgentSkillSource } from "../types";
import type { OneSentenceFilm } from "./one-sentence-film";

/** Stored with the existing user/project conversation, never with provider credentials. */
export type InfiniteAgentMemory = {
    state: CanvasAgentState;
    protocolMessages: CanvasAgentProtocolMessage[];
    contextCheckpoint?: string;
    jsonFallbackMode?: CanvasAgentJsonFallbackMode;
    status: "running" | "completed" | "interrupted";
    requestId: string;
    updatedAt: string;
    interruptionRecorded?: boolean;
    activeSkills?: CanvasAgentSkillSelection[];
    skillSource?: CanvasAgentSkillSource;
    film?: OneSentenceFilm;
};

export function recoverInfiniteAgentMemory(memory?: InfiniteAgentMemory): InfiniteAgentMemory | undefined {
    if (!memory || !Array.isArray(memory.protocolMessages) || !memory.state) return undefined;
    if ((memory.status === "completed" || memory.interruptionRecorded) && memory.film?.status !== "running") return memory;
    return {
        ...memory,
        status: "interrupted",
        interruptionRecorded: true,
        ...(memory.film?.status === "running" ? { film: { ...memory.film, status: "interrupted" as const } } : {}),
        protocolMessages: [...memory.protocolMessages, {
            role: "user",
            content: "上一轮执行尚未完成，可能已停止、失败或因页面刷新中断。已经创建的节点和已提交的媒体任务以当前画布为准。先查询真实节点/任务，再响应新请求；不要自动重放上一轮生成。",
        }],
    };
}

/** A synchronous guard also blocks two submissions in the same React event turn. */
export class InfiniteAgentRunGuard {
    private active: AbortController | null = null;
    start() {
        if (this.active) return null;
        this.active = new AbortController();
        return this.active;
    }
    finish(controller: AbortController) { if (this.active === controller) this.active = null; }
    cancel() { this.active?.abort(); }
    get running() { return this.active !== null; }
}
