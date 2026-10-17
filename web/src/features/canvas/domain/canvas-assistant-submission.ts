import { EMPTY_ASSISTANT_DRAFT, type CanvasAssistantDraft } from "./canvas-assistant-workspace";

/** Clear only the draft that was accepted, preserving text entered while the request was being submitted. */
export function settleCanvasAssistantDraft(current: CanvasAssistantDraft, submitted: CanvasAssistantDraft, accepted: boolean): CanvasAssistantDraft {
    if (!accepted || JSON.stringify(current) !== JSON.stringify(submitted)) return current;
    return EMPTY_ASSISTANT_DRAFT;
}

export async function submitCanvasAssistantDraft(submit: () => boolean | Promise<boolean>): Promise<boolean> {
    try { return await submit(); } catch { return false; }
}
