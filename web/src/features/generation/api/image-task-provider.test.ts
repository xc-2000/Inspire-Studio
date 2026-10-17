import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readStoryboardShotReferenceImages } from "@/features/canvas/domain/storyboard";
import type { CanvasStoryboardShot } from "@/features/canvas/types";
import { defaultConfig } from "@/features/settings/stores/use-config-store";
import type { ReferenceImage } from "@/features/generation/types/image";
import type { ServerAiTask, ServerAiTaskCreateInput } from "@/services/api/server";
import { createServerImageTaskProvider } from "./image-task-provider";

const config = { ...defaultConfig, model: "fixture-image-model", count: "1" };
const image = (id: string, dataUrl: string, extra: Partial<ReferenceImage> = {}): ReferenceImage => ({ id, name: "素材" + id, type: "image/png", dataUrl, ...extra });
const task: ServerAiTask = { id: "fixture-task", taskType: "image", model: "fixture-image-model", provider: "fixture", status: "pending", progress: 0, requestData: {}, createdAt: "2026-09-30", updatedAt: "2026-09-30" };
type Dependencies = Parameters<typeof createServerImageTaskProvider>[0];
function fixture(overrides: Partial<Dependencies> = {}) {
    const requests: ServerAiTaskCreateInput[] = [];
    const fetched: string[] = [];
    const uploads: Blob[] = [];
    const provider = createServerImageTaskProvider({
        fetch: async (source) => { fetched.push(source); return new Response(new Blob(["bytes:" + source], { type: source.includes("webp") ? "image/webp" : "image/png" })); },
        uploadImage: async (blob) => { uploads.push(blob); return { storageKey: "image:uploaded-" + uploads.length, url: "https://media.fixture.test/" + uploads.length, mimeType: blob.type }; },
        createTask: async (request) => { requests.push(request); return task; },
        ...overrides,
    });
    return { provider, requests, fetched, uploads };
}

test("the real open-drama 3049669 scene reference is uploaded with its WebP MIME before submission", async () => {
    const project = JSON.parse(await readFile(new URL("../../../../public/open-drama/projects/3049669.json", import.meta.url), "utf8")) as { objects: Array<{ id: number; name: string; imageUrl: string }> };
    const scene = project.objects.find((object) => object.id === 439203)!;
    assert.equal(scene.imageUrl, "/open-drama/media/3049669/objects/439203.webp");
    const shot = { id: "fixture-shot", shotNumber: 1, assetIds: [String(scene.id)] } as CanvasStoryboardShot;
    const references = readStoryboardShotReferenceImages(shot, [{ id: String(scene.id), kind: "scene", name: scene.name, description: "", image: { source: scene.imageUrl } }]);
    assert.equal(references[0].type, "image/png", "the imported reference defaults to PNG");
    const media = await readFile(new URL("../../../../public" + scene.imageUrl, import.meta.url));
    const run = fixture({ fetch: async (source) => { assert.equal(source, scene.imageUrl); return new Response(new Blob([new Uint8Array(media)], { type: "image/webp" })); } });
    assert.equal((await run.provider(config, "翻车场景镜头", references, undefined, "canvas")).id, task.id);
    assert.equal(run.uploads.length, 1);
    assert.deepEqual(run.requests[0].references, [{ id: "439203", name: "场景-翻车场景", mimeType: "image/webp", storageKey: "image:uploaded-1", url: "https://media.fixture.test/1" }]);
    assert.match(run.requests[0].prompt, /参考图片编号：图片1/);
    assert.equal(references[0].dataUrl, scene.imageUrl, "submission preserves imported user data");
});

test("inline, blob and relative references retain IDs, names and order after media preparation", async () => {
    const references = [image("data", "data:image/png;base64,aGVsbG8="), image("blob", "blob:https://fixture.test/local"), image("relative", "./assets/role.webp")];
    const before = structuredClone(references);
    const run = fixture();
    await run.provider(config, "图片2在图片3的场景", references, undefined, "canvas");
    assert.deepEqual(run.fetched, references.map((reference) => reference.dataUrl));
    assert.deepEqual(run.requests[0].references?.map((reference) => [reference.id, reference.name, reference.storageKey, reference.mimeType]), [
        ["data", "素材data", "image:uploaded-1", "image/png"], ["blob", "素材blob", "image:uploaded-2", "image/png"], ["relative", "素材relative", "image:uploaded-3", "image/webp"],
    ]);
    assert.match(run.requests[0].prompt, /图片1、图片2、图片3/);
    assert.deepEqual(references, before);
});

test("stored and HTTP references stay stable without fetching or uploading", async () => {
    const references = [
        image("stored", "", { storageKey: "image:already-stored" }),
        image("object", "blob:old", { objectStorage: { url: "https://object.fixture.test/a.webp", key: "a.webp" } }),
        image("url", "/old.webp", { url: "https://cdn.fixture.test/a.webp" }),
        image("dataUrl", "https://cdn.fixture.test/b.webp"),
        image("fallback", "https://cdn.fixture.test/c.webp", { url: "/relative-old.webp" }),
    ];
    const run = fixture();
    await run.provider(config, "使用已有参考", references, undefined, "canvas");
    assert.deepEqual(run.fetched, []);
    assert.deepEqual(run.uploads, []);
    assert.deepEqual(run.requests[0].references?.map((reference) => reference.storageKey || reference.url), [
        "image:already-stored", "https://object.fixture.test/a.webp", "https://cdn.fixture.test/a.webp", "https://cdn.fixture.test/b.webp", "https://cdn.fixture.test/c.webp",
    ]);
});

test("invalid later reference addresses fail before any media upload or task creation", async () => {
    for (const dataUrl of ["", "https://", "javascript:alert(1)", "file:///image.png", "data:text/html,hello"]) {
        const run = fixture();
        await assert.rejects(run.provider(config, "不要丢失素材", [image("valid-first", "/valid.webp"), image("invalid", dataUrl)], undefined, "canvas"), /参考图片2缺少可用图片地址或存储键/);
        assert.equal(run.fetched.length, 0);
        assert.equal(run.uploads.length, 0);
        assert.equal(run.requests.length, 0);
    }
});

test("404, empty bodies and non-image responses never create a generation task", async () => {
    for (const response of [new Response("missing", { status: 404 }), new Response(new Blob([], { type: "image/png" })), new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } })]) {
        const run = fixture({ fetch: async () => response });
        await assert.rejects(run.provider(config, "保留参考", [image("scene", "/open-drama/missing.webp")], undefined, "canvas"), /参考图片1准备失败.*未提交生成任务/);
        assert.equal(run.uploads.length, 0);
        assert.equal(run.requests.length, 0);
    }
});

test("a later upload failure prevents submission of a shortened reference list", async () => {
    let uploadCount = 0;
    const run = fixture({ uploadImage: async () => { if (++uploadCount === 2) throw new Error("媒体上传失败"); return { storageKey: "image:first", url: "https://media.fixture.test/first.png", mimeType: "image/png" }; } });
    await assert.rejects(run.provider(config, "两张图都必须保留", [image("first", "/first.png"), image("second", "/second.png")], undefined, "canvas"), /参考图片2准备失败：媒体上传失败/);
    assert.equal(uploadCount, 2);
    assert.equal(run.requests.length, 0);
});

test("invalid upload addresses cannot produce an addressless task reference", async () => {
    for (const uploaded of [
        { storageKey: "", url: "https://media.fixture.test/a.png", mimeType: "image/png" },
        { storageKey: "image:result", url: "/still-local.png", mimeType: "image/png" },
    ]) {
        const run = fixture({ uploadImage: async () => uploaded });
        await assert.rejects(run.provider(config, "保留素材", [image("local", "/image.png")], undefined, "canvas"), /参考图片1准备失败/);
        assert.equal(run.requests.length, 0);
    }
});

test("PNG masks use the same preparation path and accompany exactly one prepared original", async () => {
    const run = fixture();
    await run.provider(config, "局部重绘", [image("source", "/source.webp")], image("mask", "data:image/png;base64,aGVsbG8="), "canvas");
    assert.equal(run.uploads.length, 2);
    assert.deepEqual(run.requests[0].references, [{ id: "source", name: "素材source", mimeType: "image/webp", storageKey: "image:uploaded-1", url: "https://media.fixture.test/1" }]);
    assert.deepEqual(run.requests[0].parameters?.editMask, { id: "mask", name: "素材mask", mimeType: "image/png", storageKey: "image:uploaded-2", url: "https://media.fixture.test/2" });
    const stored = fixture();
    await stored.provider(config, "蒙版重绘", [image("source", "", { storageKey: "image:source" })], image("mask", "", { storageKey: "image:mask" }), "canvas");
    assert.equal(stored.uploads.length, 0);
    assert.equal((stored.requests[0].parameters?.editMask as { storageKey: string }).storageKey, "image:mask");
});

test("missing, non-PNG or unreadable masks fail before task creation", async () => {
    for (const mask of [image("mask", ""), image("mask", "/mask.webp", { type: "image/webp" })]) {
        const run = fixture();
        await assert.rejects(run.provider(config, "重绘", [image("source", "/source.png")], mask, "canvas"), /编辑蒙版/);
        assert.equal(run.uploads.length, 0);
        assert.equal(run.requests.length, 0);
    }
    const run = fixture({ fetch: async () => new Response("missing", { status: 404 }) });
    await assert.rejects(run.provider(config, "重绘", [image("source", "", { storageKey: "image:source" })], image("mask", "/missing-mask.png"), "canvas"), /编辑蒙版准备失败/);
    assert.equal(run.requests.length, 0);
    for (const references of [[], [image("one", "/one.png"), image("two", "/two.png")]]) {
        const invalid = fixture();
        await assert.rejects(invalid.provider(config, "重绘", references, image("mask", "/mask.png"), "canvas"), /且仅支持一张参考图片/);
        assert.equal(invalid.requests.length, 0);
        assert.equal(invalid.uploads.length, 0);
    }
});

test("pre-abort and cancellation during reading prevent upload and task creation", async () => {
    const before = new AbortController();
    before.abort();
    const early = fixture();
    await assert.rejects(early.provider(config, "取消", [image("source", "/source.png")], undefined, "canvas", { signal: before.signal }), { name: "AbortError" });
    assert.equal(early.fetched.length, 0);
    assert.equal(early.requests.length, 0);
    const controller = new AbortController();
    const run = fixture({ fetch: async (_source, init) => { assert.equal(init?.signal, controller.signal); controller.abort(); return new Response(new Blob(["png"], { type: "image/png" })); } });
    await assert.rejects(run.provider(config, "取消", [image("source", "/source.png")], undefined, "canvas", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(run.uploads.length, 0);
    assert.equal(run.requests.length, 0);
});

test("cancellation after an upload stops subsequent uploads and paid task creation", async () => {
    const controller = new AbortController();
    let uploads = 0;
    const run = fixture({ uploadImage: async () => { uploads++; controller.abort(); return { storageKey: "image:uploaded", url: "https://media.fixture.test/a.png", mimeType: "image/png" }; } });
    await assert.rejects(run.provider(config, "取消", [image("first", "/first.png"), image("second", "/second.png")], undefined, "canvas", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(uploads, 1);
    assert.equal(run.fetched.length, 1);
    assert.equal(run.requests.length, 0);
});

test("text-to-image with no references still submits without media preparation", async () => {
    const run = fixture();
    await run.provider(config, "普通文生图", [], undefined, "canvas", { generationStyleIds: [2] });
    assert.deepEqual(run.uploads, []);
    assert.deepEqual(run.requests[0].references, []);
    assert.equal(run.requests[0].prompt, "普通文生图");
    assert.deepEqual(run.requests[0].generationStyleIds, [2]);
});
