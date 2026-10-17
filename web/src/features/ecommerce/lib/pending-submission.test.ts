import assert from "node:assert/strict";
import test from "node:test";
import { isDefiniteCommerceRejection, prepareCommerceSubmission, restoreCommerceSubmission } from "./pending-submission.ts";
import type { CommerceGenerateInput } from "../api/ecommerce.ts";

const original: CommerceGenerateInput = { projectId: "product-a", requestId: "accepted-request", kind: "copy", model: "text-model", parameters: {}, skillId: "copy-skill", skillRevision: 1 };

test("a response lost after acceptance recovers the original paid task despite a refreshed skill version", async () => {
    const accepted = new Map([[original.requestId, "already-created-task"]]);
    let freshCalls = 0;
    let newTasks = 0;
    const pending = restoreCommerceSubmission({ signature: "old-version-and-editor-state", request: original }, "product-a");
    const submission = await prepareCommerceSubmission(pending, async () => {
        freshCalls++;
        return { ...original, requestId: "new-request", skillRevision: 2 };
    });
    const task = accepted.get(submission.request.requestId) || (newTasks++, "duplicate-task");
    assert.equal(task, "already-created-task");
    assert.equal(submission.recovering, true);
    assert.equal(submission.request.skillRevision, 1);
    assert.equal(freshCalls, 0);
    assert.equal(newTasks, 0);
});

test("disabled or deleted skills and edited invalid product fields cannot prevent recovery or trigger a save", async () => {
    for (const issue of ["所选技能已停用", "技能已删除", "请填写商品名称"]) {
        let saves = 0;
        const submission = await prepareCommerceSubmission({ request: original }, async () => {
            saves++;
            throw new Error(issue);
        });
        assert.deepEqual(submission.request, original);
        assert.equal(saves, 0);
    }
});

test("after the previous request is resolved a separate click can submit the user's current new intent", async () => {
    let freshCalls = 0;
    const fresh = async () => {
        freshCalls++;
        return { ...original, requestId: "explicit-new-request", skillRevision: 3 };
    };
    assert.equal((await prepareCommerceSubmission({ request: original }, fresh)).request.requestId, "accepted-request");
    const next = await prepareCommerceSubmission(null, fresh);
    assert.equal(next.recovering, false);
    assert.equal(next.request.requestId, "explicit-new-request");
    assert.equal(next.request.skillRevision, 3);
    assert.equal(freshCalls, 1);
});

test("restored pending requests cannot leak across projects or accept corrupt browser storage", () => {
    assert.equal(restoreCommerceSubmission({ request: original }, "product-b"), null);
    for (const value of [null, {}, { request: {} }, { request: { ...original, requestId: "bad/id" } }, { request: { ...original, parameters: [] } }]) {
        assert.equal(restoreCommerceSubmission(value, "product-a"), null);
    }
});

test("unknown network results, authentication expiry and in-flight recovery retain the request id", () => {
    for (const code of [undefined, 3000, 3001, 3002, 5000, 5001, 5002]) assert.equal(isDefiniteCommerceRejection(code, "请求失败"), false);
    assert.equal(isDefiniteCommerceRejection(4000, "请稍后使用同一请求标识重试"), false);
    assert.equal(isDefiniteCommerceRejection(2001, "该请求标识已用于不同生成参数"), false);
    assert.equal(isDefiniteCommerceRejection(2001, "技能内容已更新，请刷新后重试"), true);
    assert.equal(isDefiniteCommerceRejection(4001, "技能不存在或已删除"), true);
});

test("changing image mode after a lost response retains the original mode and request id", async () => {
    for (const imageGenerationMode of ["text-to-image", "image-to-image", undefined] as const) {
        const request: CommerceGenerateInput = { ...original, kind: "image", imageGenerationMode };
        const pending = restoreCommerceSubmission(JSON.parse(JSON.stringify({ request })), request.projectId);
        let freshCalls = 0;
        const submission = await prepareCommerceSubmission(pending, async () => {
            freshCalls++;
            return { ...request, requestId: "different-request", imageGenerationMode: imageGenerationMode === "text-to-image" ? "image-to-image" : "text-to-image" };
        });
        assert.equal(submission.recovering, true);
        assert.equal(submission.request.imageGenerationMode, imageGenerationMode);
        assert.equal(submission.request.requestId, request.requestId);
        assert.equal(freshCalls, 0);
    }
});
