import assert from "node:assert/strict";
import test from "node:test";
import type { SkillOption } from "@/services/api/server";
import { activateCanvasAssistantSkills, canvasAgentSkillSourceLabel, findCanvasAgentSkills, isDedicatedCanvasAgentSkill, normalizeCanvasAgentSkillSelections, toggleCanvasAgentSkill } from "./canvas-agent-skill-library";
import { assistantDraftKey, createAssistantDraftStore, EMPTY_ASSISTANT_DRAFT, exportAssistantSession, parseAssistantDraft } from "./canvas-assistant-workspace";
import { settleCanvasAssistantDraft } from "./canvas-assistant-submission";

const skills: SkillOption[] = [
    { id: 1, name: "产品摄影", description: "广告布光与构图", targetType: "image", coverUrl: "" },
    { id: 2, name: "Cinematic storyboard", description: "多镜头视频", targetType: "video", coverUrl: "" },
    { id: 3, name: "角色四视图", description: "保持一致性", targetType: "canvasSettingGraph", coverUrl: "", systemPrompt: "private-full-prompt" },
];

test("skill search supports name, description, category and ID while filtering media type", () => {
    assert.deepEqual(findCanvasAgentSkills(skills, " cinematic ").map((item) => item.id), [2]);
    assert.deepEqual(findCanvasAgentSkills(skills, "广告").map((item) => item.id), [1]);
    assert.deepEqual(findCanvasAgentSkills(skills, "设定图").map((item) => item.id), [3]);
    assert.deepEqual(findCanvasAgentSkills(skills, "2", "video").map((item) => item.id), [2]);
    assert.deepEqual(findCanvasAgentSkills(skills, "广告", "video"), []);
    assert.equal(skills.length, 3);
});

test("skill selection deduplicates IDs, removes arbitrary prompt fields and enforces five-item limit", () => {
    const raw = [{ ...skills[0], systemPrompt: "sensitive-prompt" }, skills[0], ...Array.from({ length: 8 }, (_, index) => ({ id: index + 2, name: `技能${index + 2}`, targetType: "video" }))];
    const selected = normalizeCanvasAgentSkillSelections(raw);
    assert.deepEqual(selected.map((skill) => skill.id), [1, 2, 3, 4, 5]);
    assert.doesNotMatch(JSON.stringify(selected), /sensitive-prompt|systemPrompt|description|coverUrl/);
    const sixth = { id: 6, name: "第六个技能", targetType: "image" as const };
    assert.equal(toggleCanvasAgentSkill(selected, sixth).limitReached, true);
    assert.equal(toggleCanvasAgentSkill(selected, sixth).selections, selected);
    const removed = toggleCanvasAgentSkill(selected, selected[0]);
    assert.equal(removed.limitReached, false);
    assert.deepEqual(removed.selections.map((skill) => skill.id), [2, 3, 4, 5]);
    assert.equal(toggleCanvasAgentSkill(removed.selections, sixth).selections.length, 5);
    assert.deepEqual(normalizeCanvasAgentSkillSelections([{ id: 0, name: "bad", targetType: "image" }, { id: 1, name: "bad", targetType: "__proto__" }, { id: 2, name: " ", targetType: "video" }]), []);
});

test("only explicit first-last-frame workflows require video creation, ordinary skills remain available", () => {
    assert.equal(isDedicatedCanvasAgentSkill({ workflowType: "first-last-frame" }), true);
    assert.equal(isDedicatedCanvasAgentSkill({ workflowType: null }), false);
    assert.equal(isDedicatedCanvasAgentSkill({ workflowType: "ordinary-video" }), false);
    assert.equal(isDedicatedCanvasAgentSkill({}), false);
});

test("skill-only drafts survive reload and keep account, project and conversation isolation", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const store = createAssistantDraftStore(() => storage);
    const key = assistantDraftKey("user", "project", "chat-1");
    const draft = { ...EMPTY_ASSISTANT_DRAFT, skills: normalizeCanvasAgentSkillSelections([skills[0], skills[2]]) };
    store.update(key, () => draft);
    assert.ok(values.has(key), "Empty text must not remove a draft that has selected skills");
    assert.deepEqual(createAssistantDraftStore(() => storage).read(key), draft);
    assert.equal(store.read(assistantDraftKey("user", "project", "chat-2")).skills, undefined);
    assert.equal(store.read(assistantDraftKey("another-user", "project", "chat-1")).skills, undefined);
    store.update(key, () => EMPTY_ASSISTANT_DRAFT);
    assert.equal(values.has(key), false);
    assert.deepEqual(parseAssistantDraft({ prompt: "legacy", nodeIds: [], styles: [] }), { prompt: "legacy", nodeIds: [], styles: [] });
});

test("accepted skill drafts clear with styles while rejected or newly edited selections stay intact", () => {
    const submitted = { ...EMPTY_ASSISTANT_DRAFT, prompt: "生成角色参考", skills: normalizeCanvasAgentSkillSelections([skills[2]]) };
    assert.equal(settleCanvasAssistantDraft(submitted, submitted, true), EMPTY_ASSISTANT_DRAFT);
    assert.equal(settleCanvasAssistantDraft(submitted, submitted, false), submitted);
    const next = { ...submitted, skills: normalizeCanvasAgentSkillSelections([skills[0]]) };
    assert.equal(settleCanvasAssistantDraft(next, submitted, true), next);
});

test("conversation export records skill names and types without skill prompts", () => {
    const exported = exportAssistantSession({ id: "chat", title: "角色", createdAt: "2026-09-30", updatedAt: "2026-09-30", messages: [{ id: "message", role: "user", text: "生成角色", skills: normalizeCanvasAgentSkillSelections([skills[0], skills[2]]) }] });
    assert.match(exported.text, /使用技能：图片 · 产品摄影、设定图 · 角色四视图/);
    assert.doesNotMatch(exported.text, /private-full-prompt|systemPrompt/);
});

test("activated skills update the exact user turn and cannot fall back to a previous turn after cancellation", () => {
    const session = { id: "chat-1", title: "创作", createdAt: "start", updatedAt: "before", messages: [{ id: "old", role: "user" as const, text: "上一轮", skills: normalizeCanvasAgentSkillSelections([skills[0]]), skillSource: "manual" as const }, { id: "current", role: "user" as const, text: "制作角色参考" }, { id: "assistant", role: "assistant" as const, text: "思考中" }] };
    const selected = normalizeCanvasAgentSkillSelections([skills[2]]);
    const activated = activateCanvasAssistantSkills(session, selected, "auto", "current", "after");
    assert.equal(activated.messages[0], session.messages[0]);
    assert.equal(activated.messages[2], session.messages[2]);
    assert.deepEqual(activated.messages[1].skills, selected);
    assert.equal(activated.messages[1].skillSource, "auto");
    assert.equal(activated.updatedAt, "after");
    assert.equal(session.messages[1].skills, undefined);
    assert.equal(activateCanvasAssistantSkills(session, selected, "auto", "canceled"), session);
    assert.equal(activateCanvasAssistantSkills(session, selected, "auto", "assistant"), session);
    assert.equal(activateCanvasAssistantSkills({ ...session, messages: [] }, selected, "auto").messages.length, 0);
});

test("automatic skill labels survive export while manual and legacy selections stay distinguishable", () => {
    assert.equal(canvasAgentSkillSourceLabel("auto"), "自动匹配技能");
    assert.equal(canvasAgentSkillSourceLabel("manual"), "手动指定技能");
    assert.equal(canvasAgentSkillSourceLabel(), "使用技能");
    const selected = normalizeCanvasAgentSkillSelections([skills[0]]);
    const session = { id: "chat", title: "创作", createdAt: "date", updatedAt: "date", messages: [{ id: "auto", role: "user" as const, text: "图", skills: selected, skillSource: "auto" as const }, { id: "manual", role: "user" as const, text: "图2", skills: selected, skillSource: "manual" as const }] };
    const exported = exportAssistantSession(JSON.parse(JSON.stringify(session)));
    assert.match(exported.text, /自动匹配技能：图片 · 产品摄影/);
    assert.match(exported.text, /手动指定技能：图片 · 产品摄影/);
});
