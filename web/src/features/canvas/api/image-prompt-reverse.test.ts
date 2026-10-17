import assert from "node:assert/strict";
import test from "node:test";
import { listImagePromptReverseModels } from "@/services/api/server";
import { parseImagePromptReverseResult, reverseImagePrompt } from "./image-prompt-reverse";

const image = { storageKey: "images/reference.png", mimeType: "image/png", name: "参考图" };
const prompt = { promptZh: "柔和晨光中的玻璃花瓶，静物摄影。", promptEn: "A glass vase in soft morning light, still life photography.", negativePrompt: "blur, watermark", style: "静物摄影" };
const created = { id: "image-reverse-test", status: "pending" };
const completed = { ...created, status: "success", resultData: { content: JSON.stringify(prompt) } };
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data, msg: "" }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("reads bilingual prompts and negative prompt from JSON fences, trimming only field boundaries", () => {
    assert.deepEqual(parseImagePromptReverseResult({ content: ` \n\x60\x60\x60json\n${JSON.stringify({ ...prompt, promptZh: `  ${prompt.promptZh}\n` })}\n\x60\x60\x60\n` }), prompt);
    assert.deepEqual(parseImagePromptReverseResult({ content: `\x60\x60\x60\n${JSON.stringify(prompt)}\n\x60\x60\x60` }), prompt);
});

test("allows one valid language and ignores non-text optional fields", () => {
    assert.deepEqual(parseImagePromptReverseResult({ promptEn: "  studio photograph  ", promptZh: null, negativePrompt: ["blur"], style: { label: "photo" } }), {
        promptZh: "", promptEn: "studio photograph", negativePrompt: "",
    });
    assert.deepEqual(parseImagePromptReverseResult({ content: prompt }), prompt);
    assert.deepEqual(parseImagePromptReverseResult({ reverseImage: prompt }), prompt);
});

test("rejects empty, malformed, conversational and negative-only results", () => {
    for (const invalid of [null, {}, [], "", "I cannot see an image.", "```json\n{ broken }\n```", { content: "{}" }, { promptZh: "  ", promptEn: "\n", negativePrompt: "blur" }, { promptZh: 123 }, { error: "vision is unsupported" }]) {
        assert.throws(() => parseImagePromptReverseResult(invalid), /没有返回有效的图片提示词/);
    }
});

test("uses the selected model and a real image reference for one bilingual task", async (context) => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    context.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return response(String(url).includes("reverseImage") ? created : completed);
    });
    assert.deepEqual(await reverseImagePrompt({ image, model: "channel::vision", language: "bilingual" }), prompt);
    assert.deepEqual(requests[0].body, { image, model: "channel::vision", language: "bilingual" });
    assert.equal(requests[0].url.endsWith("/ai/prompt/reverseImage"), true);
    assert.equal(requests.length, 2);
});

test("loads eligible image-reading models from the dedicated endpoint", async (context) => {
    let requestUrl = "";
    const models = { models: [{ value: "vision", label: "Vision" }], textModels: ["vision"], imageModels: [], videoModels: [] };
    context.mock.method(globalThis, "fetch", async (url: unknown) => { requestUrl = String(url); return response(models); });
    assert.deepEqual(await listImagePromptReverseModels(), models);
    assert.equal(requestUrl.endsWith("/ai/prompt/reverseImageModels"), true);
});

test("a model failure rejects without retrying with the image removed or showing any result", async (context) => {
    const requests: string[] = [];
    context.mock.method(globalThis, "fetch", async (url: unknown) => {
        requests.push(String(url));
        return response(String(url).includes("reverseImage") ? created : { ...completed, status: "failed", errorMessage: "当前模型不支持图片理解" });
    });
    await assert.rejects(reverseImagePrompt({ image, model: "unsupported" }), /不支持图片理解/);
    assert.equal(requests.filter((url) => url.includes("reverseImage")).length, 1);
});

test("a successful task with an empty result still rejects instead of inventing prompt text", async (context) => {
    context.mock.method(globalThis, "fetch", async (url: unknown) => response(String(url).includes("reverseImage") ? created : { ...completed, resultData: { content: "{}" } }));
    await assert.rejects(reverseImagePrompt({ image }), /没有返回有效的图片提示词/);
});

test("a task canceled elsewhere cannot publish a result", async (context) => {
    context.mock.method(globalThis, "fetch", async (url: unknown) => response(String(url).includes("reverseImage") ? created : { ...completed, status: "canceled" }));
    await assert.rejects(reverseImagePrompt({ image }), /取消/);
});

test("already canceled requests and missing stored images do not create a task", async (context) => {
    const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("should not fetch"); });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(reverseImagePrompt({ image }, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(reverseImagePrompt({ image: { url: "blob:local-preview" } }), /准备可读取的图片/);
    assert.equal(fetch.mock.callCount(), 0);
});

test("cancellation during creation cancels the eventual task exactly once and never polls it", async (context) => {
    const creation = deferred<Response>();
    const requests: string[] = [];
    context.mock.method(globalThis, "fetch", async (url: unknown) => {
        requests.push(String(url));
        return String(url).includes("reverseImage") ? creation.promise : response(created);
    });
    const controller = new AbortController();
    const pending = reverseImagePrompt({ image }, { signal: controller.signal });
    controller.abort();
    creation.resolve(response(created));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requests.filter((url) => url.includes("cancelTask")).length, 1);
    assert.equal(requests.some((url) => url.includes("getTaskInfo")), false);
});

test("cancellation during status retrieval ends the local wait and ignores a late success", async (context) => {
    const status = deferred<Response>();
    const polling = deferred<void>();
    let cancelCount = 0;
    context.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("reverseImage")) return response(created);
        if (String(url).includes("cancelTask")) { cancelCount += 1; return response(created); }
        polling.resolve();
        return status.promise;
    });
    const controller = new AbortController();
    const pending = reverseImagePrompt({ image }, { signal: controller.signal });
    await polling.promise;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(cancelCount, 1);
    status.resolve(response(completed));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelCount, 1);
});

test("cancellation after completion does not cancel a completed task", async (context) => {
    let cancelCount = 0;
    context.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("cancelTask")) cancelCount += 1;
        return response(String(url).includes("reverseImage") ? created : completed);
    });
    const controller = new AbortController();
    assert.deepEqual(await reverseImagePrompt({ image }, { signal: controller.signal }), prompt);
    controller.abort();
    assert.equal(cancelCount, 0);
});
