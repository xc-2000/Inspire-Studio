import { serverGet, serverPost } from "@/services/api/server";
import type { CommercePlatform } from "../lib/catalog";

export type CommerceSkillType = "text" | "image" | "video";
export type CommerceSkill = {
    id: string;
    revision: number;
    name: string;
    description: string;
    type: CommerceSkillType;
    platforms: CommercePlatform[];
    outputTypes: string[];
    systemPrompt: string;
    status: 0 | 1;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
};
export type CommerceSkillInput = Omit<CommerceSkill, "id" | "revision" | "createdAt" | "updatedAt"> & { id?: string; revision?: number };

export function listCommerceSkills(input: { platform: CommercePlatform; outputType: string; keyword?: string }) {
    const query = new URLSearchParams(input);
    return serverGet<{ skills: CommerceSkill[] }>(`/ecommerce/skills?${query}`);
}
export const listAdminCommerceSkills = (input: { keyword?: string; type?: CommerceSkillType | "all"; status?: number; page: number; pageSize: number }) => serverPost<{ items: CommerceSkill[]; total: number }>("/admin/ecommerce-skills/list", input);
export const saveAdminCommerceSkill = (input: CommerceSkillInput) => serverPost<CommerceSkill>("/admin/ecommerce-skills/save", input);
export const updateAdminCommerceSkillStatus = (input: { id: string; revision: number; status: 0 | 1 }) => serverPost<CommerceSkill>("/admin/ecommerce-skills/status", input);
export const deleteAdminCommerceSkill = (input: { id: string; revision: number }) => serverPost<string>("/admin/ecommerce-skills/delete", input);
