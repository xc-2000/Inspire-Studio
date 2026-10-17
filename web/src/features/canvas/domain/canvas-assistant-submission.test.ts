import assert from "node:assert/strict";
import test from "node:test";
import { settleCanvasAssistantDraft, submitCanvasAssistantDraft } from "./canvas-assistant-submission.ts";
import { EMPTY_ASSISTANT_DRAFT, type CanvasAssistantDraft } from "./canvas-assistant-workspace.ts";

const submitted: CanvasAssistantDraft = { prompt: "generate node-a", nodeIds: ["node-a"], styles: [{ id: 7, name: "cinema", generationType: "image", category: "", coverUrl: "" }] };

test("failed or rejected submissions retain the entire retry payload", async () => {
    const accepted = await submitCanvasAssistantDraft(async () => { throw new Error("network failed"); });
    assert.equal(accepted, false);
    assert.equal(settleCanvasAssistantDraft(submitted, submitted, accepted), submitted);
    assert.equal(await submitCanvasAssistantDraft(async () => false), false);
});

test("successful submission clears the accepted draft and preserves subsequent typing", async () => {
    const accepted = await submitCanvasAssistantDraft(async () => true);
    assert.equal(settleCanvasAssistantDraft(submitted, submitted, accepted), EMPTY_ASSISTANT_DRAFT);
    const next = { ...submitted, prompt: "next idea" };
    assert.equal(settleCanvasAssistantDraft(next, submitted, accepted), next);
});
