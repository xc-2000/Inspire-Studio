import assert from "node:assert/strict";
import test from "node:test";
import { useAssetStore, type VideoAsset } from "./use-asset-store.ts";

test("video cover repair persists an existing asset and preserves concurrent edits", async () => {
    const saved: VideoAsset[] = [];
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://test.local" } } });
    let finishCover!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const asset: VideoAsset = { id: "cover-repair-test", kind: "video", title: "Before", tags: [], coverUrl: "", createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { url: "https://r2.example/video.mp4", storageKey: "video:repair-test", width: 0, height: 0, bytes: 647000, mimeType: "video/mp4" } };
    globalThis.fetch = async (input, options) => {
        if (String(input).endsWith("/media/video-cover")) {
            await new Promise<void>((resolve) => { finishCover = resolve; started(); });
            return Response.json({ code: 0, data: { coverUrl: "https://r2.example/cover.jpg", coverStorageKey: "image:cover-test", width: 720, height: 1280 } });
        }
        if (String(input).endsWith("/assets/saveAsset")) saved.push(JSON.parse(String(options?.body)).asset);
        return Response.json({ code: 0, data: "ok" });
    };
    try {
        useAssetStore.setState({ assets: [asset], hydrated: true });
        const repairing = useAssetStore.getState().ensureVideoCover(asset.id);
        await ready;
        useAssetStore.getState().updateAsset(asset.id, { title: "User edited title" });
        finishCover();
        await repairing;
        const result = useAssetStore.getState().assets[0];
        assert.equal(result.title, "User edited title");
        assert.equal(result.coverUrl, "https://r2.example/cover.jpg");
        assert.equal(result.coverStorageKey, "image:cover-test");
        assert.equal(result.kind === "video" && result.data.width, 720);
        assert.equal(saved.at(-1)?.title, "User edited title");
        assert.equal(saved.at(-1)?.coverUrl, "https://r2.example/cover.jpg");
        assert.equal(saved.at(-1)?.data.url, asset.data.url);
    } finally {
        globalThis.fetch = originalFetch;
        useAssetStore.setState({ assets: [], hydrated: false });
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});
