import type { CommercePlatform } from "./catalog";

/** Reopen an existing platform project before offering an empty draft. */
export async function restorePlatformProject<T extends { platform: CommercePlatform }>(
    platform: CommercePlatform,
    rememberedId: string | undefined,
    source: {
        get: (id: string) => Promise<T>;
        latest: (platform: CommercePlatform) => Promise<T | undefined>;
        create: (platform: CommercePlatform) => T;
        isMissing: (error: unknown) => boolean;
    },
): Promise<T> {
    if (rememberedId) {
        try {
            const project = await source.get(rememberedId);
            if (project.platform === platform) return project;
        } catch (error) {
            // Only a deleted project permits fallback. Network errors must keep the current editor intact.
            if (!source.isMissing(error)) throw error;
        }
    }
    const latest = await source.latest(platform);
    return latest?.platform === platform ? latest : source.create(platform);
}
