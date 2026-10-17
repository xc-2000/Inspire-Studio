import assert from "node:assert/strict";
import test from "node:test";
import { createVideoCoverQueue, isSameVideoSource, needsVideoCover } from "./video-cover.ts";
import type { VideoAsset } from "../stores/use-asset-store.ts";

const video = (patch: Partial<VideoAsset> = {}): VideoAsset => ({
    id: "video", kind: "video", title: "Video", coverUrl: "", tags: [], createdAt: "", updatedAt: "",
    data: { url: "https://media.example/video.mp4", storageKey: "video:1", width: 0, height: 0, bytes: 1, mimeType: "video/mp4" },
    ...patch,
});

test("cover repair excludes existing covers and deleted assets", () => {
    assert.equal(needsVideoCover(video()), true);
    assert.equal(needsVideoCover(video({ coverUrl: "https://media.example/cover.jpg" })), false);
    assert.equal(needsVideoCover(video({ metadata: { deletedAt: "2026-09-30" } })), false);
    assert.equal(needsVideoCover(undefined), false);
});

test("a delayed cover cannot be applied to a different video or a removed asset", () => {
    const original = video();
    assert.equal(isSameVideoSource(video({ data: { ...original.data, url: "https://new-url.example/same.mp4" } }), original), true);
    assert.equal(isSameVideoSource(video({ data: { ...original.data, storageKey: "video:2" } }), original), false);
    assert.equal(isSameVideoSource(undefined, original), false);
});

test("multiple cards share extraction while only two videos run concurrently", async () => {
    const enqueue = createVideoCoverQueue(2);
    const release: Array<() => void> = [];
    let started = 0;
    const task = () => new Promise<void>((resolve) => { started++; release.push(resolve); });
    const first = enqueue("first", task);
    const duplicate = enqueue("first", task);
    const second = enqueue("second", task);
    const third = enqueue("third", task);
    assert.equal(first, duplicate);
    await Promise.resolve();
    assert.equal(started, 2);
    release[0]();
    await first;
    await Promise.resolve();
    assert.equal(started, 3);
    release[1]();
    release[2]();
    await Promise.all([second, third]);
});

test("failed extraction releases its queue slot and can be retried", async () => {
    const enqueue = createVideoCoverQueue(1);
    let ran = false;
    await assert.rejects(enqueue("bad", async () => { throw Error("cannot decode"); }), /cannot decode/);
    await enqueue("bad", async () => { ran = true; });
    assert.equal(ran, true);
});
