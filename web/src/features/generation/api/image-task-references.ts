import type { ReferenceImage } from "@/features/generation/types/image";
import type { UploadedImage } from "@/features/storage/services/image-storage";
import type { ServerAiTaskMediaReference } from "@/services/api/server";

export type ImageTaskReferencePreparationOptions = {
    uploadImage: (blob: Blob) => Promise<Pick<UploadedImage, "storageKey" | "url" | "mimeType" | "objectStorage">>;
    fetch?: (source: string, init?: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
};
type ReferencePlan = {
    image: ReferenceImage;
    label: string;
    mask: boolean;
    ready?: ServerAiTaskMediaReference;
    source?: string;
};

/** Convert browser-local media to stable server references before any generation task is created. */
export async function prepareImageTaskReferences(
    references: ReferenceImage[],
    mask: ReferenceImage | undefined,
    options: ImageTaskReferencePreparationOptions,
): Promise<{ references: ServerAiTaskMediaReference[]; mask?: ServerAiTaskMediaReference }> {
    throwIfAborted(options.signal);
    if (mask && references.length !== 1) throw new Error("蒙版编辑需要且仅支持一张参考图片");
    // Validate every address first, so malformed later entries do not trigger earlier uploads.
    const plans = references.map((image, index) => planReference(image, `参考图片${index + 1}`, false));
    const maskPlan = mask ? planReference(mask, "编辑蒙版", true) : undefined;
    const prepared: ServerAiTaskMediaReference[] = [];
    for (const plan of plans) prepared.push(await prepareReference(plan, options));
    const preparedMask = maskPlan ? await prepareReference(maskPlan, options) : undefined;
    throwIfAborted(options.signal);
    return { references: prepared, ...(preparedMask ? { mask: preparedMask } : {}) };
}

function planReference(image: ReferenceImage, label: string, mask: boolean): ReferencePlan {
    if (!image || typeof image !== "object") throw new Error(`${label}无效，请重新选择图片。`);
    if (mask && image.type?.trim().toLowerCase() !== "image/png") throw new Error("编辑蒙版必须是 PNG 图片，请重新准备蒙版。");
    const candidates = [image.objectStorage?.url, image.url, image.dataUrl].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim());
    const url = candidates.find(isHttpUrl);
    const storageKey = typeof image.storageKey === "string" ? image.storageKey.trim() : "";
    if (storageKey || url) return {
        image, label, mask,
        ready: { id: image.id, name: image.name, mimeType: image.type, ...(storageKey ? { storageKey } : {}), ...(url ? { url } : {}) },
    };
    const source = candidates.find(isBrowserImageSource);
    if (!source) throw new Error(`${label}缺少可用图片地址或存储键，请重新选择图片。`);
    return { image, label, mask, source };
}

async function prepareReference(plan: ReferencePlan, options: ImageTaskReferencePreparationOptions): Promise<ServerAiTaskMediaReference> {
    throwIfAborted(options.signal);
    if (plan.ready) return { ...plan.ready };
    try {
        const response = await (options.fetch || fetch)(plan.source!, { signal: options.signal });
        throwIfAborted(options.signal);
        if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
        const blob = await response.blob();
        throwIfAborted(options.signal);
        if (!blob.size) throw new Error("图片内容为空");
        if (blob.type && !blob.type.toLowerCase().startsWith("image/")) throw new Error("地址返回的内容不是图片");
        if (plan.mask && blob.type && blob.type.toLowerCase() !== "image/png") throw new Error("蒙版内容必须是 PNG 图片");
        const uploaded = await options.uploadImage(blob);
        throwIfAborted(options.signal);
        const storageKey = typeof uploaded.storageKey === "string" ? uploaded.storageKey.trim() : "";
        const url = [uploaded.objectStorage?.url, uploaded.url].find((value): value is string => typeof value === "string" && isHttpUrl(value));
        if (!storageKey || !url) throw new Error("图片上传未返回有效存储键和地址");
        if (plan.mask && uploaded.mimeType?.toLowerCase() !== "image/png") throw new Error("上传后的蒙版不是 PNG 图片");
        return { id: plan.image.id, name: plan.image.name, mimeType: uploaded.mimeType || plan.image.type, storageKey, url };
    } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new Error(`${plan.label}准备失败：${error instanceof Error ? error.message : "图片读取或上传失败"}。未提交生成任务，请检查素材后重试。`);
    }
}

function isHttpUrl(value: string) {
    if (!/^https?:\/\//i.test(value)) return false;
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch { return false; }
}
function isBrowserImageSource(value: string) {
    if (/^blob:/i.test(value)) return value.length > "blob:".length;
    if (/^data:/i.test(value)) return /^data:image\/[a-z0-9.+-]+(?:;|,)/i.test(value);
    return !/^[a-z][a-z0-9+.-]*:/i.test(value) && !/[\\\r\n]/.test(value);
}
function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("图片参考准备已取消", "AbortError");
}
