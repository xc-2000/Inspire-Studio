import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasDocument } from "../domain/canvas-document.ts";
import { createCanvasDocumentSaveScheduler } from "./canvas-document-save-scheduler.ts";
import type { CanvasDocumentSaveStatus } from "./canvas-document-save-scheduler.ts";

test("同一文档连续调度只保存最后一次状态", async () => {
    const savedTitles: string[] = [];
    const scheduler = createCanvasDocumentSaveScheduler({
        delayMilliseconds: 5,
        saveDocument: async (document) => {
            savedTitles.push(document.identity.title);
        },
        onError: () => assert.fail("不应保存失败"),
    });
    const first = createCanvasDocument({ id: "document-1", title: "第一次", now: "2026-07-12T00:00:00.000Z" });
    const second = {
        ...first,
        identity: { ...first.identity, title: "第二次" },
    };

    scheduler.schedule(first);
    scheduler.schedule(second);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(savedTitles, ["第二次"]);
});

test("同一文档的立即保存按调用顺序串行执行", async () => {
    const savedTitles: string[] = [];
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
        releaseFirstSave = resolve;
    });
    const scheduler = createCanvasDocumentSaveScheduler({
        delayMilliseconds: 5,
        saveDocument: async (document) => {
            if (document.identity.title === "第一次") await firstSaveGate;
            savedTitles.push(document.identity.title);
        },
        onError: () => assert.fail("不应保存失败"),
    });
    const first = createCanvasDocument({ id: "document-1", title: "第一次", now: "2026-07-12T00:00:00.000Z" });
    const second = {
        ...first,
        identity: { ...first.identity, title: "第二次" },
    };

    const firstSaving = scheduler.saveNow(first);
    const secondSaving = scheduler.saveNow(second);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(savedTitles, []);

    releaseFirstSave?.();
    await Promise.all([firstSaving, secondSaving]);

    assert.deepEqual(savedTitles, ["第一次", "第二次"]);
});

test("保存失败明确拒绝并在无新编辑时自动重试最新快照", async () => {
    let calls = 0;
    let status: CanvasDocumentSaveStatus | undefined;
    const document = createCanvasDocument({ id: "retry", title: "未保存的修改", now: "2026-09-30" });
    const scheduler = createCanvasDocumentSaveScheduler({
        delayMilliseconds: 5, retryDelayMilliseconds: 5,
        saveDocument: async () => { if (++calls === 1) throw new Error("断网"); },
        onError: () => {}, onStatusChange: (_id, next) => { status = next; },
    });
    await assert.rejects(scheduler.saveNow(document), /断网/);
    assert.equal(status?.phase, "failed");
    assert.equal(scheduler.hasPending?.("retry"), true);
    await waitUntil(() => status?.phase === "saved");
    assert.equal(calls, 2);
    assert.equal(scheduler.hasPending?.("retry"), false);
});

test("旧保存失败不覆盖新编辑的状态，也不重试旧快照", async () => {
    let rejectFirst!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const titles: string[] = [];
    const errors: unknown[] = [];
    let status: CanvasDocumentSaveStatus | undefined;
    const first = createCanvasDocument({ id: "race", title: "旧修改", now: "2026-09-30" });
    const latest = { ...first, identity: { ...first.identity, title: "最新修改" } };
    const scheduler = createCanvasDocumentSaveScheduler({
        delayMilliseconds: 5, retryDelayMilliseconds: 5,
        saveDocument: async document => { titles.push(document.identity.title); if (document === first) await gate; },
        onError: (_id, error) => errors.push(error), onStatusChange: (_id, next) => { status = next; },
    });
    const firstSave = scheduler.saveNow(first);
    await waitUntil(() => titles.length === 1);
    scheduler.schedule(latest);
    const rejection = assert.rejects(firstSave, /旧请求断网/);
    rejectFirst(new Error("旧请求断网"));
    await rejection;
    await waitUntil(() => status?.phase === "saved");
    assert.deepEqual(titles, ["旧修改", "最新修改"]);
    assert.deepEqual(errors, []);
});

test("删除文档取消失败快照，联网恢复不会重新保存已删除文档", async () => {
    let calls = 0;
    const scheduler = createCanvasDocumentSaveScheduler({
        delayMilliseconds: 5, retryDelayMilliseconds: 10,
        saveDocument: async () => { calls++; throw new Error("断网"); }, onError: () => {},
    });
    const document = createCanvasDocument({ id: "removed", title: "删除测试", now: "2026-09-30" });
    await assert.rejects(scheduler.saveNow(document), /断网/);
    scheduler.cancel(document.identity.id);
    await scheduler.retryPending?.();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls, 1);
    assert.equal(scheduler.hasPending?.(), false);
});

test("旧保存成功时，新编辑仍标为待保存而非已保存", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let status: CanvasDocumentSaveStatus | undefined;
    const first = createCanvasDocument({ id: "newer", title: "第一版", now: "2026-09-30" });
    const latest = { ...first, identity: { ...first.identity, title: "第二版" } };
    const scheduler = createCanvasDocumentSaveScheduler({
        delayMilliseconds: 1000,
        saveDocument: async document => { if (document === first) await gate; },
        onError: () => assert.fail("不应失败"), onStatusChange: (_id, next) => { status = next; },
    });
    const saving = scheduler.saveNow(first);
    scheduler.schedule(latest);
    release();
    await saving;
    assert.equal(status?.phase, "pending");
    assert.equal(scheduler.hasPending?.("newer"), true);
    await scheduler.retryPending?.();
    assert.equal(status?.phase, "saved");
});

async function waitUntil(condition: () => boolean) {
    const deadline = Date.now() + 1000;
    while (!condition()) {
        if (Date.now() >= deadline) assert.fail("状态未在预期时间内更新");
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}
