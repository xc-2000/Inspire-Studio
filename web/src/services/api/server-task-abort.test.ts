import assert from "node:assert/strict";
import test from "node:test";
import { waitAiTask } from "./server";

test("画布卸载只结束订阅，保留云端任务；显式停止仍取消任务", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalFetch = globalThis.fetch;
    let intervalStarted: (() => void) | undefined;
    let cleaned = 0;
    const requests: string[] = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { origin: "http://example.test" },
        setInterval: () => { intervalStarted?.(); return 1; }, clearInterval: () => { cleaned++; },
    } });
    globalThis.fetch = async input => {
        const path = String(input);
        requests.push(path);
        const data = path.includes("getRuntimeConfig") ? { aiTaskPollingIntervalSeconds: 1 } : { id: "task", status: "running", progress: 30 };
        return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
        const controller = new AbortController();
        const ready = new Promise<void>(resolve => { intervalStarted = resolve; });
        const waiting = waitAiTask("task", { signal: controller.signal, cancelOnAbort: false });
        await ready;
        controller.abort();
        await assert.rejects(waiting, error => error instanceof DOMException && error.name === "AbortError");
        assert.equal(cleaned, 1);
        assert.equal(requests.filter(path => path.includes("cancelTask")).length, 0);
        const stop = new AbortController();
        stop.abort();
        await assert.rejects(waitAiTask("task", { signal: stop.signal }), error => error instanceof DOMException && error.name === "AbortError");
        assert.equal(requests.filter(path => path.includes("cancelTask")).length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});
