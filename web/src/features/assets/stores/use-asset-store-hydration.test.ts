import assert from "node:assert/strict";
import test from "node:test";
import { useAssetStore, type TextAsset } from "./use-asset-store";

test("concurrent workspace initialization fetches assets once, retains a newly generated asset, and permits retry after failure", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://test.local" } } });
    let count = 0;
    let finish!: (response: Response) => void;
    globalThis.fetch = async () => {
        count++;
        return new Promise<Response>(resolve => { finish = resolve; });
    };
    const asset = (id: string): TextAsset => ({ id, kind: "text", title: id, coverUrl: "", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { content: id } });
    try {
        useAssetStore.setState({ assets: [], hydrated: false });
        const first = useAssetStore.getState().hydrateAssets();
        const second = useAssetStore.getState().hydrateAssets();
        assert.equal(first, second);
        assert.equal(count, 1);
        useAssetStore.setState({ assets: [asset("generated")] });
        finish(Response.json({ code: 0, data: { assets: [asset("saved")] } }));
        await first;
        assert.deepEqual(useAssetStore.getState().assets.map(item => item.id), ["generated", "saved"]);
        await useAssetStore.getState().hydrateAssets();
        assert.equal(count, 1);

        useAssetStore.setState({ assets: [], hydrated: false });
        const failing = useAssetStore.getState().hydrateAssets();
        finish(Response.json({ code: 500, message: "temporarily unavailable" }));
        await assert.rejects(failing);
        assert.equal(useAssetStore.getState().hydrated, false);
        const retry = useAssetStore.getState().hydrateAssets();
        finish(Response.json({ code: 0, data: { assets: [asset("recovered")] } }));
        await retry;
        assert.equal(count, 3);
        assert.equal(useAssetStore.getState().assets[0].id, "recovered");
    } finally {
        globalThis.fetch = originalFetch;
        useAssetStore.setState({ assets: [], hydrated: false });
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});
