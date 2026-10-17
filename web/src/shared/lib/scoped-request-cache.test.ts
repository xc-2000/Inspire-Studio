import assert from "node:assert/strict";
import test from "node:test";
import { ScopedRequestCache } from "./scoped-request-cache";

test("parallel history references share one request and repeated navigation reuses it until expiry", async () => {
    let now = 100, requests = 0;
    const cache = new ScopedRequestCache<string>(60, 5, () => now);
    const load = async () => { requests++; return "https://media.example/frame.jpg"; };
    const values = await Promise.all(Array.from({ length: 20 }, () => cache.read("user-a", "frame", load)));
    assert.equal(requests, 1);
    assert.equal(new Set(values).size, 1);
    await cache.read("user-a", "frame", load);
    assert.equal(requests, 1);
    now = 160;
    await cache.read("user-a", "frame", load);
    assert.equal(requests, 2);
});

test("account changes never reuse the previous account's value", async () => {
    const cache = new ScopedRequestCache<string>(1000);
    let finish!: (value: string) => void;
    const previous = cache.read("user-a", "frame", () => new Promise<string>(resolve => { finish = resolve; }));
    await Promise.resolve();
    assert.equal(await cache.read("user-b", "frame", async () => "B"), "B");
    finish("A");
    await previous;
    assert.equal(await cache.read("user-b", "frame", async () => "incorrect"), "B");
    assert.equal(await cache.read("user-a", "frame", async () => "new-A"), "new-A");
});

test("upload/delete invalidation cannot be undone by an older request", async () => {
    const cache = new ScopedRequestCache<string>(1000);
    let finish!: (value: string) => void;
    const old = cache.read("user", "frame", () => new Promise<string>(resolve => { finish = resolve; }));
    await Promise.resolve();
    cache.clear();
    assert.equal(await cache.read("user", "frame", async () => "new-url"), "new-url");
    finish("old-url");
    await old;
    assert.equal(await cache.read("user", "frame", async () => "incorrect"), "new-url");
});

test("failed reads can retry and the cache has a bounded size", async () => {
    const cache = new ScopedRequestCache<string>(1000, 2);
    await assert.rejects(cache.read("user", "a", async () => { throw new Error("offline"); }));
    assert.equal(await cache.read("user", "a", async () => "recovered"), "recovered");
    await cache.read("user", "b", async () => "B");
    await cache.read("user", "c", async () => "C");
    assert.equal(await cache.read("user", "a", async () => "reloaded"), "reloaded");
});
