import assert from "node:assert/strict";
import test from "node:test";

import {
    CANVAS_AGENT_ACTION_NAMES,
    CANVAS_AGENT_SKILL_DISCOVERY_TOOLS,
    CANVAS_AGENT_TOOLS,
    canvasAgentActionLabel,
    normalizeCanvasAgentAction,
    parseCanvasAgentJson,
} from "./canvas-agent-tools";

test("full film schema requires every shot's text, image, video and duration before execution", () => {
    const shot = { title: "镜头1", description: "茶铺开门", imagePrompt: "晨光中的茶铺", videoPrompt: "镜头慢慢推近茶铺", seconds: 5 };
    assert.equal(normalizeCanvasAgentAction("create_film_workflow", { title: "清晨", script: "清晨茶铺营业", shots: [shot] }).arguments.shots instanceof Array, true);
    for (const invalid of [{ ...shot, seconds: 0 }, { ...shot, imagePrompt: "" }, { ...shot, videoPrompt: "" }, { ...shot, extra: true }]) {
        assert.throws(() => normalizeCanvasAgentAction("create_film_workflow", { title: "清晨", script: "茶铺", shots: [invalid] }));
    }
    assert.throws(() => normalizeCanvasAgentAction("create_film_workflow", { title: "清晨", script: "茶铺", shots: [] }));
    assert.deepEqual(normalizeCanvasAgentAction("run_film_workflow", {}).arguments, {});
});

test("skill discovery schemas are host opt-ins with bounded numeric IDs", () => {
    assert.deepEqual(CANVAS_AGENT_SKILL_DISCOVERY_TOOLS.map((tool) => tool.function.name), ["search_skills", "activate_skills"]);
    for (const name of ["search_skills", "activate_skills"] as const) {
        assert.ok(CANVAS_AGENT_ACTION_NAMES.includes(name));
        assert.ok(!CANVAS_AGENT_TOOLS.some((tool) => tool.function.name === name));
    }
    const search = CANVAS_AGENT_SKILL_DISCOVERY_TOOLS[0].function.parameters;
    assert.equal(search.additionalProperties, false);
    assert.deepEqual(search.properties.targetType, { type: "string", enum: ["image", "video", "canvasSettingGraph"] });
    assert.deepEqual(search.properties.pageSize, { type: "integer", minimum: 1, maximum: 12 });
    const activate = CANVAS_AGENT_SKILL_DISCOVERY_TOOLS[1].function.parameters;
    assert.deepEqual(activate.required, ["skillIds"]);
    assert.deepEqual(activate.properties.skillIds, {
        type: "array", items: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, minItems: 1, maxItems: 5, uniqueItems: true,
    });
});

test("skill search normalizes defaults and rejects unsupported filters and pagination", () => {
    assert.deepEqual(normalizeCanvasAgentAction("search_skills", {}, "search").arguments, { page: 1, pageSize: 12 });
    assert.deepEqual(normalizeCanvasAgentAction("search_skills", { query: "  分镜  ", targetType: "video", page: 2, pageSize: 5 }).arguments,
        { query: "分镜", targetType: "video", page: 2, pageSize: 5 });
    for (const args of [
        { query: null }, { query: 3 }, { targetType: "all" }, { targetType: "" }, { targetType: null }, { targetType: "audio" },
        { page: 0 }, { page: -1 }, { page: 1.5 }, { page: "1" }, { page: Number.MAX_SAFE_INTEGER + 1 }, { page: Infinity },
        { pageSize: 0 }, { pageSize: 13 }, { pageSize: 1.5 }, { pageSize: "12" }, { pageSize: null }, { keyword: "分镜" },
    ]) assert.throws(() => normalizeCanvasAgentAction("search_skills", args));
    assert.equal(canvasAgentActionLabel(normalizeCanvasAgentAction("search_skills", {})), "正在搜索创作技能");
});

test("activation preserves numeric IDs and requires one to five unique positive safe integers", () => {
    assert.deepEqual(normalizeCanvasAgentAction("activate_skills", { skillIds: [7, 15, Number.MAX_SAFE_INTEGER] }).arguments,
        { skillIds: [7, 15, Number.MAX_SAFE_INTEGER] });
    for (const skillIds of [
        undefined, null, "7", [], [1, 2, 3, 4, 5, 6], [7, 7], ["7"], [0], [-1], [1.5], [Infinity], [NaN], [Number.MAX_SAFE_INTEGER + 1], [undefined], new Array(1),
    ]) assert.throws(() => normalizeCanvasAgentAction("activate_skills", { skillIds }));
    assert.throws(() => normalizeCanvasAgentAction("activate_skills", { skillIds: [7], targetType: "image" }));
    assert.equal(canvasAgentActionLabel(normalizeCanvasAgentAction("activate_skills", { skillIds: [7] })), "正在启用创作技能");
});

test("JSON fallback parses discovery tools and rejects a whole batch with invalid activation", async () => {
    const result = await parseCanvasAgentJson(JSON.stringify({ actions: [
        { id: "search", tool: "search_skills", arguments: { targetType: "image", pageSize: 3 } },
        { id: "activate", tool: "activate_skills", arguments: { skillIds: [7] } },
    ], reply: "" }));
    assert.equal(result.parsed, true);
    assert.deepEqual(result.actions.map((action) => ({ name: action.name, arguments: action.arguments })), [
        { name: "search_skills", arguments: { targetType: "image", page: 1, pageSize: 3 } },
        { name: "activate_skills", arguments: { skillIds: [7] } },
    ]);
    const invalid = await parseCanvasAgentJson(JSON.stringify({ actions: [
        { tool: "search_skills", arguments: {} }, { tool: "activate_skills", arguments: { skillIds: [7, 7] } },
    ] }));
    assert.equal(invalid.parsed, false);
    assert.deepEqual(invalid.actions, []);
    assert.match(invalid.error || "", /重复/);
});

test("composition tool exposes ordered inputs and validates IDs without silently deleting duplicates", () => {
    const definition = CANVAS_AGENT_TOOLS.find((tool) => tool.function.name === "compose_videos")!;
    assert.deepEqual(definition.function.parameters.required, ["sourceNodeIds"]);
    assert.deepEqual(definition.function.parameters.properties.sourceNodeIds, { type: "array", items: { type: "string" }, minItems: 2, maxItems: 20, uniqueItems: true });
    const normalized = normalizeCanvasAgentAction("compose_videos", { sourceNodeIds: [" b ", "a"], title: " 成片 ", nodeId: " composition-1 " });
    assert.deepEqual(normalized.arguments, { sourceNodeIds: ["b", "a"], title: "成片", nodeId: "composition-1" });
    assert.equal(canvasAgentActionLabel(normalized), "正在合成最终视频");
    for (const sourceNodeIds of [undefined, null, "a,b", [], ["a"], ["a", "a"], ["a", " a "], ["a", ""], ["a", 2], new Array(2), Array.from({ length: 21 }, (_, index) => String(index))]) {
        assert.throws(() => normalizeCanvasAgentAction("compose_videos", { sourceNodeIds }));
    }
    assert.throws(() => normalizeCanvasAgentAction("compose_videos", { sourceNodeIds: ["a", "b"], nodeId: " " }));
    assert.throws(() => normalizeCanvasAgentAction("compose_videos", { sourceNodeIds: ["a", "b"], skipFailed: true }));
});

test("composition JSON retains input order and rejects invalid composition without executing a partial batch", async () => {
    const result = await parseCanvasAgentJson(JSON.stringify({ actions: [{ tool: "compose_videos", arguments: { sourceNodeIds: ["v2", "v1"], title: "最终视频" } }], reply: "" }));
    assert.equal(result.parsed, true);
    assert.deepEqual(result.actions[0].arguments.sourceNodeIds, ["v2", "v1"]);
    const invalid = await parseCanvasAgentJson(JSON.stringify({ actions: [{ tool: "get_canvas_summary", arguments: {} }, { tool: "compose_videos", arguments: { sourceNodeIds: ["v1", "v1"] } }] }));
    assert.equal(invalid.parsed, false);
    assert.deepEqual(invalid.actions, []);
    assert.match(invalid.error || "", /重复/);
});
