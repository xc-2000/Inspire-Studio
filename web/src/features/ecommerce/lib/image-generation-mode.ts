export type CommerceImageGenerationMode = "text-to-image" | "image-to-image";

/** Existing projects without a saved mode keep their previous reference-based behavior. */
export function resolveCommerceImageGenerationMode(mode: unknown, imageReferenceCount: number): CommerceImageGenerationMode {
    if (mode === "text-to-image" || mode === "image-to-image") return mode;
    return imageReferenceCount > 0 ? "image-to-image" : "text-to-image";
}

/** Historical tasks record the references actually sent, independent of today's product images. */
export function commerceImageGenerationModeFromRequest(requestData: unknown): CommerceImageGenerationMode | undefined {
    if (!requestData || typeof requestData !== "object" || Array.isArray(requestData)) return undefined;
    const references = (requestData as { references?: unknown }).references;
    if (!Array.isArray(references)) return undefined;
    return references.length > 0 ? "image-to-image" : "text-to-image";
}
