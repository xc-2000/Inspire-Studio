import type { AgentAttachment } from "@/features/canvas/api/agent";

type ReferenceMedia = {
    name?: string;
    type?: string;
    mimeType?: string;
    dataUrl?: string;
    url?: string;
    storageKey?: string;
    objectStorage?: { url?: string } | null;
};

export function referenceMediaUrl(reference: ReferenceMedia): string {
    return [reference.objectStorage?.url, reference.url, reference.dataUrl]
        .map((value) => value?.trim() || "")
        .find(Boolean) || "";
}

export function referenceMediaType(reference: ReferenceMedia, fallbackType: string): string {
    const declaredType = reference.type?.trim() || reference.mimeType?.trim() || "";
    if (declaredType && !declaredType.endsWith("/*") && declaredType !== "application/octet-stream") return declaredType;
    return mediaTypeFromUrl(referenceMediaUrl(reference)) || declaredType || fallbackType;
}

export function imageReferenceAttachments(references: readonly ReferenceMedia[]): AgentAttachment[] {
    return references.flatMap((reference) => toAgentAttachment(reference, "image/*", "参考图"));
}

export function videoReferenceAttachments(references: readonly ReferenceMedia[]): AgentAttachment[] {
    return references.flatMap((reference) => toAgentAttachment(reference, "video/*", "参考视频"));
}

export function audioReferenceAttachments(references: readonly ReferenceMedia[]): AgentAttachment[] {
    return references.flatMap((reference) => toAgentAttachment(reference, "audio/mpeg", "参考音频"));
}

function toAgentAttachment(reference: ReferenceMedia, fallbackType: string, fallbackName: string): AgentAttachment[] {
    const url = referenceMediaUrl(reference);
    const storageKey = reference.storageKey?.trim() || "";
    if (!url && !storageKey) return [];
    return [{
        url,
        type: referenceMediaType(reference, fallbackType),
        name: reference.name?.trim() || fallbackName,
        ...(storageKey ? { storageKey } : {}),
    }];
}

function mediaTypeFromUrl(url: string): string {
    const path = url.split(/[?#]/, 1)[0].toLowerCase();
    const extension = path.match(/\.([a-z0-9]+)$/)?.[1] || "";
    return ({
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        avif: "image/avif",
        bmp: "image/bmp",
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime",
        m4v: "video/x-m4v",
    } as Record<string, string>)[extension] || "";
}
