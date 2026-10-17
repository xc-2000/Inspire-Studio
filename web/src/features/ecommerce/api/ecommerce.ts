import { serverGet, serverPost, type ServerAiTask } from "@/services/api/server";
import type { CommerceKind, CommercePlatform, CommerceVariant } from "../lib/catalog";
import type { CommerceImageGenerationMode } from "../lib/image-generation-mode";

export type CommerceProduct = { name: string; brand: string; category: string; price: string; audience: string; sellingPoints: string; constraints: string };
export type CommerceReference = { id: string; name: string; mimeType: string; storageKey: string; url: string };
export type CommerceData = { product: CommerceProduct; references: CommerceReference[]; imageGenerationMode?: CommerceImageGenerationMode; drafts?: Record<string, string>; skillSelections?: Record<string, string> };
export type CommerceProject = { id: string; platform: CommercePlatform; title: string; data: CommerceData; revision: number; createdAt: string; updatedAt: string };
export type CommerceJob = { id: string; taskId: string; kind: CommerceKind; variant: string; platform: CommercePlatform; createdAt: string; skillId?: string; skillName?: string; skillRevision?: number };
export type CommerceGenerateInput = {
    projectId: string;
    requestId: string;
    kind: CommerceKind;
    variant?: CommerceVariant;
    model: string;
    parameters: Record<string, unknown>;
    imageGenerationMode?: CommerceImageGenerationMode;
    skillId?: string;
    skillRevision?: number;
};
export const emptyCommerceData = (): CommerceData => ({ product: { name: "", brand: "", category: "", price: "", audience: "", sellingPoints: "", constraints: "" }, references: [], imageGenerationMode: "text-to-image", drafts: {} });
export const listCommerceProjects = (input: { platform: CommercePlatform; keyword: string; page: number; pageSize: number }) => serverPost<{ items: CommerceProject[]; total: number }>("/ecommerce/listProjects", input);
export const getCommerceProject = (id: string) => serverGet<CommerceProject>(`/ecommerce/getProject?id=${encodeURIComponent(id)}`);
export const saveCommerceProject = (input: { id: string; revision: number; platform: CommercePlatform; title: string; data: CommerceData }) => serverPost<CommerceProject>("/ecommerce/saveProject", input);
export const deleteCommerceProject = (id: string, revision: number) => serverPost<string>("/ecommerce/deleteProject", { id, revision });
export const listCommerceJobs = (projectId: string) => serverGet<{ jobs: CommerceJob[] }>(`/ecommerce/listJobs?projectId=${encodeURIComponent(projectId)}`);
export const generateCommerce = (input: CommerceGenerateInput) => serverPost<{ job: CommerceJob; task: ServerAiTask }>("/ecommerce/generate", input);
