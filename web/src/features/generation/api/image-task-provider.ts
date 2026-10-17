import { nanoid } from "nanoid";

import { buildImageReferencePromptText } from "@/features/generation/lib/image-reference-prompt";
import type { ReferenceImage } from "@/features/generation/types/image";
import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { uploadImage } from "@/features/storage/services/image-storage";
import { createAiTask, waitAiTask, type ServerGenerationSource } from "@/services/api/server";

import type { ImageRequestOptions } from "./image-contracts";
import { normalizeImageTaskResult } from "./image-task-result";
import { prepareImageTaskReferences, type ImageTaskReferencePreparationOptions } from "./image-task-references";

type ServerImageTaskProviderDependencies = Omit<ImageTaskReferencePreparationOptions, "signal"> & { createTask: typeof createAiTask };

export async function requestServerGeneratedImages(config: AiConfig, prompt: string, references: ReferenceImage[], mask: ReferenceImage | undefined, generationSource: ServerGenerationSource, options?: ImageRequestOptions) {
    const task = await createServerImageTask(config, prompt, references, mask, generationSource, options);
    options?.onTaskCreated?.(task.id);
    const completed = await waitAiTask(task.id, { signal: options?.signal });
    const snapshots = readGenerationStyleSnapshots(completed.requestData);
    return normalizeImageTaskResult(completed.resultData, nanoid).map((item) => ({ ...item, generationStyleSnapshots: snapshots }));
}

/** Submit separately so a canvas can persist the task association before polling. */
export async function createServerImageTask(config: AiConfig, prompt: string, references: ReferenceImage[], mask: ReferenceImage | undefined, generationSource: ServerGenerationSource, options?: ImageRequestOptions) {
    return serverImageTaskProvider(config, prompt, references, mask, generationSource, options);
}

/** Dependencies keep media preparation and submission verifiable without network or paid models. */
export function createServerImageTaskProvider(dependencies: ServerImageTaskProviderDependencies) {
    return async (config: AiConfig, prompt: string, references: ReferenceImage[], mask: ReferenceImage | undefined, generationSource: ServerGenerationSource, options?: ImageRequestOptions) => {
        const prepared = await prepareImageTaskReferences(references, mask, { ...dependencies, signal: options?.signal });
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return dependencies.createTask({
            taskType: "image",
            prompt: references.length ? buildImageReferencePromptText(prompt, references) : prompt,
            model: config.model || config.imageModel,
            parameters: { count: normalizeImageCount(config.count), quality: config.quality, resolution: config.imageResolution, size: config.size, ...(prepared.mask ? { editMask: prepared.mask } : {}) },
            references: prepared.references,
            generationSource,
            generationStyleIds: options?.generationStyleIds,
            generationStyleSnapshots: options?.generationStyleSnapshots,
        });
    };
}

const serverImageTaskProvider = createServerImageTaskProvider({ createTask: createAiTask, uploadImage });

function readGenerationStyleSnapshots(value: unknown) {
    if (!value || typeof value !== "object") return [];
    const snapshots = (value as { generationStyleSnapshots?: unknown }).generationStyleSnapshots;
    return Array.isArray(snapshots) ? snapshots as import("@/services/api/server").GenerationStyleSnapshot[] : [];
}

function normalizeImageCount(value: string): number {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1)));
}
