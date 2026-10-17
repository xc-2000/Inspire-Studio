import assert from "node:assert/strict";
import test from "node:test";
import { optimizeGenerationPrompt, rewriteFailedGenerationPrompt } from "./prompt-optimization";

const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data, msg: "" }));
const createdTask = { id: "rewrite-test", status: "pending" };
const completedTask = { ...createdTask, status: "success", resultData: { content: "两只小狗并排趴在柔软地毯上休息，尾巴轻轻摇动，明亮的日常生活场景。" } };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("failed-generation rewrite sends bounded untrusted failure context without style injection", async (context) => {
    let request: Record<string, unknown> = {};
    context.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("optimizePrompt")) {
            request = JSON.parse(String(init?.body));
            return response(createdTask);
        }
        return response(completedTask);
    });
    assert.equal(await rewriteFailedGenerationPrompt("image", "两只小狗在休息", "rejected".repeat(500)), completedTask.resultData.content);
    assert.equal(request.rewriteForRetry, true);
    assert.equal(request.generationType, "image");
    assert.equal(request.prompt, "两只小狗在休息");
    assert.equal(String(request.failureReason).length, 2000);
    assert.equal("generationStyleIds" in request, false);
});

test("ordinary optimization retains selected style IDs and does not enable retry rewriting", async (context) => {
    let request: Record<string, unknown> = {};
    context.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("optimizePrompt")) {
            request = JSON.parse(String(init?.body));
            return response(createdTask);
        }
        return response(completedTask);
    });
    await optimizeGenerationPrompt("video", "两只小狗在休息", [2, 3]);
    assert.deepEqual(request.generationStyleIds, [2, 3]);
    assert.equal("rewriteForRetry" in request, false);
});

test("rewrite rejects conversational results instead of resubmitting the failed original", async (context) => {
    context.mock.method(globalThis, "fetch", async (url: unknown) => response(String(url).includes("optimizePrompt")
        ? createdTask
        : { ...completedTask, resultData: { content: "I cannot complete that. Would you like another version?" } }));
    await assert.rejects(rewriteFailedGenerationPrompt("image", "original prompt", "rejected"), /没有返回有效/);
});

test("an already canceled rewrite never creates a billable text task", async (context) => {
    const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("should not fetch"); });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(rewriteFailedGenerationPrompt("image", "prompt", "rejected", controller.signal), { name: "AbortError" });
    assert.equal(fetch.mock.callCount(), 0);
});

test("canceling while task creation is pending cancels the returned task without polling", async (context) => {
    const creation = deferred<Response>();
    const requests: string[] = [];
    context.mock.method(globalThis, "fetch", async (url: unknown) => {
        requests.push(String(url));
        if (String(url).includes("optimizePrompt")) return creation.promise;
        return response(createdTask);
    });
    const controller = new AbortController();
    const rewrite = rewriteFailedGenerationPrompt("image", "prompt", "rejected", controller.signal);
    controller.abort();
    creation.resolve(response(createdTask));
    await assert.rejects(rewrite, { name: "AbortError" });
    assert.equal(requests.filter((url) => url.includes("cancelTask")).length, 1);
    assert.equal(requests.some((url) => url.includes("getTaskInfo")), false);
});

test("canceling a rewrite immediately cancels its task even while status retrieval is blocked", async (context) => {
    const status = deferred<Response>();
    const pollingStarted = deferred<void>();
    let cancelCount = 0;
    context.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("optimizePrompt")) return response(createdTask);
        if (String(url).includes("cancelTask")) { cancelCount += 1; return response(createdTask); }
        pollingStarted.resolve();
        return status.promise;
    });
    const controller = new AbortController();
    const rewrite = rewriteFailedGenerationPrompt("video", "prompt", "rejected", controller.signal);
    await pollingStarted.promise;
    controller.abort();
    assert.equal(cancelCount, 1);
    status.resolve(response(completedTask));
    await assert.rejects(rewrite, { name: "AbortError" });
    assert.equal(cancelCount, 1);
});
