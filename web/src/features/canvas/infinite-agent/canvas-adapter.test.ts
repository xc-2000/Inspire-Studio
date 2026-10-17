import assert from "node:assert/strict";
import test from "node:test";

import { createBackgroundNode, createImageNode, createTextNode, createVideoCompositionNode, createVideoNode } from "../constants";
import type { CanvasVideoCompositionNode, CanvasVideoNode } from "../types";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import type { CanvasAgentAction, CanvasAgentActionName } from "./upstream/canvas-agent-tools";
import type { CanvasAgentState } from "./upstream/types";
import { filmStoryFixture } from "./film-story-plan-fixture";
import { recordOneSentenceFilmAction, type OneSentenceFilm } from "./one-sentence-film";
import { buildInfiniteCanvasContext, executeInfiniteCanvasAction, supportedCanvasAgentTools, type InfiniteCanvasActionOptions, type InfiniteCanvasConfig } from "./canvas-adapter";

const state: CanvasAgentState = { phase: "script", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
test("Agent requests native video audio by default without enabling standalone speech or inventing model capabilities", () => {
    const context = buildInfiniteCanvasContext(snapshot(), state, config);
    assert.equal(context.generation.videoGenerateAudio, "true");
    assert.equal(context.generation.videoSupportsAudio, undefined);
    assert.equal(context.generation.audioModel, "");
    assert.equal(supportedCanvasAgentTools.some(tool => tool.function.name === "generate_audio"), false);
});
const config: InfiniteCanvasConfig = { model: "text-model", textModel: "text-model", imageModel: "image-model", videoModel: "video-model", size: "16:9", quality: "high", imageResolution: "2K", videoSeconds: "5", vquality: "720p", videoGenerationMode: "image-to-video" };
const text = (id: string, content = id) => ({ ...createTextNode({ id, title: id, position: { x: 0, y: 0 } }), content: { text: content, fontSize: 14 } });
const image = (id: string) => ({ ...createImageNode({ id, title: id, position: { x: 0, y: 0 } }), content: { source: `https://r2.example.com/${id}.png`, storageKey: id } });
const video = (id: string): CanvasVideoNode => ({ ...createVideoNode({ id, title: id, position: { x: 0, y: 0 } }), execution: { phase: "succeeded" }, content: { source: `https://r2.example.com/${id}.mp4`, storageKey: `video:${id}` } });
const composition = (id: string, sourceIds: string[], phase: "idle" | "running" | "succeeded" | "failed" = "idle", resultId?: string): CanvasVideoCompositionNode => ({
    ...createVideoCompositionNode({ id, title: id, position: { x: 0, y: 0 } }),
    execution: { phase, ...(phase === "running" ? { taskId: "composition-task", progress: 42 } : {}) },
    composition: { inputVideoNodeIds: sourceIds, inputStorageKeys: sourceIds.map((id) => `video:${id}`), ...(resultId ? { resultVideoNodeId: resultId } : {}) },
});

function snapshot(): CanvasAgentSnapshot { return { projectId: "project-1", title: "测试画布", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } }; }
function action(name: CanvasAgentActionName, args: Record<string, unknown> = {}): CanvasAgentAction { return { id: "call-1", name, arguments: args }; }
function fixture(initial = snapshot(), overrides: InfiniteCanvasConfig = {}) {
    let current = initial;
    let nextId = 0;
    const calls: CanvasAgentOp[][] = [];
    const options: InfiniteCanvasActionOptions = {
        getSnapshot: () => current,
        config: { ...config, ...overrides },
        createId: () => String(++nextId),
        onApplyOps: async (ops) => {
            calls.push(ops || []);
            current = applyCanvasAgentOps(current, ops);
            return { snapshot: current };
        },
    };
    return { options, calls, get current() { return current; }, run: (name: CanvasAgentActionName, args?: Record<string, unknown>) => executeInfiniteCanvasAction(action(name, args), options) };
}

test("two-stage film tools persist frozen plan and create exact shared-asset graph without spending", async () => {
    const f = fixture(snapshot(), { filmPlanning: true, videoSeconds: "10", autoGenerateMedia: false });
    const { plan, clips } = filmStoryFixture();
    assert.equal((await f.run("create_film_workflow", { clips })).code, "film_story_plan_required");
    const planned = await f.run("plan_film_story", plan);
    assert.equal(planned.ok, true, planned.message);
    assert.equal(f.calls.length, 0);
    const empty: OneSentenceFilm = { brief: "一键成片 雨夜归航", status: "running", nodeIds: [], pipelineMode: "full" };
    let film = recordOneSentenceFilmAction(empty, action("plan_film_story", plan), planned, new Set(), []);
    assert.deepEqual(film.storyPlan, plan);
    f.options.filmStoryPlan = film.storyPlan;
    const created = await f.run("create_film_workflow", { clips });
    assert.equal(created.ok, true, created.message);
    film = recordOneSentenceFilmAction(film, action("create_film_workflow", { clips }), created, new Set(), f.current.nodes);
    assert.equal(film.workflow?.productionVersion, "tapcanvas-adapted/v1");
    assert.equal(film.workflow?.assets?.length, 1);
    assert.equal(film.workflow?.shots.length, 4);
    f.options.filmWorkflow = film.workflow;
    const before = f.calls.length;
    assert.equal((await f.run("run_film_workflow")).status, "planned");
    assert.equal((await f.run("create_film_workflow", { clips })).reused, true);
    assert.equal(f.calls.length, before);
    assert.equal(f.calls.flat().some(op => op.type === "run_generation"), false);
    const generation = buildInfiniteCanvasContext(f.current, state, f.options.config).generation;
    assert.equal(generation.videoSeconds, "");
    assert.ok(generation.filmPlanning?.videoDuration.options.includes(7));
    assert.equal(buildInfiniteCanvasContext(f.current, state, { ...f.options.config, filmPlanning: false }).generation.videoSeconds, "10");
});

test("film planning refuses unsupported provider seconds before storing a plan or creating nodes", async () => {
    const f = fixture(snapshot(), { filmPlanning: true, apiFormat: "muse", videoModel: "sora-2" });
    const result = await f.run("plan_film_story", filmStoryFixture().plan);
    assert.equal(result.code, "unsupported_video_duration");
    assert.equal(f.calls.length, 0);
});

test("film planning requires a frozen aspect ratio before spending and applies it across the graph", async () => {
    const f = fixture(snapshot(), { filmPlanning: true, size: "1:1", imageSize: "1:1", videoSize: "1:1", autoGenerateMedia: false });
    const { plan, clips } = filmStoryFixture();
    const { aspectRatio: _ratio, ...missingRatio } = plan;
    const rejected = await f.run("plan_film_story", missingRatio);
    assert.equal(rejected.ok, false);
    assert.match(rejected.message || "", /aspectRatio/);
    assert.equal(f.calls.length, 0);
    const planned = await f.run("plan_film_story", { ...plan, aspectRatio: "16:9" });
    assert.equal(planned.ok, true, planned.message);
    f.options.filmStoryPlan = planned.storyPlan as typeof plan;
    const created = await f.run("create_film_workflow", { clips });
    assert.equal(created.ok, true, created.message);
    const media = f.current.nodes.filter(node => node.kind === "image" || node.kind === "video");
    assert.equal(media.length, 9);
    for (const node of media) assert.equal(node.generation?.size, "16:9", node.title);
    assert.equal(f.calls.flat().some(op => op.type === "run_generation"), false);
});

test("context prioritizes selected, approved, references and running nodes with bounded media-safe content", () => {
    const input = snapshot();
    input.nodes = Array.from({ length: 140 }, (_, index) => text(`node-${index}`));
    const running = { ...image("running"), content: { source: "data:image/png;base64,private-media" }, execution: { phase: "running" as const, taskId: "real-task", progress: 45 } };
    input.nodes.push(running);
    input.selectedNodeIds = ["node-139", "deleted"];
    input.connections = [{ id: "real-edge", source: { nodeId: "node-138" }, target: { nodeId: "node-139" } }];
    const context = buildInfiniteCanvasContext(input, { ...state, approvedNodeIds: ["node-137", "deleted"], referenceNodeIds: ["running"] }, { ...config, apiKey: "private-key", channels: [{ id: "secret-channel", name: "secret", apiKey: "channel-secret", baseUrl: "https://provider.example", apiFormat: "openai", models: [] }] });
    assert.equal(context.nodes.length, 120);
    assert.equal(context.nodes[0].id, "node-139");
    assert.ok(context.nodes.some((node) => node.id === "node-137"));
    assert.ok(context.nodes.some((node) => node.id === "node-138"));
    assert.deepEqual(context.selectedNodeIds, ["node-139"]);
    assert.deepEqual(context.agentState.approvedNodeIds, ["node-137"]);
    assert.equal(context.nodes.find((node) => node.id === "running")?.hasMedia, true);
    assert.equal(context.nodes.find((node) => node.id === "running")?.mediaUrl, undefined);
    assert.deepEqual(context.connections, [{ id: "real-edge", fromNodeId: "node-138", toNodeId: "node-139" }]);
    assert.equal(context.tasks[0].taskId, "real-task");
    assert.equal(context.tasks[0].status, "loading");
    assert.doesNotMatch(JSON.stringify(context), /private-media|private-key|channel-secret/);
});

test("queries search beyond context budget, paginate and read actual long scripts with truncation marker", async () => {
    const input = snapshot();
    input.nodes = Array.from({ length: 145 }, (_, index) => text(`n-${index}`, `剧本 ${index}`));
    input.nodes.push(text("long", "字".repeat(35000)));
    const f = fixture(input);
    const query = await f.run("query_canvas_nodes", { keyword: "剧本", page: 8, pageSize: 20 });
    assert.equal(query.total, 145);
    assert.equal((query.items as unknown[]).length, 5);
    const byId = await f.run("query_canvas_nodes", { keyword: "n-144" });
    assert.equal(byId.total, 1);
    const read = await f.run("get_node", { nodeId: "long" });
    const readNode = read.node as { text: string; textTruncated: boolean; fullTextLength: number };
    assert.equal(readNode.text.length, 32000);
    assert.equal(readNode.textTruncated, true);
    assert.equal(readNode.fullTextLength, 35000);
    assert.equal(f.calls.length, 0);
});

test("reads selected nodes, direct upstream/downstream and true task failure", async () => {
    const input = snapshot();
    input.nodes = [text("script"), { ...image("result"), execution: { phase: "failed", taskId: "failed-task", errorMessage: "provider rejected" } }, text("child")];
    input.selectedNodeIds = ["result"];
    input.connections = [{ id: "a", source: { nodeId: "script" }, target: { nodeId: "result" } }, { id: "b", source: { nodeId: "result" }, target: { nodeId: "child" } }];
    const f = fixture(input);
    const connected = await f.run("get_connected_nodes", { nodeId: "result" });
    assert.deepEqual((connected.upstream as { id: string }[]).map((node) => node.id), ["script"]);
    assert.deepEqual((connected.downstream as { id: string }[]).map((node) => node.id), ["child"]);
    const selected = await f.run("get_selected_nodes");
    assert.equal((selected.nodes as { id: string }[])[0].id, "result");
    const task = await f.run("get_media_task_status", { nodeId: "result" });
    assert.equal(task.status, "error");
    assert.equal(task.taskId, "failed-task");
    assert.equal(task.error, "provider rejected");
    assert.equal((await f.run("get_generation_task", { nodeId: "script" })).code, "not_media_node");
});

test("text creation/update/delete use actual ops and return generated IDs", async () => {
    const input = snapshot(); input.nodes = [text("source")];
    const f = fixture(input);
    const created = await f.run("create_primary_script_node", { title: "主剧本", content: "剧本全文", projectTitle: "电影", sourceNodeIds: ["source"] });
    assert.equal(created.nodeId, "text-1");
    assert.deepEqual(created.connectionIds, ["2"]);
    assert.equal(f.current.nodes.find((node) => node.id === "text-1")?.frame.width, 520);
    await f.run("update_text_node", { nodeId: "text-1", title: "修改剧本", content: "新的全文" });
    assert.equal(f.current.nodes.find((node) => node.id === "text-1")?.title, "修改剧本");
    const deleted = await f.run("delete_node", { nodeId: "text-1" });
    assert.deepEqual(deleted.deletedNodeIds, ["text-1"]);
    assert.equal(f.current.connections.length, 0);
});

test("missing IDs, wrong node types and unlisted arbitrary fields never mutate", async () => {
    const input = snapshot(); input.nodes = [image("image")];
    const f = fixture(input);
    assert.equal((await f.run("create_text_node", { title: "text", content: "body", sourceNodeIds: ["missing"] })).code, "node_not_found");
    assert.equal((await f.run("update_text_node", { nodeId: "image", content: "body" })).code, "invalid_node_type");
    assert.equal((await f.run("update_node", { nodeId: "image", title: "rename", content: "overwrite media" })).code, "invalid_parameter");
    assert.equal((await f.run("create_connection", { fromNodeId: "image", toNodeId: "image" })).code, "self_connection");
    assert.equal(f.calls.length, 0);
});

test("connection creation is idempotent and deletion checks existence", async () => {
    const input = snapshot(); input.nodes = [text("a"), text("b")];
    const f = fixture(input);
    const first = await f.run("create_connection", { fromNodeId: "a", toNodeId: "b" });
    const second = await f.run("create_connection", { fromNodeId: "a", toNodeId: "b" });
    assert.equal(second.alreadyExists, true);
    assert.equal(second.connectionId, first.connectionId);
    assert.equal(f.current.connections.length, 1);
    assert.equal((await f.run("delete_connection", { connectionId: String(first.connectionId) })).ok, true);
    assert.equal((await f.run("delete_connection", { connectionId: "missing" })).code, "connection_not_found");
});

test("groups create real background boards, arrange members together and delete through cascading reducer", async () => {
    const input = snapshot();
    input.nodes = [text("a"), { ...text("b"), frame: { ...text("b").frame, position: { x: 400, y: 80 } } }, { ...text("c"), frame: { ...text("c").frame, position: { x: 10, y: 20 } } }];
    const f = fixture(input);
    const group = await f.run("create_group", { title: "场景", nodeIds: ["a", "b"] });
    assert.equal(group.groupId, "background-1");
    const board = f.current.nodes.find((node) => node.id === group.groupId);
    assert.ok(board?.kind === "background");
    assert.deepEqual(board.memberNodeIds, ["a", "b"]);
    const oldDelta = f.current.nodes[1].frame.position.x - f.current.nodes[0].frame.position.x;
    await f.run("arrange_nodes");
    assert.equal(f.current.nodes[1].frame.position.x - f.current.nodes[0].frame.position.x, oldDelta);
    assert.equal((await f.run("create_group", { nodeIds: ["a", "c"] })).code, "invalid_group");
    const deleted = await f.run("delete_node", { nodeId: String(group.groupId) });
    assert.deepEqual(new Set(deleted.deletedNodeIds as string[]), new Set(["a", "b", "background-1"]));
    assert.deepEqual(f.current.nodes.map((node) => node.id), ["c"]);
});

test("state tools validate references and require actual persistence", async () => {
    const input = snapshot(); input.nodes = [text("plan")];
    const f = fixture(input);
    assert.equal((await f.run("set_agent_state", { phase: "script" })).code, "state_storage_unavailable");
    let saved: Partial<CanvasAgentState> | undefined;
    f.options.setAgentState = (patch) => { saved = patch; };
    assert.equal((await f.run("set_agent_state", { phase: "references", approvedNodeIds: ["plan"] })).ok, true);
    assert.deepEqual(saved, { phase: "references", approvedNodeIds: ["plan"] });
    assert.equal((await f.run("set_agent_state", { phase: "references", referenceNodeIds: ["missing"] })).code, "node_not_found");
    assert.equal((await f.run("set_agent_state", { phase: "audio" })).code, "unsupported_phase");
});

test("image edit connects references in order and keeps configured model and selected styles", async () => {
    const input = snapshot(); input.nodes = [image("ref-b"), text("script"), image("ref-a")];
    const styles = [{ id: 7, name: "胶片", generationType: "image" as const, stylePrompt: "film" }, { id: 8, name: "电影", generationType: "video" as const, stylePrompt: "cinema" }];
    const f = fixture(input, { generationStyleIdsByType: { image: [7], video: [8] }, styleSnapshots: styles });
    const result = await f.run("edit_image", { prompt: "保持两张图片的主体", sourceNodeIds: ["ref-a", "script", "ref-b"], count: 2 });
    assert.equal(result.nodeId, "image-1");
    const node = f.current.nodes.find((item) => item.id === "image-1"); assert.ok(node?.kind === "image");
    assert.equal(node.generation.model, "image-model");
    assert.deepEqual(node.generation.references, ["https://r2.example.com/ref-a.png", "https://r2.example.com/ref-b.png"]);
    assert.equal(node.generation.operation, "edit");
    assert.equal(node.generation.count, 2);
    assert.deepEqual(node.generation.generationStyleIds, [7]);
    assert.deepEqual(f.current.connections.map((edge) => edge.source.nodeId), ["ref-a", "script", "ref-b"]);
    const run = f.calls[0].find((op) => op.type === "run_generation");
    assert.deepEqual(run?.generationStyleIds, [7]);
    assert.deepEqual(run?.generationStyleSnapshots, [styles[0]]);
});

test("media placeholders honor auto-generation off and no source silently comes from selection", async () => {
    const input = snapshot(); input.nodes = [image("selected")]; input.selectedNodeIds = ["selected"];
    const f = fixture(input, { autoGenerateMedia: false });
    const result = await f.run("generate_image", { prompt: "独立画面", sourceNodeIds: [] });
    assert.equal(result.ok, true);
    assert.equal(result.status, "idle");
    assert.equal(f.current.connections.length, 0);
    assert.equal(f.calls[0].some((op) => op.type === "run_generation"), false);
});

test("image edit rejects missing or unfinished media before creating or dispatching", async () => {
    const input = snapshot(); input.nodes = [text("text"), { ...image("running"), execution: { phase: "running" } }];
    const f = fixture(input);
    assert.equal((await f.run("edit_image", { prompt: "编辑", sourceNodeIds: ["text"] })).code, "image_reference_required");
    assert.equal((await f.run("generate_image", { prompt: "编辑", sourceNodeIds: ["running"] })).code, "media_reference_unavailable");
    assert.equal(f.calls.length, 0);
});

test("video uses configured duration/mode/model and refuses an image model fallback", async () => {
    const input = snapshot(); input.nodes = [image("ref")];
    const f = fixture(input, { videoModel: "muse::sora-2", videoSeconds: "10", channels: [{ id: "muse", name: "Muse", baseUrl: "https://example.com", apiKey: "never-expose", apiFormat: "muse", models: ["sora-2"] }] });
    const rejected = await f.run("generate_video", { prompt: "动画", sourceNodeIds: ["ref"], seconds: 5 });
    assert.equal(rejected.code, "unsupported_video_duration");
    assert.equal(f.calls.length, 0);
    const result = await f.run("generate_video", { prompt: "动画", sourceNodeIds: ["ref"], model: "model-hallucination" });
    assert.equal(result.ok, true);
    const node = f.current.nodes.find((item) => item.kind === "video"); assert.ok(node?.kind === "video");
    assert.equal(node.generation.seconds, "10");
    assert.equal(node.generation.model, "muse::sora-2");
    assert.equal(node.generation.videoGenerationMode, "image-to-video");
    const noVideo = fixture(snapshot(), { model: "image-model", videoModel: "" });
    assert.equal((await noVideo.run("generate_video", { prompt: "动画", sourceNodeIds: [] })).code, "model_not_configured");
    assert.equal(buildInfiniteCanvasContext(snapshot(), state, noVideo.options.config).generation.videoModel, "");
});

test("generation configuration exposes actual duration constraints without provider secrets", async () => {
    const f = fixture(snapshot(), { videoModel: "muse::sora-2", videoSeconds: "10", apiFormat: "muse", apiKey: "private-secret" });
    const result = await f.run("get_generation_config");
    assert.deepEqual(result.videoDuration, { min: 10, max: 10, options: [10] });
    assert.doesNotMatch(JSON.stringify(result), /private-secret|apiKey/);
});

test("actual generation failures remain failed and request references are sanitized from protocol receipts", async () => {
    const f = fixture();
    f.options.onApplyOps = async (ops) => ({
        snapshot: { ...applyCanvasAgentOps(snapshot(), ops), nodes: applyCanvasAgentOps(snapshot(), ops).nodes.map((node) => ({ ...node, execution: { phase: "failed", taskId: "real-task", errorMessage: "服务商失败" } })) },
        result: { ok: false, message: "服务商失败", data: { actualArguments: { references: ["data:image/png;base64,secret-image"], apiKey: "secret-api-key" }, taskId: "real-task" } },
    });
    const result = await f.run("generate_image", { prompt: "生成", sourceNodeIds: [] });
    assert.equal(result.ok, false);
    assert.equal(result.nodeId, "image-1");
    assert.equal(result.taskId, "real-task");
    assert.doesNotMatch(JSON.stringify(result), /secret-image|secret-api-key/);
});

test("setting graph generation updates its locked node rather than creating duplicate nodes", async () => {
    const input = snapshot(); input.nodes = [image("target"), image("ref")];
    const f = fixture(input, { settingGraphNodeId: "target", settingGraphSkillSnapshot: { id: 9, name: "设定图", targetType: "canvasSettingGraph", systemPrompt: "四视图" } });
    const result = await f.run("generate_image", { prompt: "角色四视图", sourceNodeIds: ["ref"] });
    assert.equal(result.nodeId, "target");
    assert.equal(f.current.nodes.length, 2);
    assert.equal(f.calls[0].some((op) => op.type === "add_node"), false);
    assert.equal(f.calls[0].find((op) => op.type === "run_generation")?.nodeId, "target");
});

test("missing speech model, unsupported arguments and cancellation cannot dispatch a generation", async () => {
    const f = fixture();
    assert.equal(supportedCanvasAgentTools.some((tool) => tool.function.name === "read_skill_file"), false);
    assert.equal(supportedCanvasAgentTools.some((tool) => tool.function.name === "generate_audio"), false);
    assert.equal((await f.run("generate_audio", { prompt: "read", sourceNodeIds: [] })).code, "unsupported_tool");
    assert.equal((await f.run("generate_video", { prompt: "read", sourceNodeIds: [], generateAudio: true })).code, "invalid_parameter");
    const controller = new AbortController(); controller.abort(); f.options.signal = controller.signal;
    await assert.rejects(f.run("create_text_node", { title: "text", content: "text" }), { name: "AbortError" });
    assert.equal(f.calls.length, 0);
    const during = new AbortController(); f.options.signal = during.signal;
    f.options.onApplyOps = async (ops, signal) => { assert.equal(signal, during.signal); during.abort(); return { snapshot: applyCanvasAgentOps(snapshot(), ops) }; };
    await assert.rejects(f.run("create_text_node", { title: "text", content: "text" }), { name: "AbortError" });
});

test("canvas speech stays unavailable even when the global model exists", async () => {
    const f = fixture(snapshot(), { audioModel: "grok-voice-latest" });
    assert.equal((await f.run("generate_audio", { prompt: "台词", sourceNodeIds: [] })).code, "unsupported_tool");
    assert.equal(f.calls.length, 0);
    assert.equal(buildInfiniteCanvasContext(snapshot(), state, f.options.config).generation.audioModel, "");
    const result = await f.run("get_generation_config");
    assert.equal((result.speech as { available: boolean }).available, false);
});

test("new film graphs do not create speech nodes despite a global speech model and planned dialogue", async () => {
    const f = fixture(snapshot(), { audioModel: "grok-voice-latest" });
    const { plan, clips } = filmStoryFixture([5]);
    f.options.filmStoryPlan = plan;
    const result = await f.run("create_film_workflow", { clips });
    assert.equal(result.ok, true, result.message);
    assert.equal(f.current.nodes.some(node => node.kind === "audio"), false);
    assert.equal(f.calls.flat().some(op => op.type === "run_speech"), false);
});

test("composition creates ordered connections, waits for a persisted result and reuses repeated requests", async () => {
    let current = { ...snapshot(), nodes: [video("a"), video("b")] } as CanvasAgentSnapshot;
    const f = fixture(current);
    f.options.getSnapshot = () => current;
    let submissions = 0;
    f.options.onApplyOps = async (ops) => {
        submissions++;
        const create = ops?.find((op) => op.type === "add_node");
        assert.equal(create?.nodeType, "videoComposition");
        assert.equal(create?.title, "测试成片");
        assert.deepEqual(ops?.filter((op) => op.type === "connect_nodes").map((op) => op.sourceNodeId), ["b", "a"]);
        assert.deepEqual(ops?.at(-1), { type: "run_composition", nodeId: create?.id });
        current = { ...current, nodes: [...current.nodes, composition(create!.id!, ["b", "a"], "succeeded", "final"), video("final")] };
        return { snapshot: current, result: { ok: true, message: "合成完成", data: { nodeId: "final", compositionNodeId: create!.id, taskId: "real-task", status: "success" } } };
    };
    const result = await f.run("compose_videos", { sourceNodeIds: ["b", "a"], title: "测试成片" });
    assert.equal(result.ok, true);
    assert.equal(result.nodeId, "final");
    assert.equal(result.compositionNodeId, "composition-1");
    assert.equal(result.taskId, "real-task");
    assert.equal(result.status, "success");
    assert.equal(result.storageKey, "video:final");
    assert.deepEqual(result.sourceNodeIds, ["b", "a"]);
    const repeat = await f.run("compose_videos", { sourceNodeIds: ["b", "a"] });
    assert.equal(repeat.ok, true);
    assert.equal(repeat.nodeId, "final");
    assert.equal(repeat.reused, true);
    assert.equal(submissions, 1);
});

test("failed, running, unsaved, missing or nonvideo inputs never submit a composition", async () => {
    const variants = [
        { ...video("b"), execution: { phase: "failed" as const } },
        { ...video("b"), execution: { phase: "running" as const } },
        { ...video("b"), execution: { phase: "idle" as const } },
        { ...video("b"), content: { source: "https://r2.example.com/b.mp4" } },
        { ...video("b"), content: { source: "", storageKey: "video:b" } },
        { ...video("b"), content: { source: "blob:temporary", storageKey: "video:b" } },
        image("b"),
    ];
    for (const source of variants) {
        const input = snapshot(); input.nodes = [video("a"), source];
        const f = fixture(input);
        const result = await f.run("compose_videos", { sourceNodeIds: ["a", "b"] });
        assert.equal(result.ok, false);
        assert.equal(f.calls.length, 0);
    }
    const input = snapshot(); input.nodes = [video("a")];
    const f = fixture(input);
    assert.equal((await f.run("compose_videos", { sourceNodeIds: ["a", "deleted"] })).code, "node_not_found");
    assert.equal(f.calls.length, 0);
});

test("running and failed compositions reuse their node instead of creating duplicate tasks", async () => {
    for (const phase of ["running", "failed"] as const) {
        const input = snapshot(); input.nodes = [video("a"), video("b"), composition("existing", ["a", "b"], phase)];
        const f = fixture(input);
        let calls = 0;
        f.options.onApplyOps = async (ops) => {
            calls++;
            assert.deepEqual(ops, [{ type: "run_composition", nodeId: "existing" }]);
            return { snapshot: { ...input, nodes: [video("a"), video("b"), composition("existing", ["a", "b"], "succeeded", "result"), video("result")] } };
        };
        const result = await f.run("compose_videos", { sourceNodeIds: ["a", "b"] });
        assert.equal(result.ok, true);
        assert.equal(result.compositionNodeId, "existing");
        assert.equal(result.nodeId, "result");
        assert.equal(calls, 1);
    }
});

test("explicit composition IDs reject different inputs, ordering, editing options and deleted nodes", async () => {
    const input = snapshot();
    const edited = composition("edited", ["a", "b"]);
    edited.composition.editingOptions = { clips: [], subtitles: [], fontSize: 24 };
    input.nodes = [video("a"), video("b"), composition("existing", ["a", "b"]), edited];
    const f = fixture(input);
    assert.equal((await f.run("compose_videos", { sourceNodeIds: ["b", "a"], nodeId: "existing" })).code, "composition_sources_mismatch");
    assert.equal((await f.run("compose_videos", { sourceNodeIds: ["a", "b"], nodeId: "edited" })).code, "composition_sources_mismatch");
    assert.equal((await f.run("compose_videos", { sourceNodeIds: ["a", "b"], nodeId: "a" })).code, "composition_sources_mismatch");
    assert.equal((await f.run("compose_videos", { sourceNodeIds: ["a", "b"], nodeId: "deleted" })).code, "node_not_found");
    assert.equal(f.calls.length, 0);
});

test("host success without a successful persisted result cannot claim composition completion", async () => {
    for (const phase of ["running", "failed", "succeeded"] as const) {
        const input = snapshot(); input.nodes = [video("a"), video("b"), composition("existing", ["a", "b"], "running")];
        const f = fixture(input);
        f.options.onApplyOps = async () => ({
            snapshot: { ...input, nodes: [video("a"), video("b"), composition("existing", ["a", "b"], phase, "missing-result")] },
            result: { ok: true, message: "submitted", data: { status: "success", nodeId: "missing-result" } },
        });
        assert.equal((await f.run("compose_videos", { sourceNodeIds: ["a", "b"] })).ok, false);
    }
    const input = snapshot(); input.nodes = [video("a"), video("b"), composition("existing", ["a", "b"], "succeeded", "missing-result")];
    const f = fixture(input);
    assert.equal((await f.run("compose_videos", { sourceNodeIds: ["a", "b"] })).code, "composition_result_unavailable");
    assert.equal(f.calls.length, 0);
});

test("composition respects failed host receipts and reports true result media from task and context queries", async () => {
    const input = snapshot(); input.nodes = [video("a"), video("b"), composition("existing", ["a", "b"], "failed")];
    const f = fixture(input);
    f.options.onApplyOps = async () => ({ snapshot: input, result: { ok: false, message: "合成已取消", data: { status: "error", taskId: "canceled-task", apiKey: "never-expose" } } });
    const failed = await f.run("compose_videos", { sourceNodeIds: ["a", "b"] });
    assert.equal(failed.ok, false);
    assert.equal(failed.message, "合成已取消");
    assert.equal(failed.taskId, "canceled-task");
    assert.doesNotMatch(JSON.stringify(failed), /never-expose/);
    input.nodes = [video("a"), video("b"), composition("existing", ["a", "b"], "succeeded", "final"), video("final")];
    for (const name of ["get_media_task_status", "get_generation_task"] as const) {
        const task = await f.run(name, { nodeId: "existing" });
        assert.equal(task.ok, true);
        assert.equal(task.resultReady, true);
        assert.equal(task.resultVideoNodeId, "final");
        assert.equal(task.storageKey, "video:final");
        assert.equal(task.mediaUrl, "https://r2.example.com/final.mp4");
    }
    const context = buildInfiniteCanvasContext(input, state, config);
    const node = context.nodes.find((item) => item.id === "existing");
    assert.equal(node?.hasMedia, true);
    assert.equal(node?.mediaUrl, "https://r2.example.com/final.mp4");
});

test("legacy or stale successful compositions rebuild in the same node using current media versions", async () => {
    for (const recordedKeys of [undefined, ["video:a-old", "video:b"]]) {
        const input = snapshot();
        const previous = composition("existing", ["a", "b"], "succeeded", "old-final");
        previous.composition.inputStorageKeys = recordedKeys;
        input.nodes = [video("a"), video("b"), previous, video("old-final")];
        const f = fixture(input);
        const status = await f.run("get_media_task_status", { nodeId: "existing" });
        assert.equal(status.resultReady, false);
        let calls = 0;
        f.options.onApplyOps = async (ops) => {
            calls++;
            assert.deepEqual(ops, [{ type: "run_composition", nodeId: "existing" }]);
            return { snapshot: { ...input, nodes: [video("a"), video("b"), composition("existing", ["a", "b"], "succeeded", "new-final"), video("new-final")] } };
        };
        const result = await f.run("compose_videos", { sourceNodeIds: ["a", "b"] });
        assert.equal(result.ok, true);
        assert.equal(result.nodeId, "new-final");
        assert.equal(result.reused, false);
        assert.equal(calls, 1);
    }
});

test("running composition with replaced source media or no input snapshot cannot submit a duplicate task", async () => {
    for (const recordedKeys of [undefined, ["video:old-a", "video:b"]]) {
        const input = snapshot();
        const running = composition("existing", ["a", "b"], "running");
        running.composition.inputStorageKeys = recordedKeys;
        input.nodes = [video("a"), video("b"), running];
        const f = fixture(input);
        const result = await f.run("compose_videos", { sourceNodeIds: ["a", "b"] });
        assert.equal(result.ok, false);
        assert.equal(result.code, "composition_sources_stale");
        assert.equal(result.taskId, "composition-task");
        assert.equal(f.calls.length, 0);
    }
});

test("composition result becomes unavailable when source media changes while the task is running", async () => {
    const input = snapshot(); input.nodes = [video("a"), video("b"), composition("existing", ["a", "b"], "running")];
    const f = fixture(input);
    f.options.onApplyOps = async () => ({
        snapshot: { ...input, nodes: [{ ...video("a"), content: { source: "https://r2.example.com/replacement.mp4", storageKey: "video:a-new" } }, video("b"), composition("existing", ["a", "b"], "succeeded", "final"), video("final")] },
        result: { ok: true, message: "合成完成" },
    });
    const result = await f.run("compose_videos", { sourceNodeIds: ["a", "b"] });
    assert.equal(result.ok, false);
    assert.equal(result.code, "composition_result_unavailable");
});


test("Agent context and tool expose the same configured duration choices for film and ordinary generation", async () => {
    for (const filmPlanning of [true, false]) {
        const f = fixture(snapshot(), { filmPlanning, videoSeconds: "10", videoModelBillingConfigurations: [{ model: "video-model", capabilities: ["image-to-video"], videoBillingConfiguration: { billingUnit: "second", minimumDurationSeconds: 30, supportedDurationsSeconds: [30], modePrices: {} } }] });
        const result = await f.run("get_generation_config");
        assert.deepEqual(result.videoDuration, { min: 30, max: 30, options: [30] });
        if (filmPlanning) {
            const context = buildInfiniteCanvasContext(f.current, state, f.options.config);
            assert.equal(context.generation.filmPlanning?.segmentPolicy.preferredSeconds, 30);
            assert.deepEqual(result.filmPlanning, context.generation.filmPlanning);
        }
    }
});
