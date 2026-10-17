import type { Asset, VideoAsset } from "../stores/use-asset-store";

export function needsVideoCover(asset: Asset | undefined): asset is VideoAsset {
    return Boolean(asset?.kind === "video" && !(asset.coverUrl || "").trim() && !asset.metadata?.deletedAt && asset.data.url);
}

export function isSameVideoSource(current: Asset | undefined, original: VideoAsset): current is VideoAsset {
    if (current?.kind !== "video") return false;
    if (current.data.storageKey && original.data.storageKey) return current.data.storageKey === original.data.storageKey;
    return current.data.url === original.data.url;
}

/** Share concurrent requests and limit background video downloads/transcoding. */
export function createVideoCoverQueue(concurrency = 2) {
    const pending = new Map<string, Promise<void>>();
    const waiting: Array<() => void> = [];
    let active = 0;
    const drain = () => {
        while (active < concurrency && waiting.length) waiting.shift()!();
    };
    return (key: string, run: () => Promise<void>): Promise<void> => {
        const existing = pending.get(key);
        if (existing) return existing;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const job = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
        pending.set(key, job);
        waiting.push(() => {
            active++;
            const finish = () => {
                active--;
                pending.delete(key);
                drain();
            };
            void Promise.resolve().then(run).then(() => { finish(); resolve(); }, (error) => { finish(); reject(error); });
        });
        drain();
        return job;
    };
}
