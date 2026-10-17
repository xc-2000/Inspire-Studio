import type { CanvasAssistantSession } from "../types.ts";

export interface CanvasAgentRequestBinding {
    chatId: string;
    message: string;
    chapterId: string | null;
    sessionId?: string;
    requestId?: string;
}

type BindingStorage = Pick<Storage, "getItem" | "setItem">;

/** Backend session IDs are independent of the IDs used by the local conversation. */
export function createCanvasAgentBindingStore(storage: () => BindingStorage) {
    const bindings = new Map<string, CanvasAgentRequestBinding>();
    const keyFor = (userId: string, projectId: string) => `inspire:canvas-agent-binding:v1:${JSON.stringify([userId, projectId])}`;
    return {
        read(userId: string, projectId: string): CanvasAgentRequestBinding | null {
            const key = keyFor(userId, projectId);
            try {
                const value = JSON.parse(storage().getItem(key) || "null") as Partial<CanvasAgentRequestBinding> | null;
                if (!value || typeof value.chatId !== "string" || typeof value.message !== "string") return bindings.get(key) || null;
                const binding: CanvasAgentRequestBinding = {
                    chatId: value.chatId, message: value.message,
                    chapterId: typeof value.chapterId === "string" ? value.chapterId : null,
                    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
                    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
                };
                bindings.set(key, binding);
                return binding;
            } catch { return bindings.get(key) || null; }
        },
        write(userId: string, projectId: string, binding: CanvasAgentRequestBinding) {
            const key = keyFor(userId, projectId);
            bindings.set(key, binding);
            try { storage().setItem(key, JSON.stringify(binding)); } catch { /* Keep the current page usable when storage is unavailable. */ }
        },
    };
}

export function resolveCanvasAgentChatBinding(
    active: { sessionId: string; requestId: string; message: string },
    binding: CanvasAgentRequestBinding | null,
    sessions: CanvasAssistantSession[],
): CanvasAgentRequestBinding | null {
    if (binding && (binding.requestId === active.requestId || (!binding.requestId && binding.message === active.message))) {
        return { ...binding, sessionId: active.sessionId, requestId: active.requestId };
    }
    // Older requests have no persisted mapping. Match their submitted message instead of assuming the visible chat owns them.
    const session = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .find((item) => item.messages.some((message) => message.role === "user" && message.text === active.message));
    return session ? { chatId: session.id, message: active.message, chapterId: null, sessionId: active.sessionId, requestId: active.requestId } : null;
}

/** A failed lookup must not be interpreted as a successfully queried empty request. */
export async function queryCanvasAgentRequest<T>(query: () => Promise<T>): Promise<{ ok: true; active: T } | { ok: false }> {
    try { return { ok: true, active: await query() }; } catch { return { ok: false }; }
}
