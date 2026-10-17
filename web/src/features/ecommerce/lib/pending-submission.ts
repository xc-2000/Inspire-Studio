import type { CommerceGenerateInput } from "../api/ecommerce";

export type CommercePendingSubmission = { request: CommerceGenerateInput };

/** Older tabs stored an additional signature; recovery deliberately ignores mutable editor state. */
export function restoreCommerceSubmission(value: unknown, projectId: string): CommercePendingSubmission | null {
    if (!value || typeof value !== "object" || !("request" in value)) return null;
    const request = value.request;
    if (!request || typeof request !== "object") return null;
    const input = request as Partial<CommerceGenerateInput>;
    if (input.projectId !== projectId || typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)) return null;
    if (!input.kind || !["copy", "detail-copy", "video-script", "image", "video"].includes(input.kind)) return null;
    if (typeof input.model !== "string" || !input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)) return null;
    return { request: input as CommerceGenerateInput };
}

/** A lost response must be resolved before current inputs can create another charged task. */
export async function prepareCommerceSubmission(pending: CommercePendingSubmission | null, createFresh: () => Promise<CommerceGenerateInput>) {
    if (pending) return { request: pending.request, recovering: true };
    return { request: await createFresh(), recovering: false };
}

export function isDefiniteCommerceRejection(code: number | undefined, message: string): boolean {
    // A login failure says nothing about the first request's outcome; preserve its id for after login.
    if (code == null || !([2000, 2001, 2002, 4000, 4001, 4002, 4003] as number[]).includes(code)) return false;
    return !message.includes("同一请求标识") && !message.includes("不同生成参数");
}
