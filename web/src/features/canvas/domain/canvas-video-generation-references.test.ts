import assert from "node:assert/strict";
import test from "node:test";

import { createVideoNode } from "../constants";
import type { CanvasVideoGenerationSettings } from "../types";
import type { ReferenceAudio } from "@/features/generation/types/media";
import type { ObjectStorageFile } from "@/shared/types/object-storage";
import { canvasMediaReferenceSource, mergeUniqueReferences, restoreCanvasVideoGenerationReferences } from "./canvas-video-generation-references";

function generation(patch: Partial<CanvasVideoGenerationSettings> = {}): CanvasVideoGenerationSettings {
    return {
        ...createVideoNode({ id: "video-target", position: { x: 0, y: 0 } }).generation,
        videoReferences: undefined,
        videoReferenceObjectStorages: undefined,
        ...patch,
    };
}

function dependencies(patch: Partial<Parameters<typeof restoreCanvasVideoGenerationReferences>[1]> = {}) {
    return {
        resolveImageUrl: async (_key: string, fallback = "") => fallback,
        resolveMediaUrl: async (_key: string, fallback = "") => fallback,
        resolveAudioReferences: async (audios: ReferenceAudio[]) => audios,
        ...patch,
    };
}

function objectStorage(key: string, mimeType = "image/webp"): ObjectStorageFile {
    return {
        provider: "cloudflareR2",
        url: `https://public.fixture.invalid/${key}`,
        key,
        bucket: "fixture",
        region: "auto",
        bytes: 128,
        mimeType,
        uploadedAt: "2026-09-30T00:00:00.000Z",
    };
}

test("synchronous preview validation accepts browser media sources and rejects keys or invalid protocols", () => {
    const cases: Array<{ input: unknown; expected: string; kind?: "image" | "video" | "audio" }> = [
        { input: " /open-drama/media/3049669/objects/439203.webp ", expected: "/open-drama/media/3049669/objects/439203.webp" },
        { input: " HTTPS://public.fixture.invalid/image.webp ", expected: "HTTPS://public.fixture.invalid/image.webp" },
        { input: "http://fixture.invalid/image.png", expected: "http://fixture.invalid/image.png" },
        { input: "blob:https://fixture.invalid/image-1", expected: "blob:https://fixture.invalid/image-1" },
        { input: "data:image/png;base64,aW1hZ2U=", expected: "data:image/png;base64,aW1hZ2U=" },
        { input: "data:video/mp4;base64,dmlkZW8=", expected: "" },
        { input: "data:video/mp4;base64,dmlkZW8=", kind: "video", expected: "data:video/mp4;base64,dmlkZW8=" },
        { input: "data:video/mp4;base64,dmlkZW8=", kind: "audio", expected: "" },
        { input: "image:character", expected: "" },
        { input: "video:motion", kind: "video", expected: "" },
        { input: "javascript:alert(1)", expected: "" },
        { input: "ftp://fixture.invalid/image.png", expected: "" },
        { input: "https://", expected: "" },
        { input: "", expected: "" },
        { input: "   ", expected: "" },
        { input: null, expected: "" },
        { input: 42, expected: "" },
    ];
    for (const entry of cases) {
        assert.equal(canvasMediaReferenceSource(entry.input, entry.kind), entry.expected, `${String(entry.input)} (${entry.kind || "default image"})`);
    }
});

test("invalid saved references cannot borrow a valid object storage URL through a matching key", async () => {
    for (const reference of ["javascript:alert(1)", "ftp://fixture.invalid/image.webp", "image:"]) {
        const storage = { ...objectStorage("valid.webp"), key: reference.replace(/^image:/, "") };
        const restored = await restoreCanvasVideoGenerationReferences(generation({
            references: [reference], referenceObjectStorages: [storage],
        }), dependencies());
        assert.ok(restored);
        assert.equal(restored.incomplete, true, reference);
        assert.deepEqual(restored.referenceImages, [], reference);
        assert.deepEqual(restored.referenceVideos, [], reference);
    }
});

test("absent saved generation state returns null", async () => {
    assert.equal(await restoreCanvasVideoGenerationReferences(null, dependencies()), null);
    assert.equal(await restoreCanvasVideoGenerationReferences(generation(), dependencies()), null);
});

test("short drama relative image sources remain available for later object storage preparation", async () => {
    const references = [
        "/open-drama/media/3049669/objects/439203.webp",
        "/open-drama/media/3049669/objects/439204.webp?revision=2",
    ];
    const restored = await restoreCanvasVideoGenerationReferences(generation({ references }), dependencies({
        resolveImageUrl: async () => assert.fail("relative sources must not be treated as storage keys"),
        resolveMediaUrl: async () => assert.fail("relative sources must not be treated as storage keys"),
    }));
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(restored.referenceImages.map(image => image.dataUrl), references);
    assert.equal(restored.referenceVideos.length, 0);
});

test("inline images and browser blobs are retained instead of being reported as missing", async () => {
    const references = ["data:image/png;base64,aW1hZ2U=", "blob:https://fixture.invalid/image-1"];
    const restored = await restoreCanvasVideoGenerationReferences(generation({ references }), dependencies());
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(restored.referenceImages.map(image => image.dataUrl), references);
});

test("public HTTP and R2 HTTPS references restore without a media lookup", async () => {
    const references = ["http://fixture.invalid/image.png", "https://public.fixture.invalid/r2-image.webp"];
    const restored = await restoreCanvasVideoGenerationReferences(generation({ references }), dependencies({
        resolveImageUrl: async () => assert.fail("public sources must not require a media lookup"),
    }));
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(restored.referenceImages.map(image => ({ dataUrl: image.dataUrl, url: image.url })), references.map(url => ({ dataUrl: url, url })));
});

test("image and video storage keys resolve through the injected media dependencies", async () => {
    const imageCalls: string[] = [];
    const videoCalls: string[] = [];
    const restored = await restoreCanvasVideoGenerationReferences(generation({
        references: ["image:character"],
        videoReferences: ["video:motion"],
    }), dependencies({
        resolveImageUrl: async key => { imageCalls.push(key); return "https://fixture.invalid/character.webp"; },
        resolveMediaUrl: async key => { videoCalls.push(key); return "https://fixture.invalid/motion.mp4"; },
    }));
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(imageCalls, ["image:character"]);
    assert.deepEqual(videoCalls, ["video:motion"]);
    assert.equal(restored.referenceImages[0].storageKey, "image:character");
    assert.equal(restored.referenceImages[0].dataUrl, "https://fixture.invalid/character.webp");
    assert.equal(restored.referenceVideos[0].storageKey, "video:motion");
    assert.equal(restored.referenceVideos[0].url, "https://fixture.invalid/motion.mp4");
});

test("object storage metadata matches exact URLs and prefixed storage keys", async () => {
    const first = objectStorage("character.webp");
    const second = objectStorage("scene.webp");
    const video = objectStorage("motion.mp4", "video/mp4");
    const restored = await restoreCanvasVideoGenerationReferences(generation({
        references: [first.url, "image:scene.webp"],
        referenceObjectStorages: [first, second],
        videoReferences: ["video:motion.mp4"],
        videoReferenceObjectStorages: [video],
    }), dependencies({
        resolveImageUrl: async () => assert.fail("matched image object storage already provides a public URL"),
        resolveMediaUrl: async () => assert.fail("matched video object storage already provides a public URL"),
    }));
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(restored.referenceImages.map(image => image.dataUrl), [first.url, second.url]);
    assert.deepEqual(restored.referenceImages.map(image => image.objectStorage), [first, second]);
    assert.equal(restored.referenceImages[1].storageKey, "image:scene.webp");
    assert.equal(restored.referenceVideos[0].url, video.url);
    assert.equal(restored.referenceVideos[0].objectStorage, video);
    assert.equal(restored.referenceVideos[0].bytes, video.bytes);
});

test("legacy mixed reference fields retain image and video media kinds", async () => {
    const legacyVideo = objectStorage("legacy-opaque-key", "video/webm");
    const restored = await restoreCanvasVideoGenerationReferences(generation({
        references: ["https://fixture.invalid/legacy.mp4?revision=1", "/open-drama/media/character.webp", legacyVideo.url],
        referenceObjectStorages: [legacyVideo],
        videoReferences: ["https://fixture.invalid/second.webm"],
    }), dependencies());
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(restored.referenceImages.map(image => image.dataUrl), ["/open-drama/media/character.webp"]);
    assert.deepEqual(restored.referenceVideos.map(video => video.url), ["https://fixture.invalid/legacy.mp4?revision=1", legacyVideo.url, "https://fixture.invalid/second.webm"]);
    assert.equal(restored.referenceVideos[1].type, "video/webm");
});

test("relative and blob videos restore from both dedicated and legacy reference fields", async () => {
    const legacyVideo = "/open-drama/media/fixture/legacy.mp4";
    const videoReferences = ["/open-drama/media/fixture/clip.mp4", "blob:https://fixture.invalid/clip"];
    const restored = await restoreCanvasVideoGenerationReferences(generation({
        references: [legacyVideo], videoReferences,
    }), dependencies({
        resolveImageUrl: async () => assert.fail("relative videos must not be treated as image storage keys"),
        resolveMediaUrl: async () => assert.fail("relative and blob videos must not be treated as storage keys"),
    }));
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(restored.referenceImages, []);
    assert.deepEqual(restored.referenceVideos.map(video => video.url), [legacyVideo, ...videoReferences]);
});

test("empty or invalid sources remain incomplete while valid saved images survive", async () => {
    for (const invalid of ["", "   ", "javascript:alert(1)", "ftp://fixture.invalid/image.png", "https://", "data:text/html,invalid"]) {
        const restored = await restoreCanvasVideoGenerationReferences(generation({
            references: ["/open-drama/media/valid.webp", invalid],
        }), dependencies());
        assert.ok(restored, invalid);
        assert.equal(restored.incomplete, true, invalid);
        assert.deepEqual(restored.referenceImages.map(image => image.dataUrl), ["/open-drama/media/valid.webp"], invalid);
    }
});

test("unresolved image and video storage keys cannot silently become a reference-free request", async () => {
    const restored = await restoreCanvasVideoGenerationReferences(generation({
        references: ["image:missing"],
        videoReferences: ["video:missing"],
    }), dependencies());
    assert.ok(restored);
    assert.equal(restored.incomplete, true);
    assert.deepEqual(restored.referenceImages, []);
    assert.deepEqual(restored.referenceVideos, []);
});

test("audio restoration preserves trim metadata and marks unresolved audio incomplete", async () => {
    const audio: ReferenceAudio = {
        id: "dialogue", name: "对白", type: "audio/mpeg", url: "https://fixture.invalid/old.mp3", storageKey: "audio:dialogue",
        trimStartMs: 500, trimEndMs: 2500, durationMs: 2000,
    };
    const restoredAudio = { ...audio, url: "https://fixture.invalid/restored.mp3" };
    let input: ReferenceAudio[] | undefined;
    const restored = await restoreCanvasVideoGenerationReferences(generation({ audioReferences: [audio] }), dependencies({
        resolveAudioReferences: async audios => { input = audios; return [restoredAudio]; },
    }));
    assert.ok(restored);
    assert.equal(restored.incomplete, false);
    assert.deepEqual(input, [audio]);
    assert.deepEqual(restored.referenceAudios, [restoredAudio]);

    const incomplete = await restoreCanvasVideoGenerationReferences(generation({ audioReferences: [audio] }), dependencies({
        resolveAudioReferences: async () => [{ ...audio, url: "" }],
    }));
    assert.ok(incomplete);
    assert.equal(incomplete.incomplete, true);
});

test("merge retains primary order and removes repeated saved references within the extra list", () => {
    const primary = [{ id: "upstream-1", dataUrl: "/first.webp" }, { id: "upstream-2", dataUrl: "/second.webp" }];
    const extra = [{ id: "saved-first", dataUrl: "/first.webp" }, { id: "saved-third", dataUrl: "/third.webp" }, { id: "saved-third-duplicate", dataUrl: "/third.webp" }];
    const merged = mergeUniqueReferences(primary, extra);
    assert.deepEqual(merged.map(reference => reference.id), ["upstream-1", "upstream-2", "saved-third"]);
    assert.equal(merged[0], primary[0]);
    assert.equal(merged[2], extra[1]);
    assert.notEqual(merged, primary);
    assert.equal(primary.length, 2);
    assert.equal(extra.length, 3);
});

test("merge uses stable object storage URLs, remote URLs and storage keys as identities", () => {
    type ReferenceFixture = { id: string; objectStorage?: ObjectStorageFile; storageKey?: string; url?: string };
    const file = objectStorage("character.webp");
    const primary: ReferenceFixture[] = [{ id: "object-storage", objectStorage: file }, { id: "stored", storageKey: "image:scene" }];
    const extra: ReferenceFixture[] = [
        { id: "same-public-url", url: file.url },
        { id: "same-storage-key", storageKey: "image:scene" },
        { id: "video-new", url: "https://fixture.invalid/new.mp4" },
        { id: "video-new-duplicate", url: "https://fixture.invalid/new.mp4" },
    ];
    assert.deepEqual(mergeUniqueReferences(primary, extra).map(reference => reference.id), ["object-storage", "stored", "video-new"]);
});
