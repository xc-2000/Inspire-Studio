import type { ReferenceImage } from "@/features/generation/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/features/generation/types/media";
import type { ObjectStorageFile } from "@/shared/types/object-storage";
import type { CanvasVideoGenerationSettings } from "../types";

export type CanvasVideoReferenceRestoreDependencies = {
    resolveImageUrl: (storageKey: string, fallback?: string) => Promise<string>;
    resolveMediaUrl: (storageKey: string, fallback?: string) => Promise<string>;
    resolveAudioReferences: (references: ReferenceAudio[]) => Promise<ReferenceAudio[]>;
};

export type RestoredCanvasVideoReferences = {
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    incomplete: boolean;
};

type PersistableReference = { objectStorage?: { url?: string }; url?: string; storageKey?: string; dataUrl?: string };

/** Validate an address for a browser preview; storage keys require asynchronous restoration. */
export function canvasMediaReferenceSource(value: unknown, kind: "image" | "video" | "audio" = "image"): string {
    const source = cleanSource(value);
    return isMediaSource(source, kind) ? source : "";
}

/** Keep upstream references first and discard repeated saved addresses within either list. */
export function mergeUniqueReferences<T extends PersistableReference>(primary: T[], extra: T[]): T[] {
    const seen = new Set<string>();
    return [...primary, ...extra].filter(reference => {
        const keys = [reference.storageKey, reference.objectStorage?.url, reference.url, reference.dataUrl]
            .map(cleanSource).filter(Boolean);
        const duplicate = keys.some(key => seen.has(key));
        keys.forEach(key => seen.add(key));
        return !duplicate;
    });
}

/** Restore browser-readable references before the video flow uploads local sources to cloud storage. */
export async function restoreCanvasVideoGenerationReferences(
    generation: CanvasVideoGenerationSettings | null,
    dependencies: CanvasVideoReferenceRestoreDependencies,
): Promise<RestoredCanvasVideoReferences | null> {
    if (!generation) return null;
    const imageReferences = Array.isArray(generation.references) ? generation.references : [];
    const imageObjectStorages = Array.isArray(generation.referenceObjectStorages) ? generation.referenceObjectStorages : [];
    const videoReferences = Array.isArray(generation.videoReferences) ? generation.videoReferences : [];
    const videoObjectStorages = Array.isArray(generation.videoReferenceObjectStorages) ? generation.videoReferenceObjectStorages : [];
    const audioReferences = Array.isArray(generation.audioReferences) ? generation.audioReferences : [];
    const hasPersistedReferences = audioReferences.length || imageReferences.length
        || Array.isArray(generation.videoReferences) || Array.isArray(generation.videoReferenceObjectStorages);
    if (!hasPersistedReferences) return null;

    const legacyEntries = imageReferences.map(value => {
        const reference = cleanSource(value);
        return { reference, objectStorage: findObjectStorage(imageObjectStorages, reference) };
    });
    const imageEntries = legacyEntries.filter(entry => !isVideoReference(entry.reference, entry.objectStorage));
    const legacyVideoEntries = legacyEntries.filter(entry => isVideoReference(entry.reference, entry.objectStorage));
    const referenceImages = await Promise.all(imageEntries.map(async ({ reference, objectStorage }, index): Promise<ReferenceImage | null> => {
        const storageKey = validStorageKey(reference, "image") ? reference : undefined;
        const stableStorage = isHttpUrl(cleanSource(objectStorage?.url)) ? objectStorage : undefined;
        const dataUrl = await restoreSource(reference, stableStorage, "image", storageKey, dependencies.resolveImageUrl);
        if (!dataUrl) return null;
        return {
            id: `saved-video-image-${index}`,
            name: `reference-${index + 1}.png`,
            type: objectStorage?.mimeType || "image/png",
            dataUrl,
            ...(isHttpUrl(dataUrl) ? { url: dataUrl } : {}),
            ...(storageKey ? { storageKey } : {}),
            ...(stableStorage ? { objectStorage: stableStorage } : {}),
        };
    }));
    const videoEntries = [...legacyVideoEntries, ...videoReferences.map(value => {
        const reference = cleanSource(value);
        return { reference, objectStorage: findObjectStorage(videoObjectStorages, reference) };
    })];
    const referenceVideos = await Promise.all(videoEntries.map(async ({ reference, objectStorage }, index): Promise<ReferenceVideo | null> => {
        const storageKey = validStorageKey(reference, "video") ? reference : undefined;
        const stableStorage = isHttpUrl(cleanSource(objectStorage?.url)) ? objectStorage : undefined;
        const url = await restoreSource(reference, stableStorage, "video", storageKey, dependencies.resolveMediaUrl);
        if (!url) return null;
        return {
            id: `saved-video-reference-${index}`,
            name: `reference-${index + 1}.mp4`,
            type: objectStorage?.mimeType || "video/mp4",
            url,
            ...(storageKey ? { storageKey } : {}),
            ...(objectStorage?.bytes !== undefined ? { bytes: objectStorage.bytes } : {}),
            ...(stableStorage ? { objectStorage: stableStorage } : {}),
        };
    }));
    let referenceAudios: ReferenceAudio[] = [];
    let audioIncomplete = false;
    try {
        referenceAudios = await dependencies.resolveAudioReferences(audioReferences);
        audioIncomplete = referenceAudios.some(audio => !audio.storageKey || !isMediaSource(cleanSource(audio.url), "audio"));
    } catch { audioIncomplete = true; }
    return {
        referenceImages: mergeUniqueReferences([], referenceImages.filter((reference): reference is ReferenceImage => Boolean(reference))),
        referenceVideos: mergeUniqueReferences([], referenceVideos.filter((reference): reference is ReferenceVideo => Boolean(reference))),
        referenceAudios,
        incomplete: audioIncomplete || referenceImages.some(reference => !reference) || referenceVideos.some(reference => !reference),
    };
}

async function restoreSource(
    reference: string,
    objectStorage: ObjectStorageFile | undefined,
    kind: "image" | "video",
    storageKey: string | undefined,
    resolveStoredUrl: (storageKey: string, fallback?: string) => Promise<string>,
) {
    if (!storageKey && !canvasMediaReferenceSource(reference, kind)) return "";
    if (objectStorage && isHttpUrl(cleanSource(objectStorage.url))) return objectStorage.url.trim();
    if (storageKey) {
        try {
            const source = cleanSource(await resolveStoredUrl(storageKey, ""));
            return canvasMediaReferenceSource(source, kind);
        } catch { return ""; }
    }
    return canvasMediaReferenceSource(reference, kind);
}

function findObjectStorage(files: ObjectStorageFile[], reference: string) {
    if (!reference) return undefined;
    const key = reference.replace(/^(?:image|video):/, "");
    return files.find(file => cleanSource(file?.url) === reference || cleanSource(file?.key) === key);
}

function isVideoReference(reference: string, objectStorage?: ObjectStorageFile) {
    return objectStorage?.mimeType?.toLowerCase().startsWith("video/")
        || /^(?:video:|data:video\/|.*\.(mp4|webm|mov|m4v)(?:[?#]|$))/i.test(reference);
}

function validStorageKey(value: string, kind: "image" | "video") {
    return value.startsWith(`${kind}:`) && Boolean(value.slice(kind.length + 1).trim()) && !/[\r\n\\]/.test(value);
}

function cleanSource(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string) {
    if (!/^https?:\/\//i.test(value)) return false;
    try { return Boolean(new URL(value).hostname); } catch { return false; }
}

function isMediaSource(value: string, kind: "image" | "video" | "audio") {
    if (!value || /[\r\n\\]/.test(value)) return false;
    if (isHttpUrl(value)) return true;
    if (/^blob:/i.test(value)) return Boolean(value.slice(5).trim());
    if (/^data:/i.test(value)) return new RegExp(`^data:${kind}/[a-z0-9.+-]+(?:;[^,]*)?,.+$`, "i").test(value);
    // Keep relative browser sources relative; server-side downloads cannot access local origins.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
    try { return Boolean(new URL(value, "https://canvas.invalid/").hostname); } catch { return false; }
}
