"use client";

import { serverGet, serverPost } from "@/services/api/server";

export type GatewayChannel = {
    id: number; name: string; type: number; baseUrl: string; models: string[];
    status: number; priority: number; weight: number; modelMapping: string; tag?: string; pluginKey?: string;
};
export type ChannelDraft = Omit<GatewayChannel, "id" | "status" | "tag"> & { id?: number; apiKey?: string };
export type GatewayModel = { id: string; connectedTypes: string[] };
export type ModelRoute = { model: string; modelTypes: string[]; channels: { channelId: number; channelName: string; channelStatus: number; active: boolean }[] };
export type ImportableChannel = {
    id: string; name: string; apiFormat: string; modelCount: number; supported: boolean; migrated: boolean; reason: string;
};
export type SyncModels = {
    models: string[]; modelType: "text" | "image" | "video" | "audio"; capabilities: string[];
    creditCost: number; resolutions?: string[]; setDefault: boolean;
};
const base = "/admin/newapi";
export const gatewayApi = {
    plugins: () => serverGet<{ key: string; name: string; models: string[] }[]>(base + "/plugins"),
    status: () => serverGet<{ connected: boolean; message: string }>(base + "/status"),
    channels: (page: number, pageSize: number, keyword: string) =>
        serverGet<{ items: GatewayChannel[]; total: number }>(base + "/channels?" + new URLSearchParams({ page: String(page), pageSize: String(pageSize), keyword })),
    save: (input: ChannelDraft) => serverPost(base + "/channels/save", input),
    fetchModels: (input: Partial<ChannelDraft>) => serverPost<string[]>(base + "/channels/models", input),
    enable: (id: number, enabled: boolean) => serverPost(base + "/channels/status", { id, enabled }),
    remove: (id: number) => serverPost(base + "/channels/delete", { id }),
    models: () => serverGet<GatewayModel[]>(base + "/models"),
    routes: () => serverGet<ModelRoute[]>(base + "/model-routes"),
    selectRoute: (model: string, channelId: number) => serverPost(base + "/model-routes/select", { model, channelId }),
    sync: (input: SyncModels) => serverPost<{ added: number; retained: number }>(base + "/models/sync", input),
    importable: () => serverGet<ImportableChannel[]>(base + "/importable"),
    migrate: (channelId: string) => serverPost(base + "/import", { channelId }),
    restore: (channelId: string) => serverPost(base + "/restore", { channelId }),
};

export const CHANNEL_TYPES = [
    { value: 1, label: "OpenAI 兼容" }, { value: 14, label: "Anthropic" },
    { value: 24, label: "Google Gemini" }, { value: 25, label: "Moonshot / Kimi" },
    { value: 35, label: "MiniMax 官方" }, { value: 40, label: "硅基流动" },
    { value: 43, label: "DeepSeek" }, { value: 45, label: "火山引擎" },
    { value: 50, label: "可灵" }, { value: 51, label: "即梦" },
    { value: 52, label: "Vidu" }, { value: 54, label: "豆包视频" },
    { value: 55, label: "Sora" }, { value: 60, label: "New API 网关" }, { value: 61, label: "视频协议插件" },
];
