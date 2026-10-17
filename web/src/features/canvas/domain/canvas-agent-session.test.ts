import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasAgentBindingStore, queryCanvasAgentRequest, resolveCanvasAgentChatBinding } from "./canvas-agent-session.ts";
import type { CanvasAssistantSession } from "../types.ts";

const session = (id: string, message: string): CanvasAssistantSession => ({ id, title: id, messages: [{ id: "user", role: "user", text: message }], createdAt: "2026-09-30", updatedAt: "2026-09-30" });

test("a fresh page restores the local chat and submitted chapter using the backend request ID", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); } };
    createCanvasAgentBindingStore(() => storage).write("user", "project", { chatId: "local-chat", sessionId: "backend-session", requestId: "request", chapterId: "original-chapter", message: "generate" });
    const restored = createCanvasAgentBindingStore(() => storage).read("user", "project");
    const resolved = resolveCanvasAgentChatBinding({ sessionId: "backend-session", requestId: "request", message: "generate" }, restored, [session("visible-other-chat", "other")]);
    assert.equal(resolved?.chatId, "local-chat");
    assert.equal(resolved?.chapterId, "original-chapter");
    assert.equal(createCanvasAgentBindingStore(() => storage).read("other-user", "project"), null);
    assert.equal(createCanvasAgentBindingStore(() => storage).read("user", "other-project"), null);
});

test("reload while the submit response is pending can recover the local binding", () => {
    const active = { sessionId: "server", requestId: "accepted", message: "pending prompt" };
    assert.equal(resolveCanvasAgentChatBinding(active, { chatId: "local", chapterId: "chapter", message: active.message }, [])?.requestId, "accepted");
    assert.equal(resolveCanvasAgentChatBinding(active, { chatId: "stale", chapterId: null, message: "different", requestId: "older" }, [session("matched", active.message)])?.chatId, "matched");
    assert.equal(resolveCanvasAgentChatBinding(active, null, [session("unrelated", "different")]), null);
});

test("a network error remains distinct from a confirmed empty request", async () => {
    assert.deepEqual(await queryCanvasAgentRequest(async () => { throw new Error("offline"); }), { ok: false });
    assert.deepEqual(await queryCanvasAgentRequest(async () => null), { ok: true, active: null });
});

test("binding reads observe other tabs and keep an in-memory fallback when browser storage fails", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const tab = createCanvasAgentBindingStore(() => storage);
    tab.write("user", "project", { chatId: "first", message: "first", chapterId: null });
    createCanvasAgentBindingStore(() => storage).write("user", "project", { chatId: "second", message: "second", chapterId: null });
    assert.equal(tab.read("user", "project")?.chatId, "second");
    const unavailable = createCanvasAgentBindingStore(() => ({ getItem: () => null, setItem: () => { throw new Error("blocked storage"); } }));
    unavailable.write("user", "project", { chatId: "local", message: "prompt", chapterId: null });
    assert.equal(unavailable.read("user", "project")?.chatId, "local");
});
