import test from "node:test";
import assert from "node:assert/strict";
import type { CanvasConnection, CanvasNode } from "../types";
import { finishOneSentenceFilm, oneSentenceFilmPrompt, recordOneSentenceFilmAction, recordOneSentenceFilmOperations, resolveOneSentenceFilmRequest, type OneSentenceFilm } from "./one-sentence-film";

const film = (patch: Partial<OneSentenceFilm> = {}): OneSentenceFilm => ({ brief: "山间茶铺，一句话成片", nodeIds: [], status: "running", ...patch });
const video = (id: string, patch: Record<string, unknown> = {}): CanvasNode => ({
    id, kind: "video", title: id, execution: { phase: "succeeded" },
    content: { source: `https://media.test/${id}.mp4`, storageKey: `video:${id}` }, ...patch,
}) as CanvasNode;
const composition = (inputs: string[], result = "final"): CanvasNode => ({
    id: "composition", kind: "videoComposition", execution: { phase: "succeeded" },
    composition: { inputVideoNodeIds: inputs, inputStorageKeys: inputs.map(id => `video:${id}`), resultVideoNodeId: result },
}) as CanvasNode;

test("explicit film mode and natural commands are recognized without changing ordinary requests", () => {
    for (const input of ["【一句话成片】\n茶铺在雨中开门", "帮我一句话成片：茶铺的清晨", "一键成片，展现雪山日出"]) {
        const request = resolveOneSentenceFilmRequest(input);
        assert.equal(request?.resume, false);
        assert.deepEqual(request?.film.nodeIds, []);
        assert.equal(request?.film.status, "running");
        assert.equal(request?.film.pipelineMode, "full");
    }
    assert.equal(resolveOneSentenceFilmRequest("【一句话成片】\n茶铺在雨中开门")?.film.brief, "茶铺在雨中开门");
    for (const input of ["生成一段视频", "改一下镜头颜色", "介绍一句话成片功能", "不要一键成片，只写脚本", "一句话成片是什么意思", "支持一句话成片吗", "【一句话成片】\n不要成片，只写脚本", "继续成片"]) {
        assert.equal(resolveOneSentenceFilmRequest(input), undefined);
    }
});

test("only an explicit existing-clips request bypasses the full text-image-video pipeline", () => {
    for (const brief of ["只复用已有视频按顺序合成", "仅合成这些视频", "复用已有视频直接合成"]) {
        assert.equal(resolveOneSentenceFilmRequest(`【一句话成片】\n${brief}`)?.film.pipelineMode, "existing-clips");
    }
    assert.equal(resolveOneSentenceFilmRequest("【一句话成片】\n已有视频做参考，做一个雪山短片")?.film.pipelineMode, "full");
    const old = film({ nodeIds: ["old-video"], status: "interrupted" });
    assert.equal(resolveOneSentenceFilmRequest("继续成片", old)?.film.pipelineMode, undefined);
});

test("resume keeps the original brief and real node scope instead of starting another film", () => {
    const previous = film({ status: "interrupted", nodeIds: ["script", "shot-1"], resultNodeId: "final" });
    for (const message of ["继续成片", "【一句话成片】\n继续成片", "请恢复上次的成片"]) {
        const restored = resolveOneSentenceFilmRequest(message, previous)!;
        assert.equal(restored.resume, true);
        assert.deepEqual(restored.film, { ...previous, status: "running" });
        assert.notEqual(restored.film.nodeIds, previous.nodeIds);
    }
    const newFilm = resolveOneSentenceFilmRequest("【一句话成片】\n换一个故事", previous)!;
    assert.equal(newFilm.resume, false);
    assert.deepEqual(newFilm.film.nodeIds, []);
    assert.equal(newFilm.film.resultNodeId, undefined);
    assert.equal(resolveOneSentenceFilmRequest("生成一张图", previous), undefined);
});

test("scope records actual created nodes on failures and reused sources on composition", () => {
    const nodes = [video("old"), video("new", { execution: { phase: "failed" } }), composition(["old"]), video("final")];
    const scope = recordOneSentenceFilmAction(film(), {
        id: "compose", name: "compose_videos", arguments: { sourceNodeIds: ["old", "nonexistent"] },
    }, { ok: true, nodeId: "final", compositionNodeId: "composition" }, new Set(["old"]), nodes);
    assert.deepEqual(scope.nodeIds, ["new", "composition", "final", "old"]);
    assert.equal(scope.resultNodeId, "final");
    const interrupted = recordOneSentenceFilmAction(film(), {
        id: "generate", name: "generate_video", arguments: { sourceNodeIds: [] },
    }, undefined, new Set(["old"]), [video("old"), video("new")]);
    assert.deepEqual(interrupted.nodeIds, ["new"]);
});

test("resume with a follow-up sentence preserves the existing film graph", () => {
    const previous = film({ nodeIds: ["script", "shot", "composition"], status: "interrupted" });
    for (const text of ["继续成片。先把画幅设为16:9，再复用成功图片。", "【一句话成片】继续成片！只补失败视频", "恢复成片\n保持30秒"]) {
        const result = resolveOneSentenceFilmRequest(text, previous);
        assert.equal(result?.resume, true);
        assert.deepEqual(result?.film.nodeIds, previous.nodeIds);
        assert.equal(result?.film.brief, previous.brief);
    }
});

test("scope exposes reserved running nodes before long operations settle and never treats reservations as results", () => {
    const pending = recordOneSentenceFilmOperations(film(), [
        { type: "add_node", id: "script", nodeType: "text" },
        { type: "add_node", id: "image", nodeType: "image" },
        { type: "run_generation", nodeId: "image" },
        { type: "run_generation", nodeId: "video" },
        { type: "run_composition", nodeId: "composition" },
    ]);
    assert.deepEqual(pending.nodeIds, ["script", "image", "video", "composition"]);
    assert.equal(finishOneSentenceFilm(pending, []).film.status, "interrupted");
    assert.equal(finishOneSentenceFilm(pending, [video("video", { execution: { phase: "running" } })]).film.status, "interrupted");
});

test("failed placement removes only this action's never-created reservations after it settles", () => {
    const pending = recordOneSentenceFilmOperations(film({ nodeIds: ["historically-missing", "other-pending"] }), [
        { type: "add_node", id: "rejected-composition", nodeType: "videoComposition" },
        { type: "run_composition", nodeId: "rejected-composition" },
    ]);
    assert.ok(pending.nodeIds.includes("rejected-composition"));
    const settled = recordOneSentenceFilmAction(pending, {
        id: "compose", name: "compose_videos", arguments: { sourceNodeIds: ["clip"] },
    }, { ok: false, compositionNodeId: "rejected-composition" }, new Set(["clip"]), [video("clip")], new Set(["rejected-composition"]));
    assert.deepEqual(settled.nodeIds, ["historically-missing", "other-pending", "clip"]);
});

test("reservation cleanup retains nodes actually placed, including ones observed before user deletion", () => {
    const pending = film({ nodeIds: ["created", "placed-then-deleted", "existed-before", "never-created"] });
    const settled = recordOneSentenceFilmAction(pending, {
        id: "generate", name: "generate_video", arguments: { sourceNodeIds: [] },
    }, { ok: false }, new Set(["existed-before"]), [video("created", { execution: { phase: "failed" } })],
    // The hook excludes every observed real node from this action's cleanup candidates.
    new Set(["never-created", "existed-before", "created"]));
    assert.deepEqual(settled.nodeIds, ["created", "placed-then-deleted", "existed-before"]);
});

test("standalone clips and a successful historical composition cannot masquerade as this film", () => {
    const nodes = [video("a"), video("b"), video("final"), composition(["a", "b"])];
    for (const current of [film({ nodeIds: ["a", "b"] }), film({ nodeIds: [], resultNodeId: "final" }), film({ nodeIds: ["a", "b", "final", "composition"] })]) {
        const result = finishOneSentenceFilm(current, nodes);
        assert.equal(result.film.status, "interrupted");
        assert.match(result.reply, /成片尚未完成/);
        assert.match(result.reply, /继续成片/);
    }
});

test("only persisted successful final media with successful scoped inputs confirms completion", () => {
    const current = film({ nodeIds: ["a", "b", "final", "composition"], resultNodeId: "final" });
    const inputs = [video("a"), video("b"), composition(["a", "b"])];
    assert.equal(finishOneSentenceFilm(current, [...inputs, video("final")]).film.status, "completed");
    const failures = [
        video("final", { execution: { phase: "running" } }),
        video("final", { execution: { phase: "failed" } }),
        video("final", { content: { source: "https://media.test/final.mp4" } }),
        video("final", { content: { storageKey: "video:final", source: "" } }),
        video("final", { content: { storageKey: "video:final", source: "blob:local-only" } }),
    ];
    for (const failed of failures) assert.equal(finishOneSentenceFilm(current, [...inputs, failed]).film.status, "interrupted");
    assert.equal(finishOneSentenceFilm({ ...current, nodeIds: ["a", "composition", "final"] }, [...inputs, video("final")]).film.status, "interrupted");
    assert.equal(finishOneSentenceFilm(current, [video("a"), video("b", { execution: { phase: "failed" } }), composition(["a", "b"]), video("final")]).film.status, "interrupted");
});

test("an explicitly requested single shot can reuse an existing successful scoped video", () => {
    const result = finishOneSentenceFilm(film({ brief: "单镜头呈现茶叶舒展", nodeIds: ["a"] }), [video("a")]);
    assert.equal(result.film.status, "completed");
    assert.equal(result.film.resultNodeId, "a");
    assert.equal(finishOneSentenceFilm(film({ brief: "不要单镜头，要完整故事", nodeIds: ["a"] }), [video("a")]).film.status, "interrupted");
});

test("a completed composition cannot claim success after an input is regenerated or its ordered version keys are missing", () => {
    const current = film({ nodeIds: ["a", "b", "final", "composition"], resultNodeId: "final" });
    const changedInput = video("b", { content: { source: "https://media.test/b-v2.mp4", storageKey: "video:b-v2" } });
    assert.equal(finishOneSentenceFilm(current, [video("a"), changedInput, video("final"), composition(["a", "b"])]).film.status, "interrupted");
    const missingVersions = composition(["a", "b"]);
    if (missingVersions.kind === "videoComposition") delete missingVersions.composition.inputStorageKeys;
    assert.equal(finishOneSentenceFilm(current, [video("a"), video("b"), video("final"), missingVersions]).film.status, "interrupted");
    const wrongOrder = composition(["a", "b"]);
    if (wrongOrder.kind === "videoComposition") wrongOrder.composition.inputStorageKeys = ["video:b", "video:a"];
    assert.equal(finishOneSentenceFilm(current, [video("a"), video("b"), video("final"), wrongOrder]).film.status, "interrupted");
});

test("film guidance preserves model limits, user total duration, continuity and real audio boundaries", () => {
    const prompt = oneSentenceFilmPrompt(film({ brief: "总长30秒的故事", nodeIds: ["already-saved"] }), true);
    for (const expected of [/30秒/, /不预设镜头数/, /get_generation_config/, /总时长拆成合法时长组合/, /每个镜头只生成 1 份视频/, /compose_videos/, /sourceNodeIds/, /复用已成功镜头/, /不得承诺已配音/, /already-saved/]) {
        assert.match(prompt, expected);
    }
});

function fullFixture() {
    const workflow = { scriptNodeId: "script", shots: [{ textNodeId: "text-a", imageNodeId: "image-a", videoNodeId: "a" }, { textNodeId: "text-b", imageNodeId: "image-b", videoNodeId: "b" }], compositionNodeId: "composition" };
    const text = (id: string): CanvasNode => ({ id, kind: "text", execution: { phase: "succeeded" }, content: { text: "完整镜头正文" } }) as CanvasNode;
    const image = (id: string): CanvasNode => ({ id, kind: "image", execution: { phase: "succeeded" }, content: { source: `https://media.test/${id}.png`, storageKey: `image:${id}` } }) as CanvasNode;
    const nodes = [text("script"), text("text-a"), text("text-b"), image("image-a"), image("image-b"), video("a"), video("b"), composition(["a", "b"]), video("final")];
    const edges = workflow.shots.flatMap(shot => [["script", shot.textNodeId], [shot.textNodeId, shot.imageNodeId], [shot.imageNodeId, shot.videoNodeId], [shot.videoNodeId, "composition"]]);
    const connections = edges.map(([source, target], index): CanvasConnection => ({ id: String(index), source: { nodeId: source }, target: { nodeId: target } }));
    return { current: film({ pipelineMode: "full", workflow, nodeIds: nodes.map(node => node.id), resultNodeId: "final" }), workflow, nodes, connections };
}

test("full mode cannot finish with only clips; the whole saved text-image-video graph must succeed", () => {
    const { current, nodes, connections } = fullFixture();
    assert.equal(finishOneSentenceFilm(current, nodes, connections).film.status, "completed");
    assert.equal(finishOneSentenceFilm({ ...current, workflow: undefined }, nodes, connections).film.status, "interrupted");
    for (const missing of ["script", "text-a", "image-a", "b"]) {
        assert.equal(finishOneSentenceFilm(current, nodes.filter(node => node.id !== missing), connections).film.status, "interrupted");
    }
    assert.equal(finishOneSentenceFilm(current, nodes.map(node => node.id === "image-a" ? { ...node, execution: { phase: "failed" as const } } : node), connections).film.status, "interrupted");
    assert.equal(finishOneSentenceFilm(current, nodes, connections.slice(1)).film.status, "interrupted");
    const reordered = { ...current, workflow: { ...current.workflow!, shots: [...current.workflow!.shots].reverse() } };
    assert.equal(finishOneSentenceFilm(reordered, nodes, connections).film.status, "interrupted");
    assert.equal(finishOneSentenceFilm({ ...current, nodeIds: current.nodeIds.filter(id => id !== "image-a") }, nodes, connections).film.status, "interrupted");
});

test("workflow receipts retain the planned graph and the successful run's final result", () => {
    const { workflow, nodes } = fullFixture();
    const planned = recordOneSentenceFilmAction(film({ pipelineMode: "full" }), { id: "create", name: "create_film_workflow", arguments: { sourceNodeIds: [] } }, { ok: true, workflow, nodeIds: nodes.map(node => node.id) }, new Set(), nodes);
    assert.deepEqual(planned.workflow, workflow);
    assert.deepEqual(planned.nodeIds, nodes.map(node => node.id));
    assert.equal(planned.resultNodeId, undefined);
    const completed = recordOneSentenceFilmAction(planned, { id: "run", name: "run_film_workflow", arguments: {} }, { ok: true, workflow, status: "success", nodeId: "final" }, new Set(nodes.map(node => node.id)), nodes);
    assert.equal(completed.resultNodeId, "final");
    assert.equal(finishOneSentenceFilm(completed, nodes).film.status, "completed");
});

test("full prompt creates the graph once and resumes its stored execution without direct-generation shortcuts", () => {
    const { current } = fullFixture();
    const fresh = oneSentenceFilmPrompt(film({ pipelineMode: "full" }), false);
    assert.match(fresh, /create_film_workflow\(\{clips:/);
    assert.match(fresh, /run_film_workflow\(\{\}\)/);
    assert.match(fresh, /不能跳过文字或图片/);
    const resumed = oneSentenceFilmPrompt(current, true);
    assert.match(resumed, /直接调用 run_film_workflow/);
    assert.match(resumed, /不能重复调用 create_film_workflow/);
});

test("preflight blockers survive the incomplete reply and resume, then clear after a successful run", () => {
    const { current, nodes } = fullFixture();
    const pendingNodes = nodes.map(node => node.kind === "image" || node.kind === "video" || node.kind === "videoComposition" ? { ...node, execution: { phase: "idle" as const } } : node);
    const reason = "当前视频模型不支持图生视频，请选择支持图片参考的模型";
    const blocked = recordOneSentenceFilmAction(current, { id: "run", name: "run_film_workflow", arguments: {} }, { ok: false, message: reason }, new Set(nodes.map(node => node.id)), pendingNodes);
    assert.equal(blocked.blocker, reason);
    assert.ok(finishOneSentenceFilm(blocked, pendingNodes).reply.includes(reason));
    assert.equal(resolveOneSentenceFilmRequest("继续成片", blocked)?.film.blocker, reason);
    const completed = recordOneSentenceFilmAction(blocked, { id: "run-again", name: "run_film_workflow", arguments: {} }, { ok: true, status: "success", nodeId: "final" }, new Set(nodes.map(node => node.id)), nodes);
    assert.equal(completed.blocker, undefined);
    assert.equal(finishOneSentenceFilm(completed, nodes).film.status, "completed");
});

test("partially placed graph receipts remain recoverable even when creation reports failure", () => {
    const { workflow, nodes } = fullFixture();
    const partial = nodes.filter(node => node.id === "script" || node.id === "text-a");
    const result = recordOneSentenceFilmAction(film({ pipelineMode: "full" }), { id: "partial-create", name: "create_film_workflow", arguments: { sourceNodeIds: [] } }, {
        ok: false, workflow, nodeIds: partial.map(node => node.id), message: "图片节点未能落地",
    }, new Set(), partial);
    assert.deepEqual(result.workflow, workflow);
    assert.deepEqual(result.nodeIds, ["script", "text-a"]);
    assert.equal(result.blocker, "图片节点未能落地");
    assert.deepEqual(resolveOneSentenceFilmRequest("继续成片", result)?.film.workflow, workflow);
    assert.equal(finishOneSentenceFilm(result, partial).film.status, "interrupted");
});
