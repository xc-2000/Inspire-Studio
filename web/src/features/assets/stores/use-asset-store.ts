"use client";

import { create } from "zustand";

import { nanoid } from "nanoid";
import { deleteAsset, generateVideoCover, listAssets, saveAsset } from "@/services/api/server";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/features/storage/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl, uploadMediaFile } from "@/features/storage/services/file-storage";
import type { ObjectStorageFile } from "@/shared/types/object-storage";
import { createVideoCoverQueue, isSameVideoSource, needsVideoCover } from "../lib/video-cover";
import { reconcileHydration } from "@/shared/lib/reconcile-hydration";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string; objectStorage?: ObjectStorageFile } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string; objectStorage?: ObjectStorageFile } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    coverStorageKey?: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    hydrateAssets: () => Promise<void>;
    ensureVideoCover: (id: string) => Promise<void>;
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const queueVideoCover = createVideoCoverQueue(2);
const assetSaves = new Map<string, Promise<boolean>>();
const coverRetryAfter = new Map<string, number>();
let hydrationPromise: Promise<void> | undefined;

export const useAssetStore = create<AssetStore>()((set, get) => ({
    hydrated: false,
    assets: [],
    hydrateAssets: () => {
        if (get().hydrated) return Promise.resolve();
        if (hydrationPromise) return hydrationPromise;
        const before = get().assets;
        hydrationPromise = listAssets<Asset>()
            .then(assets => Promise.all(assets.map(hydrateAsset)))
            .then(assets => set(state => ({ assets: reconcileHydration(assets, before, state.assets, asset => asset.id), hydrated: true })))
            .finally(() => { hydrationPromise = undefined; });
        return hydrationPromise;
    },
    ensureVideoCover: (id) => queueVideoCover(id, async () => {
        if ((coverRetryAfter.get(id) || 0) > Date.now()) return;
        // A card may mount while its initial save/upload is still pending.
        if (await assetSaves.get(id) === false) return;
        const original = get().assets.find((asset) => asset.id === id);
        if (!needsVideoCover(original)) return;
        try {
            const media = original.data.storageKey ? original.data : await uploadMediaFile(original.data.url, "video", { mimeType: original.data.mimeType });
            const cover = await generateVideoCover(media.storageKey!);
            const current = get().assets.find((asset) => asset.id === id);
            // Never restore a deleted asset or attach an old video's frame to a new source.
            if (!needsVideoCover(current) || !isSameVideoSource(current, original)) return;
            const enriched: VideoAsset = {
                ...current,
                coverUrl: cover.coverUrl,
                coverStorageKey: cover.coverStorageKey,
                data: {
                    ...current.data,
                    ...(!current.data.storageKey ? { url: media.url, storageKey: media.storageKey, objectStorage: media.objectStorage } : {}),
                    width: current.data.width || cover.width,
                    height: current.data.height || cover.height,
                },
            };
            set((state) => ({ assets: state.assets.map((asset) => asset === current ? enriched : asset) }));
            const saved = await persistAsset(enriched, (normalized) => set((state) => ({
                assets: state.assets.map((asset) => asset === enriched ? normalized : asset),
            })));
            if (!saved) {
                set((state) => ({ assets: state.assets.map((asset) => asset === enriched ? current : asset) }));
                coverRetryAfter.set(id, Date.now() + 60_000);
            }
        } catch (error) {
            coverRetryAfter.set(id, Date.now() + 60_000);
            console.warn("视频封面暂时无法生成，保留视频预览", error);
        }
    }),
    addAsset: (asset) => {
        const now = new Date().toISOString();
        const id = nanoid();
        const nextAsset = { ...asset, id, createdAt: now, updatedAt: now } as Asset;
        set((state) => ({ assets: [nextAsset, ...state.assets] }));
        void persistAsset(nextAsset, (savedAsset) => {
            set((state) => ({ assets: state.assets.map((item) => (item === nextAsset ? savedAsset : item)) }));
        }).then((saved) => { if (saved) void get().ensureVideoCover(id); });
        return id;
    },
    updateAsset: (id, patch) => {
        let nextAsset: Asset | null = null;
        set((state) => ({
            assets: state.assets.map((asset) => {
                if (asset.id !== id) return asset;
                nextAsset = { ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset;
                return nextAsset;
            }),
        }));
        if (nextAsset) {
            const candidate = nextAsset;
            void persistAsset(candidate, (savedAsset) => set((state) => ({ assets: state.assets.map((item) => (item === candidate ? savedAsset : item)) })))
                .then((saved) => { if (saved) void get().ensureVideoCover(id); });
        }
    },
    removeAsset: (id) => {
        set((state) => ({ assets: state.assets.filter((asset) => asset.id !== id) }));
        get().cleanupImages({ assets: get().assets });
        void Promise.resolve(assetSaves.get(id)).then(() => deleteAsset([id])).catch((error) => console.error("删除素材失败", error));
    },
    replaceAssets: (assets) => {
        set({ assets });
        void Promise.all(assets.map((asset) => persistAsset(asset)));
    },
    cleanupImages: (extra) => {
        window.setTimeout(async () => {
            const { useCanvasStore } = await import("@/features/canvas/stores/use-canvas-store");
            // A partial detail cache cannot prove that media is unused by unopened projects.
            if (!useCanvasStore.getState().hydrated) return;
            const documents = useCanvasStore.getState().documents;
            await cleanupUnusedImages({ assets: get().assets, projects: documents, extra });
            await cleanupUnusedMedia({ assets: get().assets, projects: documents, extra });
        }, 0);
    },
}));

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.coverStorageKey) asset = { ...asset, coverUrl: await resolveImageUrl(asset.coverStorageKey, asset.coverUrl) };
    if (asset.kind === "video" && asset.data.storageKey) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, data: { ...asset.data, url } };
    }
    if (asset.kind !== "image") return asset;
    if (!asset.data.storageKey) return asset;
    const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
    return {
        ...asset,
        coverUrl: asset.coverUrl.startsWith("blob:") || asset.coverUrl === "" ? dataUrl : asset.coverUrl,
        data: { ...asset.data, dataUrl },
    };
}

function persistAsset(asset: Asset, onSaved?: (asset: Asset) => void): Promise<boolean> {
    const previous = assetSaves.get(asset.id);
    const task = Promise.resolve(previous).then(async () => {
        try {
            const normalized = await normalizeAssetMedia(asset);
            await saveAsset(normalized);
            onSaved?.(normalized);
            return true;
        } catch (error) {
            console.error("保存素材失败", error);
            return false;
        }
    });
    assetSaves.set(asset.id, task);
    void task.finally(() => { if (assetSaves.get(asset.id) === task) assetSaves.delete(asset.id); });
    return task;
}

async function normalizeAssetMedia(asset: Asset): Promise<Asset> {
    if (asset.kind === "image") {
        let nextAsset = asset;
        if (nextAsset.data.dataUrl.startsWith("data:image/")) {
            const image = await uploadImage(nextAsset.data.dataUrl);
            nextAsset = { ...nextAsset, coverUrl: nextAsset.coverUrl === nextAsset.data.dataUrl ? image.url : nextAsset.coverUrl, data: { ...nextAsset.data, dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType, objectStorage: image.objectStorage } };
        }
        if (nextAsset.coverUrl.startsWith("data:image/")) {
            const cover = await uploadImage(nextAsset.coverUrl);
            nextAsset = { ...nextAsset, coverUrl: cover.url };
        }
        return nextAsset;
    }
    if (asset.kind === "video" && asset.data.url.startsWith("data:")) {
        const video = await uploadMediaFile(asset.data.url, "video");
        return { ...asset, data: { ...asset.data, url: video.url, storageKey: video.storageKey, width: video.width || asset.data.width, height: video.height || asset.data.height, bytes: video.bytes, mimeType: video.mimeType, objectStorage: video.objectStorage } };
    }
    return asset;
}
