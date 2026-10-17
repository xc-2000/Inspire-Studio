import assert from "node:assert/strict";
import test from "node:test";
import { createTextNode, createImageNode } from "../constants";
import type { CanvasAssistantSession } from "../types.ts";
import { assistantDraftKey, createAssistantDraftStore, EMPTY_ASSISTANT_DRAFT, exportAssistantSession, findAssistantNodes, findAssistantSessions, removeAssistantDraftNodes } from "./canvas-assistant-workspace";

const session = (id: string, title: string, date: string): CanvasAssistantSession => ({ id, title, createdAt: date, updatedAt: date, messages: [] });
const draft = { prompt: "保持主角一致\n慢慢推近", nodeIds: ["image-a"], styles: [{ id: 1, name: "电影", generationType: "video" as const, coverUrl: "", category: "风格" }] };

function storageFixture() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test("草稿在会话切换、面板重建与刷新后恢复，账号和项目彼此隔离", () => {
    const storage = storageFixture();
    const store = createAssistantDraftStore(() => storage);
    const key = assistantDraftKey("u1", "p1", "s1");
    store.update(key, () => draft);
    store.update(assistantDraftKey("u1", "p1", "s2"), () => ({ ...draft, prompt: "另一段创作" }));
    assert.equal(store.read(key).prompt, draft.prompt);
    assert.equal(store.read(assistantDraftKey("u2", "p1", "s1")).prompt, "");
    assert.equal(store.read(assistantDraftKey("u1", "p2", "s1")).prompt, "");
    assert.deepEqual(createAssistantDraftStore(() => storage).read(key), draft);
    assert.equal(store.read(key), store.read(key), "React snapshots remain stable until changed");
});

test("连续添加引用和编辑文字均保留；发送只清除对应会话的草稿", () => {
    const storage = storageFixture();
    const store = createAssistantDraftStore(() => storage);
    let events = 0;
    const unsubscribe = store.subscribe(() => events++);
    store.update("a", () => draft);
    store.update("b", () => draft);
    store.update("a", (previous) => ({ ...previous, prompt: "继续", nodeIds: [...previous.nodeIds, "image-b"] }));
    assert.deepEqual(store.read("a").nodeIds, ["image-a", "image-b"]);
    store.update("a", () => EMPTY_ASSISTANT_DRAFT);
    assert.equal(storage.getItem("a"), null);
    assert.deepEqual(store.read("b"), draft);
    assert.equal(events, 4);
    unsubscribe();
    store.update("a", () => draft);
    assert.equal(events, 4);
});

test("损坏或不可写的草稿存储不会阻止输入，并报告保存失败", () => {
    const storage = storageFixture();
    storage.setItem("broken", "{bad json");
    storage.setItem("legacy", JSON.stringify({ prompt: "文字", nodeIds: [null, 3, "x", "x"], styles: [null, {}, { id: 7, name: "未知", generationType: "other" }] }));
    const store = createAssistantDraftStore(() => storage);
    assert.deepEqual(store.read("broken"), EMPTY_ASSISTANT_DRAFT);
    assert.deepEqual(store.read("legacy"), { prompt: "文字", nodeIds: ["x"], styles: [] });
    const unavailable = createAssistantDraftStore(() => { throw new Error("Quota exceeded"); });
    assert.equal(unavailable.update("draft", () => draft), false);
    assert.deepEqual(unavailable.read("draft"), draft);
});

test("删除节点或取消引用会移除准确的 ID，保留段落与其他节点", () => {
    const source = { ...draft, prompt: "第一行\n第二行 image-a image-ab", nodeIds: ["image-a", "image-ab"] };
    const result = removeAssistantDraftNodes(source, new Set(["image-a"]));
    assert.deepEqual(result.nodeIds, ["image-ab"]);
    assert.equal(result.prompt, "第一行\n第二行  image-ab");
    assert.deepEqual(result.styles, source.styles);
});

test("历史搜索支持内容关键词且按更新排序，不改动原始会话顺序", () => {
    const older = session("a", "旧创作", "2026-09-25");
    older.messages.push({ id: "m1", role: "user", text: "PAPER BOAT" });
    const newer = session("b", "Paper 新创作", "2026-09-26");
    const sessions = [older, newer];
    assert.deepEqual(findAssistantSessions(sessions, " paper ").map((item) => item.id), ["b", "a"]);
    assert.deepEqual(sessions.map((item) => item.id), ["a", "b"]);
    assert.equal(findAssistantSessions(sessions, "不存在").length, 0);
});

test("节点搜索可按类型、ID、名称和文本内容查找", () => {
    const text = createTextNode({ id: "text-1", title: "角色设定", position: { x: 0, y: 0 } });
    text.content.text = "一位穿红衣的航海家";
    const image = createImageNode({ id: "image-1", title: "角色参考", position: { x: 0, y: 0 } });
    assert.deepEqual(findAssistantNodes([text, image], "航海家").map((node) => node.id), ["text-1"]);
    assert.deepEqual(findAssistantNodes([text, image], "角色", "image").map((node) => node.id), ["image-1"]);
    assert.equal(findAssistantNodes([text, image], "IMAGE-1")[0].id, "image-1");
    assert.equal(findAssistantNodes([text, image], "缺失").length, 0);
});

test("导出保留创作内容和引用名称，不带内部执行载荷与媒体地址", () => {
    const conversation = session("a", "创作/分镜:1", "2026-09-26");
    conversation.messages = [
        { id: "m1", role: "user", text: "开始\n创作", references: [{ id: "n1", type: "image", title: "主角", dataUrl: "https://private.invalid/image" }], generationStyles: draft.styles },
        { id: "m2", role: "assistant", text: "## 镜头一\n保持构图。" },
        { id: "m3", role: "tool", title: "添加节点", text: "已完成", detail: { secret: "internal-payload" } },
    ];
    const exported = exportAssistantSession(conversation);
    assert.equal(exported.filename, "创作_分镜_1.md");
    assert.match(exported.text, /开始\n创作/);
    assert.match(exported.text, /## 镜头一\n保持构图/);
    assert.match(exported.text, /引用节点：主角/);
    assert.match(exported.text, /使用风格：电影/);
    assert.doesNotMatch(exported.text, /private\.invalid|internal-payload/);
    assert.equal(conversation.messages.length, 3);
});
