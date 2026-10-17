import assert from "node:assert/strict";
import test from "node:test";

import type { SkillOption, SkillType } from "@/services/api/server";
import type { CanvasAgentSkillSelection } from "../types";
import type { CanvasAgentToolResult } from "./upstream/canvas-agent-tools";
import { createCanvasAgentSkillDiscovery } from "./skill-discovery";

function skill(id: number, name = `技能${id}`, targetType: SkillType = "image", description = "创作介绍"): SkillOption {
    return { id, name, targetType, description, coverUrl: "https://example.com/cover.png", systemPrompt: `完整正文${id}` };
}
function selection(id: number, targetType: SkillType = "image"): CanvasAgentSkillSelection {
    return { id, name: `旧名称${id}`, targetType };
}
function ids(result: CanvasAgentToolResult) {
    return (result.skills as { id: number }[]).map((entry) => entry.id);
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test("automatic runs start empty and manual runs preload fresh definitions without activation notification", async () => {
    let catalogueCalls = 0;
    let detailCalls = 0;
    let notifications = 0;
    const options = {
        fetchCatalogue: async () => { catalogueCalls++; return [skill(1)]; },
        fetchSkill: async (id: number, type: SkillType) => { detailCalls++; return skill(id, "实时商品技能", type); },
        onSkillsActivated: () => { notifications++; },
    };
    const automatic = await createCanvasAgentSkillDiscovery(options);
    assert.deepEqual(automatic.currentSelections, []);
    assert.deepEqual(automatic.activeSkillContents, []);
    assert.equal(automatic.hasFiles, false);
    assert.equal(automatic.source, "auto");
    assert.match(automatic.userGuidance, /商品、分镜、角色/);
    const manual = await createCanvasAgentSkillDiscovery({ ...options, manualSelections: [selection(1)] });
    assert.deepEqual(manual.currentSelections, [{ ...selection(1), name: "实时商品技能" }]);
    assert.equal(manual.source, "manual");
    assert.equal(manual.hasFiles, true);
    assert.match(manual.userGuidance, /和画布节点选择互相独立/);
    assert.match(manual.userGuidance, /get_selected_nodes为空不影响技能加载/);
    assert.match(manual.activeSkillContents[0].content, /完整正文1/);
    assert.equal(catalogueCalls, 0);
    assert.equal(detailCalls, 1);
    assert.equal(notifications, 0);
    manual.currentSelections[0].name = "外部篡改";
    manual.activeSkillContents[0].content = "外部篡改";
    assert.equal(manual.currentSelections[0].name, "实时商品技能");
    assert.match(manual.activeSkillContents[0].content, /完整正文1/);
});

test("Chinese short terms use OR matching over name and description with ranking and numeric ID lookup", async () => {
    const catalogue = [
        skill(1, "商品摄影"), skill(2, "人物设定", "image", "角色细节"),
        skill(3, "商品", "image", "角色设定"), skill(4, "电影分镜", "video"),
        { ...skill(5, "通用创作"), systemPrompt: "只有正文包含商品和角色" },
    ];
    const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => catalogue, fetchSkill: async (id) => skill(id) });
    const result = await manager.executeTool("search_skills", { query: "商品 角色" });
    assert.equal(result.ok, true);
    assert.deepEqual(ids(result), [3, 1, 2]);
    assert.deepEqual(ids(await manager.executeTool("search_skills", { query: "ＩＤ：４" })), [4]);
    assert.deepEqual(ids(await manager.executeTool("search_skills", { query: "5" })), [5]);
    assert.deepEqual(ids(await manager.executeTool("search_skills", { query: "只有正文" })), []);
    const summaries = result.skills as Record<string, unknown>[];
    assert.deepEqual(Object.keys(summaries[0]).sort(), ["available", "description", "id", "name", "targetType"]);
    assert.ok(!JSON.stringify(result).includes("cover.png"));
    assert.ok(!JSON.stringify(result).includes("完整正文1"));
});

test("search supports bounded pages and target filtering while summaries keep descriptions concise", async () => {
    const catalogue = Array.from({ length: 26 }, (_, index) => skill(index + 1, `商品${index + 1}`, index < 24 ? "image" : "video", "长简介 ".repeat(200)));
    const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => catalogue, fetchSkill: async (id, type) => skill(id, undefined, type) });
    const first = await manager.executeTool("search_skills", { targetType: "image" });
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 12);
    assert.equal(first.total, 24);
    assert.equal(first.catalogueCount, 26);
    assert.equal(first.hasMore, true);
    assert.deepEqual(ids(first), Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal((first.skills as { description: string }[])[0].description.length, 481);
    assert.ok((first.skills as { description: string }[])[0].description.endsWith("…"));
    const second = await manager.executeTool("search_skills", { targetType: "image", page: 2 });
    assert.deepEqual(ids(second), Array.from({ length: 12 }, (_, index) => index + 13));
    assert.equal(second.hasMore, false);
    assert.deepEqual(ids(await manager.executeTool("search_skills", { targetType: "video", pageSize: 1 })), [25]);
});

test("invalid search and activation arguments fail before network access", async () => {
    let requests = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => { requests++; return []; }, fetchSkill: async (id) => { requests++; return skill(id); },
    });
    for (const args of [
        { query: 123 }, { targetType: "audio" }, { targetType: null }, { page: 0 }, { page: 1.5 },
        { pageSize: 0 }, { pageSize: 13 }, { pageSize: "12" }, { page: Number.MAX_SAFE_INTEGER + 1 }, { prompt: "商品" },
    ]) assert.equal((await manager.executeTool("search_skills", args)).code, "invalid_tool_arguments");
    for (const args of [
        {}, { skillIds: [] }, { skillIds: [0] }, { skillIds: [1.5] }, { skillIds: ["1"] },
        { skillIds: [1, 1] }, { skillIds: [1, 2, 3, 4, 5, 6] }, { skillIds: [Number.MAX_SAFE_INTEGER + 1] },
        { skillIds: [1], targetType: "video" },
    ]) assert.equal((await manager.executeTool("activate_skills", args)).code, "invalid_tool_arguments");
    assert.equal(requests, 0);
});

test("successful catalogues cache within one run including empty results and concurrent searches", async () => {
    let requests = 0;
    const pending = deferred<SkillOption[]>();
    const fetchCatalogue = () => { requests++; return pending.promise; };
    const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue, fetchSkill: async (id) => skill(id) });
    const first = manager.executeTool("search_skills", { query: "商品" });
    const second = manager.executeTool("search_skills", {});
    assert.equal(requests, 1);
    pending.resolve([]);
    assert.equal((await first).total, 0);
    assert.equal((await second).total, 0);
    assert.equal((await manager.executeTool("search_skills", {})).ok, true);
    assert.equal(requests, 1);
    const nextRun = await createCanvasAgentSkillDiscovery({ fetchCatalogue, fetchSkill: async (id) => skill(id) });
    await nextRun.executeTool("search_skills", {});
    assert.equal(requests, 2);
});

test("catalogue failures remain explicit and can be retried instead of claiming an empty catalogue", async () => {
    let requests = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => { if (++requests === 1) throw new Error("服务器暂不可用"); return [skill(1)]; },
        fetchSkill: async (id) => skill(id),
    });
    const failed = await manager.executeTool("search_skills", {});
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "skill_catalogue_load_failed");
    assert.match(failed.message!, /服务器暂不可用/);
    assert.equal(failed.total, undefined);
    assert.equal(failed.skills, undefined);
    assert.deepEqual(ids(await manager.executeTool("search_skills", {})), [1]);
    await manager.executeTool("search_skills", {});
    assert.equal(requests, 2);
});

test("malformed catalogues and conflicting categories for one ID cannot be used", async () => {
    for (const catalogue of [
        null, [skill(0)], [skill(Number.MAX_SAFE_INTEGER + 1)], [{ ...skill(1), name: " " }],
        [{ ...skill(1), targetType: "audio" }], [skill(1), skill(1, "同ID", "video")],
    ]) {
        const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => catalogue as SkillOption[], fetchSkill: async (id) => skill(id) });
        const result = await manager.executeTool("search_skills", {});
        assert.equal(result.ok, false);
        assert.equal(result.code, "skill_catalogue_invalid");
        assert.equal(result.total, undefined);
    }
});

test("only registered first-last-frame metadata makes a skill unavailable", async () => {
    let detailRequests = 0;
    const ordinary = skill(1, "首尾帧创意", "video", "为首尾帧写电影运镜");
    const workflow = { ...skill(2, "专用首尾帧", "video"), workflowType: " First-Last-Frame " };
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => [workflow, ordinary], fetchSkill: async (id) => { detailRequests++; return id === 1 ? ordinary : workflow; },
    });
    const search = await manager.executeTool("search_skills", {});
    const results = search.skills as Record<string, unknown>[];
    assert.deepEqual(ids(search), [1, 2]);
    assert.equal(results[0].available, true);
    assert.equal(results[1].available, false);
    assert.match(String(results[1].reason), /视频创作入口/);
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [2] })).code, "workflow_requires_video_entry");
    assert.equal(detailRequests, 0);
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1] })).ok, true);
    assert.equal(detailRequests, 1);
});

test("auto activation requires IDs actually returned on a searched page and never accepts forged category data", async () => {
    const catalogue = Array.from({ length: 14 }, (_, index) => skill(index + 1));
    let detailRequests = 0;
    let catalogueRequests = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => { catalogueRequests++; return catalogue; },
        fetchSkill: async (id) => { detailRequests++; return skill(id); },
    });
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1] })).code, "skill_not_discovered");
    assert.equal(catalogueRequests, 0);
    await manager.executeTool("search_skills", {});
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [13] })).code, "skill_not_discovered");
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [999] })).code, "skill_not_discovered");
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1], targetType: "video" })).code, "invalid_tool_arguments");
    assert.equal(detailRequests, 0);
    await manager.executeTool("search_skills", { page: 2 });
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [13] })).ok, true);
    assert.equal(detailRequests, 1);
});

test("auto activation rejects bundles mixing 3D/realistic and 2D anime styles but allows one style family", async () => {
    const catalogue = [
        skill(1, "赛博朋克风格导演（3D写实）", "video", "3D写实风格：写实三维渲染的赛博朋克短片。不适合日系二维赛璐璐动画需求。"),
        skill(2, "动漫PV导演｜生成器", "video", "生成角色设定图和高质量原创动漫PV"),
        skill(3, "二次元动漫日常", "video", "二次元风格"),
        skill(4, "角色一致性引擎", "image", "保证不同分镜角色形态一致"),
    ];
    let detailRequests = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => catalogue,
        fetchSkill: async (id, type) => { detailRequests++; return catalogue.find((entry) => entry.id === id) || skill(id, undefined, type); },
    });
    const searched = await manager.executeTool("search_skills", {});
    const styles = Object.fromEntries((searched.skills as { id: number; style?: string }[]).map((entry) => [entry.id, entry.style]));
    assert.deepEqual(styles, { 1: "3D/写实", 2: "二维动漫/赛璐璐", 3: "二维动漫/赛璐璐", 4: undefined });
    assert.match(manager.userGuidance, /style不同/);
    const conflict = await manager.executeTool("activate_skills", { skillIds: [1, 2, 4] });
    assert.equal(conflict.code, "skill_style_conflict");
    assert.match(String(conflict.message), /3D\/写实：赛博朋克风格导演（3D写实）；二维动漫\/赛璐璐：动漫PV导演｜生成器/);
    assert.equal(detailRequests, 0);
    assert.equal(manager.currentSelections.length, 0);
    const compatible = await manager.executeTool("activate_skills", { skillIds: [2, 3, 4] });
    assert.equal(compatible.ok, true);
    assert.deepEqual(manager.currentSelections.map((entry) => entry.id), [2, 3, 4]);
});

test("manual selections may combine styles because the user chose them explicitly", async () => {
    const catalogue = [
        skill(1, "赛博朋克风格导演（3D写实）", "video", "3D写实风格"),
        skill(2, "二次元动漫日常", "video", "二次元风格"),
    ];
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => catalogue,
        fetchSkill: async (id) => catalogue.find((entry) => entry.id === id)!,
        manualSelections: [selection(1, "video"), selection(2, "video")],
    });
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1, 2] })).ok, true);
});

test("activation uses fresh detail names, attaches full roots and notifies only after replacing state", async () => {
    let version = 0;
    const notifications: { source: string; selected: CanvasAgentSkillSelection[] }[] = [];
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => [skill(1, "目录旧名称", "video")],
        fetchSkill: async (id, type) => ({ ...skill(id, `最新名称${++version}`, type), systemPrompt: `新版正文${version}` }),
        onSkillsActivated: (selected, source) => {
            assert.deepEqual(manager.currentSelections, selected);
            assert.match(manager.activeSkillContents[0].content, /新版正文/);
            notifications.push({ source, selected });
        },
    });
    await manager.executeTool("search_skills", {});
    const first = await manager.executeTool("activate_skills", { skillIds: [1] });
    assert.equal(first.ok, true);
    assert.equal(first.source, "auto");
    assert.deepEqual(first.selections, [{ id: 1, name: "最新名称1", targetType: "video" }]);
    assert.ok((first.activeSkillContents as { content: string }[])[0].content.includes("新版正文1"));
    assert.match((first.selectionContext as { attachmentContext: string }).attachmentContext, /和画布节点选择互相独立/);
    assert.match(first.message!, /不要寻找所谓“技能画布节点”/);
    assert.equal(first.hasFiles, true);
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1] })).ok, true);
    assert.match(manager.activeSkillContents[0].content, /新版正文2/);
    assert.deepEqual(notifications.map((entry) => entry.source), ["auto", "auto"]);
});

test("detail failures preserve the old bundle and successful replacement revokes its reader", async () => {
    let replacement: SkillOption | Error = skill(2);
    let notifications = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => [skill(1), skill(2)],
        fetchSkill: async (id) => { if (id === 1) return skill(1); if (replacement instanceof Error) throw replacement; return replacement; },
        onSkillsActivated: () => { notifications++; },
    });
    await manager.executeTool("search_skills", {});
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1] })).ok, true);
    for (const invalid of [
        new Error("技能已停用"), skill(3), skill(2, undefined, "video"), { ...skill(2), systemPrompt: " " },
        { ...skill(2), workflowType: "first-last-frame" },
    ]) {
        replacement = invalid;
        const result = await manager.executeTool("activate_skills", { skillIds: [2] });
        assert.equal(result.ok, false);
        assert.deepEqual(manager.currentSelections.map((entry) => entry.id), [1]);
        assert.equal((await manager.executeTool("read_skill_file", { skillId: "1", path: "SKILL.md" })).content, "完整正文1");
        assert.equal((await manager.executeTool("read_skill_file", { skillId: "2", path: "SKILL.md" })).code, "skill_not_loaded");
        assert.equal(notifications, 1);
    }
    replacement = skill(2);
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [2] })).ok, true);
    assert.deepEqual(manager.currentSelections.map((entry) => entry.id), [2]);
    assert.equal((await manager.executeTool("read_skill_file", { skillId: "1", path: "SKILL.md" })).code, "skill_not_loaded");
    assert.equal((await manager.executeTool("read_skill_file", { skillId: "2", path: "SKILL.md" })).content, "完整正文2");
    assert.equal(notifications, 2);
});

test("manual activation locks the original set but allows its fresh reload without catalogue discovery", async () => {
    let detailRequests = 0;
    let notifications = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        manualSelections: [selection(2, "video"), selection(1)],
        fetchCatalogue: async () => { throw new Error("手选重载不应读取目录"); },
        fetchSkill: async (id, type) => { detailRequests++; return skill(id, `实时${detailRequests}`, type); },
        onSkillsActivated: (selected, source) => { notifications++; assert.equal(source, "manual"); assert.deepEqual(selected.map((entry) => entry.id), [2, 1]); },
    });
    assert.equal(detailRequests, 2);
    assert.equal(notifications, 0);
    for (const skillIds of [[1], [2], [1, 2, 3], [2, 3]]) {
        assert.equal((await manager.executeTool("activate_skills", { skillIds })).code, "manual_selection_locked");
    }
    assert.equal(detailRequests, 2);
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1, 2] })).ok, true);
    assert.equal(detailRequests, 4);
    assert.equal(notifications, 1);
    assert.deepEqual(manager.currentSelections.map((entry) => entry.name), ["实时3", "实时4"]);
});

test("activation atomically rejects a partially invalid multi-skill bundle and allows five valid IDs", async () => {
    let notifications = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => Array.from({ length: 5 }, (_, index) => skill(index + 1)),
        fetchSkill: async (id) => ({ ...skill(id), systemPrompt: id === 5 && notifications === 0 ? "" : `完整正文${id}` }),
        onSkillsActivated: () => { notifications++; },
    });
    await manager.executeTool("search_skills", {});
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1, 2, 3, 4, 5] })).ok, false);
    assert.deepEqual(manager.currentSelections, []);
    assert.equal(notifications, 0);
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1] })).ok, true);
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1, 2, 3, 4, 5] })).ok, true);
    assert.equal(manager.currentSelections.length, 5);
});

test("large activated bodies keep lazy readable parts and the discovery manager uses the current library", async () => {
    const body = `### 文件：SKILL.md\n${"完整步骤。".repeat(5000)}\n### 文件：references/style.md\n色彩与光线参考`;
    const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => [skill(1)], fetchSkill: async () => ({ ...skill(1), systemPrompt: body }) });
    await manager.executeTool("search_skills", {});
    const result = await manager.executeTool("activate_skills", { skillIds: [1] });
    assert.equal(result.ok, true);
    assert.ok(manager.activeSkillContents[0].content.length <= 12_000);
    assert.match(manager.activeSkillContents[0].content, /技能正文按需读取/);
    const first = await manager.executeTool("read_skill_file", { skillId: "1", path: "SKILL.md" });
    assert.equal(first.ok, true);
    assert.equal(first.fullyRead, false);
    assert.equal(first.readOnly, true);
    assert.equal(first.nextPath, "SKILL.part-002.md");
    assert.equal((await manager.executeTool("read_skill_file", { skillId: "1", path: first.nextPath })).ok, true);
    assert.equal((await manager.executeTool("read_skill_file", { skillId: "1", path: "references/style.md" })).content, "### 文件：references/style.md\n色彩与光线参考");
});

test("fresh activation resets required main-file reads and replacing a long skill with an inline skill clears the gate", async () => {
    const long = { ...skill(1), systemPrompt: "长".repeat(25_000) };
    const short = skill(2);
    const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => [long, short], fetchSkill: async (id) => id === 1 ? long : short });
    assert.equal(manager.unreadRequiredFiles.length, 0);
    await manager.executeTool("search_skills", {});
    const initialActivation = await manager.executeTool("activate_skills", { skillIds: [1] });
    const initial = ["SKILL.md", "SKILL.part-002.md", "SKILL.part-003.md"].map((path) => ({ skillId: "1", path }));
    assert.deepEqual(initialActivation.unreadRequiredFiles, initial);
    assert.deepEqual(manager.unreadRequiredFiles, initial);
    assert.match(initialActivation.message!, /读完unreadRequiredFiles列出的所有主文件parts/);
    manager.unreadRequiredFiles[0].path = "外部修改";
    assert.deepEqual(manager.unreadRequiredFiles, initial);
    for (const file of initial) assert.equal((await manager.executeTool("read_skill_file", file)).ok, true);
    assert.deepEqual(manager.unreadRequiredFiles, []);
    const reactivated = await manager.executeTool("activate_skills", { skillIds: [1] });
    assert.deepEqual(reactivated.unreadRequiredFiles, initial);
    assert.deepEqual(manager.unreadRequiredFiles, initial);
    const inlineActivation = await manager.executeTool("activate_skills", { skillIds: [2] });
    assert.deepEqual(inlineActivation.unreadRequiredFiles, []);
    assert.deepEqual(manager.unreadRequiredFiles, []);
    assert.match(inlineActivation.message!, /完整正文已内联/);
    assert.match(inlineActivation.message!, /无需为使用技能而重复调用read_skill_file/);
});

test("manual preload exposes all unread main files and a same-set manual reload resets their read progress", async () => {
    const source = `### 文件：SKILL.md\n${"长".repeat(13_000)}\n### 文件：nested/SKILL.md\n${"根".repeat(13_000)}`;
    const manager = await createCanvasAgentSkillDiscovery({
        manualSelections: [selection(1)], fetchCatalogue: async () => [], fetchSkill: async () => ({ ...skill(1), systemPrompt: source }),
    });
    const initial = manager.unreadRequiredFiles;
    assert.deepEqual(initial.map((file) => file.path), ["SKILL.md", "SKILL.part-002.md", "nested/SKILL.md", "nested/SKILL.part-002.md"]);
    await manager.executeTool("read_skill_file", initial[0]);
    assert.deepEqual(manager.unreadRequiredFiles, initial.slice(1));
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1] })).ok, true);
    assert.deepEqual(manager.unreadRequiredFiles, initial);
});

test("cancellation before creation and during catalogue reads throws AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createCanvasAgentSkillDiscovery({
        signal: controller.signal, fetchCatalogue: async () => [], fetchSkill: async (id) => skill(id),
    }), { name: "AbortError" });
    const searchController = new AbortController();
    const pending = deferred<SkillOption[]>();
    const manager = await createCanvasAgentSkillDiscovery({ signal: searchController.signal, fetchCatalogue: () => pending.promise, fetchSkill: async (id) => skill(id) });
    const search = manager.executeTool("search_skills", {});
    searchController.abort();
    pending.resolve([skill(1)]);
    await assert.rejects(search, { name: "AbortError" });
    await assert.rejects(manager.executeTool("read_skill_file", { skillId: "1", path: "SKILL.md" }), { name: "AbortError" });
    const abortFromFetch = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => { const error = new Error("取消请求"); error.name = "AbortError"; throw error; }, fetchSkill: async (id) => skill(id),
    });
    await assert.rejects(abortFromFetch.executeTool("search_skills", {}), { name: "AbortError" });
});

test("cancellation while fetching details preserves the active bundle and does not notify", async () => {
    const controller = new AbortController();
    const pending = deferred<SkillOption>();
    let notifications = 0;
    const manager = await createCanvasAgentSkillDiscovery({
        signal: controller.signal, fetchCatalogue: async () => [skill(1), skill(2)],
        fetchSkill: async (id, _type, signal) => { assert.equal(signal, controller.signal); return id === 1 ? skill(1) : pending.promise; },
        onSkillsActivated: () => { notifications++; },
    });
    await manager.executeTool("search_skills", {});
    await manager.executeTool("activate_skills", { skillIds: [1] });
    const activating = manager.executeTool("activate_skills", { skillIds: [2] });
    controller.abort();
    pending.resolve(skill(2));
    await assert.rejects(activating, { name: "AbortError" });
    assert.deepEqual(manager.currentSelections.map((entry) => entry.id), [1]);
    assert.match(manager.activeSkillContents[0].content, /完整正文1/);
    assert.equal(notifications, 1);
});

test("notification failures do not report a committed activation as failed", async () => {
    for (const onSkillsActivated of [
        () => { throw new Error("同步UI通知失败"); },
        async () => { throw new Error("异步UI通知失败"); },
    ]) {
        const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => [skill(1)], fetchSkill: async (id) => skill(id), onSkillsActivated });
        await manager.executeTool("search_skills", {});
        const result = await manager.executeTool("activate_skills", { skillIds: [1] });
        assert.equal(result.ok, true);
        assert.match(String(result.notificationWarning), /状态通知失败/);
        assert.deepEqual(manager.currentSelections.map((entry) => entry.id), [1]);
        assert.equal((await manager.executeTool("read_skill_file", { skillId: "1", path: "SKILL.md" })).content, "完整正文1");
    }
});

test("cancellation after the activation commit cannot leave host and manager with different active sets", async () => {
    const controller = new AbortController();
    const notification = deferred<void>();
    const notified = deferred<void>();
    let hostSelections: number[] = [];
    const manager = await createCanvasAgentSkillDiscovery({
        signal: controller.signal, fetchCatalogue: async () => [skill(1)], fetchSkill: async (id) => skill(id),
        onSkillsActivated: (selected) => { hostSelections = selected.map((entry) => entry.id); notified.resolve(); return notification.promise; },
    });
    await manager.executeTool("search_skills", {});
    const activating = manager.executeTool("activate_skills", { skillIds: [1] });
    await notified.promise;
    assert.deepEqual(manager.currentSelections.map((entry) => entry.id), hostSelections);
    controller.abort();
    notification.resolve();
    assert.equal((await activating).ok, true);
    assert.deepEqual(manager.currentSelections.map((entry) => entry.id), [1]);
    assert.deepEqual(hostSelections, [1]);
});

test("long skills are labeled, ranked after equally matching focused ones, and at most one is auto-activated", async () => {
    const catalogue = [
        { ...skill(1, "动漫导演长篇", "video", "动漫短片"), promptLength: 120000 },
        { ...skill(2, "动漫导演精炼", "video", "动漫短片"), promptLength: 4000 },
        { ...skill(3, "动漫分镜长篇", "video", "动漫分镜"), promptLength: 80000 },
    ];
    const manager = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => catalogue, fetchSkill: async (id) => catalogue.find((entry) => entry.id === id)! });
    const searched = await manager.executeTool("search_skills", { query: "动漫导演" });
    const found = searched.skills as { id: number; length?: string }[];
    assert.deepEqual(found.slice(0, 2).map((entry) => entry.id), [2, 1], "focused skill first on equal score");
    assert.equal(found.find((entry) => entry.id === 1)?.length, "长篇（约12万字）");
    await manager.executeTool("search_skills", {});
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1, 3] })).code, "skill_too_long");
    assert.equal((await manager.executeTool("activate_skills", { skillIds: [1, 2] })).ok, true);
});
