import localforage from "localforage";

export type ImageLastUsedSettings = {
    quality: string;
    imageResolution: string;
    size: string;
    count: string;
};

export type VideoLastUsedSettings = {
    videoModel?: string;
    videoGenerationMode: "text-to-video" | "image-to-video" | "reference-to-video";
    vquality: string;
    size: string;
    videoSeconds: string;
    videoWatermark: string;
    videoGenerateAudio: string;
};

export const DEFAULT_IMAGE_LAST_USED_SETTINGS: ImageLastUsedSettings = {
    quality: "medium",
    imageResolution: "2K",
    size: "1:1",
    count: "1",
};

export const DEFAULT_VIDEO_LAST_USED_SETTINGS: VideoLastUsedSettings = {
    videoGenerationMode: "text-to-video",
    vquality: "",
    size: "16:9",
    videoSeconds: "5",
    videoWatermark: "false",
    videoGenerateAudio: "true",
};

const settingsStorage = localforage.createInstance({
    name: "inspire-studio",
    storeName: "last_used_generation_settings",
});

let imageSettingsWriteQueue = Promise.resolve();
let videoSettingsWriteQueue = Promise.resolve();

export async function loadImageLastUsedSettings(): Promise<ImageLastUsedSettings> {
    const saved = await settingsStorage.getItem<Partial<ImageLastUsedSettings>>("image");
    return { ...DEFAULT_IMAGE_LAST_USED_SETTINGS, ...saved };
}

export function saveImageLastUsedSettings(settings: Partial<ImageLastUsedSettings>): Promise<void> {
    imageSettingsWriteQueue = imageSettingsWriteQueue.catch(() => undefined).then(async () => {
        const current = await loadImageLastUsedSettings();
        await settingsStorage.setItem("image", { ...current, ...settings });
    });
    return imageSettingsWriteQueue;
}

export async function loadVideoLastUsedSettings(): Promise<VideoLastUsedSettings> {
    const saved = await settingsStorage.getItem<Partial<VideoLastUsedSettings>>("video");
    return { ...DEFAULT_VIDEO_LAST_USED_SETTINGS, ...saved };
}

export function saveVideoLastUsedSettings(settings: Partial<VideoLastUsedSettings>): Promise<void> {
    videoSettingsWriteQueue = videoSettingsWriteQueue.catch(() => undefined).then(async () => {
        const current = await loadVideoLastUsedSettings();
        await settingsStorage.setItem("video", { ...current, ...settings });
    });
    return videoSettingsWriteQueue;
}
