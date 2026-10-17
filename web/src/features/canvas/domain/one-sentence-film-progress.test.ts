import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createTextNode, createVideoCompositionNode, createVideoNode } from "../constants";
import type { CanvasConnection, CanvasNode } from "../types";
import { buildOneSentenceFilmMessage, readOneSentenceFilmRun, summarizeOneSentenceFilmProgress, type OneSentenceFilmRun } from "./one-sentence-film-progress";

const input = (id: string) => ({ id, position: { x: 0, y: 0 } });
const run = (patch: Partial<OneSentenceFilmRun> = {}): OneSentenceFilmRun => ({ brief: "咖啡馆的治愈短片", nodeIds: [], status: "running", ...patch });
const savedVideo = (id: string) => {
    const node = createVideoNode(input(id));
    node.execution.phase = "succeeded";
    node.content.source = `https://media.test/${id}.mp4`;
    node.content.storageKey = `video:${id}`;
    return node;
};
const completedFilm = () => {
    const first = savedVideo("clip-first"), second = savedVideo("clip-second"), final = savedVideo("final");
    const composition = createVideoCompositionNode(input("compose"));
    composition.execution.phase = "succeeded";
    composition.composition = { inputVideoNodeIds: [first.id, second.id], inputStorageKeys: [first.content.storageKey!, second.content.storageKey!], resultVideoNodeId: final.id };
    const nodes = [first, second, composition, final];
    return { first, second, composition, final, nodes, state: run({ nodeIds: nodes.map(node => node.id), resultNodeId: final.id, status: "completed" }) };
};
const fullGraph = () => {
    const workflow = { scriptNodeId: "script", shots: [1, 2, 3].map(index => ({ textNodeId: `text-${index}`, imageNodeId: `image-${index}`, videoNodeId: `video-${index}` })), compositionNodeId: "full-compose" };
    const script = createTextNode({ ...input(workflow.scriptNodeId), text: "雨夜咖啡馆的三镜制作稿" });
    script.execution.phase = "succeeded";
    const shotNodes = workflow.shots.map((shot, index) => {
        const text = createTextNode({ ...input(shot.textNodeId), title: `镜头 ${index + 1} · 咖啡馆`, text: "雨落窗边，热气升起。" });
        text.execution.phase = "succeeded";
        return { text, image: createImageNode(input(shot.imageNodeId)), video: createVideoNode(input(shot.videoNodeId)) };
    });
    const composition = createVideoCompositionNode(input(workflow.compositionNodeId));
    composition.composition.inputVideoNodeIds = workflow.shots.map(shot => shot.videoNodeId);
    const nodes: CanvasNode[] = [script, ...shotNodes.flatMap(shot => [shot.text, shot.image, shot.video]), composition];
    const connections: CanvasConnection[] = workflow.shots.flatMap(shot => [
        [workflow.scriptNodeId, shot.textNodeId], [shot.textNodeId, shot.imageNodeId], [shot.imageNodeId, shot.videoNodeId], [shot.videoNodeId, workflow.compositionNodeId],
    ]).map(([source, target], index) => ({ id: `edge-${index}`, source: { nodeId: source }, target: { nodeId: target } }));
    return { workflow, shotNodes, composition, nodes, connections, state: run({ pipelineMode: "full", workflow, nodeIds: nodes.map(node => node.id) }) };
};

test("mode marks one submitted request without repeating its marker", () => {
    assert.equal(buildOneSentenceFilmMessage("  夜晚的咖啡馆  ", true), "【一句话成片】\n夜晚的咖啡馆");
    assert.equal(buildOneSentenceFilmMessage("【一句话成片】\n夜晚的咖啡馆", true), "【一句话成片】\n夜晚的咖啡馆");
    assert.equal(buildOneSentenceFilmMessage("  梳理画布  ", false), "梳理画布");
    assert.equal(buildOneSentenceFilmMessage("  ", true), "");
});

test("corrupt history is ignored and duplicate IDs do not count twice", () => {
    assert.equal(readOneSentenceFilmRun({ nodeIds: [], status: "completed" }), undefined);
    const parsed = readOneSentenceFilmRun(run({ nodeIds: ["script", "script", "deleted"] }))!;
    const summary = summarizeOneSentenceFilmProgress(parsed, [createTextNode({ ...input("script"), text: "镜头一：雨落。" })]);
    assert.equal(summary.stages[0].completed, 1);
    assert.equal(summary.stages[0].total, 1);
    assert.equal(summary.missing, 1);
});

test("completed memory and generated clips cannot substitute for the actual final video", () => {
    const video = createVideoNode(input("clip"));
    video.execution.phase = "succeeded";
    video.content.source = "https://media.test/clip.mp4";
    const summary = summarizeOneSentenceFilmProgress(run({ nodeIds: [video.id], status: "completed", resultNodeId: "removed-result" }), [video]);
    assert.equal(summary.stages[2].completed, 1);
    assert.equal(summary.stages[3].completed, 0);
    assert.equal(summary.ready, false);
    assert.equal(summary.resultNodeId, undefined);
    assert.equal(summary.label, "等待继续制作");
});

test("pending or failed media with an old URL is not a successful stage", () => {
    const image = createImageNode(input("image"));
    image.content.source = "https://media.test/old.png";
    image.execution.phase = "running";
    const video = createVideoNode(input("clip"));
    video.content.source = "https://media.test/old.mp4";
    video.execution.phase = "failed";
    const summary = summarizeOneSentenceFilmProgress(run({ nodeIds: [image.id, video.id] }), [image, video]);
    assert.equal(summary.stages[1].completed, 0);
    assert.equal(summary.stages[1].running, 1);
    assert.equal(summary.stages[2].completed, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.failedNodeId, video.id);
});

test("a saved successful final output counts once and provides a real navigation target", () => {
    const { state, nodes, final } = completedFilm();
    const summary = summarizeOneSentenceFilmProgress(state, nodes);
    assert.equal(summary.stages[2].total, 2);
    assert.equal(summary.stages[3].completed, 1);
    assert.equal(summary.ready, true);
    assert.equal(summary.resultNodeId, final.id);
});

test("editing a source video invalidates the old completed flag and final navigation", () => {
    const { state, nodes, first } = completedFilm();
    first.content.storageKey = "video:clip-first-new-version";
    const summary = summarizeOneSentenceFilmProgress(state, nodes);
    assert.equal(summary.ready, false);
    assert.equal(summary.stages[3].completed, 0);
    assert.equal(summary.resultNodeId, undefined);
});

test("changing clip order requires a new composition even if every old video remains playable", () => {
    const { state, nodes, composition } = completedFilm();
    composition.composition.inputVideoNodeIds.reverse();
    assert.equal(summarizeOneSentenceFilmProgress(state, nodes).ready, false);
});

test("unverifiable historical composition inputs and removed source nodes cannot count as a ready film", () => {
    const { state, nodes, first, composition } = completedFilm();
    assert.equal(summarizeOneSentenceFilmProgress(state, nodes.filter(node => node.id !== first.id)).ready, false);
    assert.equal(summarizeOneSentenceFilmProgress({ ...state, nodeIds: state.nodeIds.filter(id => id !== first.id) }, nodes).ready, false);
    composition.composition.inputStorageKeys = undefined;
    assert.equal(summarizeOneSentenceFilmProgress(state, nodes).ready, false);
});

test("explicit single-shot delivery remains valid without a composition node", () => {
    const clip = savedVideo("single-shot");
    const state = run({ brief: "一镜到底拍摄雨夜咖啡馆", nodeIds: [clip.id], status: "completed" });
    const summary = summarizeOneSentenceFilmProgress(state, [clip]);
    assert.equal(summary.ready, true);
    assert.equal(summary.resultNodeId, clip.id);
    assert.equal(summary.stages[3].completed, 1);
    assert.equal(summarizeOneSentenceFilmProgress({ ...state, brief: "不要单镜头，制作咖啡馆短片" }, [clip]).ready, false);
});

test("a transient result cannot be presented as a saved film", () => {
    const final = createVideoNode(input("final"));
    final.execution.phase = "succeeded";
    final.content.source = "blob:temporary-output";
    const state = run({ nodeIds: [final.id], resultNodeId: final.id, status: "completed" });
    assert.equal(summarizeOneSentenceFilmProgress(state, [final]).ready, false);
    final.content.storageKey = "video:film-final";
    assert.equal(summarizeOneSentenceFilmProgress(state, [final]).ready, false);
    final.content.source = "https://media.test/final.mp4";
    assert.equal(summarizeOneSentenceFilmProgress({ ...state, status: "running" }, [final]).ready, false);
});

test("composition failure is visible even before it has created an output video", () => {
    const composition = createVideoCompositionNode(input("compose"));
    composition.execution.phase = "failed";
    const summary = summarizeOneSentenceFilmProgress(run({ nodeIds: [composition.id], status: "interrupted" }), [composition]);
    assert.equal(summary.stages[3].failed, 1);
    assert.equal(summary.stages[3].nodeId, composition.id);
    assert.equal(summary.failed, 1);
    assert.equal(summary.ready, false);
});

test("persisted full workflow survives UI parsing with all planned shot IDs", () => {
    const { state, workflow } = fullGraph();
    const parsed = readOneSentenceFilmRun(state)!;
    assert.equal(parsed.pipelineMode, "full");
    assert.deepEqual(parsed.workflow, workflow);
    assert.equal(readOneSentenceFilmRun({ ...state, workflow: { scriptNodeId: "script", shots: [{ textNodeId: "t" }] } })?.workflow, undefined);
    assert.equal(readOneSentenceFilmRun(run())?.pipelineMode, undefined);
});

test("complete graph shows every planned text/image/video placeholder before any media is generated", () => {
    const { state, nodes, connections } = fullGraph();
    const summary = summarizeOneSentenceFilmProgress(state, nodes, connections);
    assert.deepEqual(summary.stages.map(stage => [stage.completed, stage.total]), [[4, 4], [0, 3], [0, 3], [0, 1]]);
    assert.equal(summary.fullPipeline, true);
    assert.equal(summary.shots.length, 3);
    assert.deepEqual(summary.shots[2].steps.map(step => step.status), ["completed", "pending", "pending"]);
    assert.equal(summary.shots[0].steps[1].nodeId, "image-1");
    assert.equal(summary.ready, false);
});

test("missing planned nodes remain in totals and imported references do not inflate generated steps", () => {
    const { state, nodes, connections, workflow } = fullGraph();
    const reference = createImageNode(input("reference"));
    reference.execution.phase = "succeeded";
    reference.content = { source: "https://media.test/ref.jpg", storageKey: "image:reference" };
    const withoutMedia = [...nodes.filter(node => node.kind === "text" || node.kind === "videoComposition"), reference];
    const summary = summarizeOneSentenceFilmProgress({ ...state, nodeIds: [...state.nodeIds, reference.id] }, withoutMedia, connections);
    assert.deepEqual(summary.stages.slice(1, 3).map(stage => [stage.completed, stage.total]), [[0, 3], [0, 3]]);
    assert.equal(summary.shots[0].steps[1].status, "missing");
    assert.equal(summary.shots[0].steps[1].nodeId, undefined);
    assert.equal(summary.missing, workflow.shots.length * 2);
});

test("per-shot states show actual running and failed nodes while pending videos stay pending", () => {
    const { state, nodes, shotNodes } = fullGraph();
    shotNodes[0].image.execution.phase = "succeeded";
    shotNodes[0].image.content = { source: "https://media.test/i1.jpg", storageKey: "image:first" };
    shotNodes[1].image.execution.phase = "running";
    shotNodes[2].image.execution.phase = "failed";
    const summary = summarizeOneSentenceFilmProgress(state, nodes);
    assert.equal(summary.stages[1].completed, 1);
    assert.equal(summary.stages[1].running, 1);
    assert.equal(summary.stages[1].failed, 1);
    assert.deepEqual(summary.shots.map(shot => shot.steps[1].status), ["completed", "running", "failed"]);
    assert.ok(summary.shots.every(shot => shot.steps[2].status === "pending"));
    assert.equal(summary.failedNodeId, "image-3");
});

test("full completion uses graph connections and cannot skip an image after a successful final video", () => {
    const { state, nodes, shotNodes, composition, connections } = fullGraph();
    for (const shot of shotNodes) {
        shot.image.execution.phase = "succeeded";
        shot.image.content = { source: `https://media.test/${shot.image.id}.jpg`, storageKey: `image:${shot.image.id}` };
        Object.assign(shot.video, savedVideo(shot.video.id));
    }
    const final = savedVideo("full-final");
    nodes.push(final);
    composition.execution.phase = "succeeded";
    composition.composition.inputStorageKeys = shotNodes.map(shot => shot.video.content.storageKey!);
    composition.composition.resultVideoNodeId = final.id;
    const finished = { ...state, status: "completed" as const, nodeIds: [...state.nodeIds, final.id], resultNodeId: final.id };
    assert.equal(summarizeOneSentenceFilmProgress(finished, nodes, connections).ready, true);
    assert.equal(summarizeOneSentenceFilmProgress(finished, nodes, connections.slice(1)).ready, false);
    assert.equal(summarizeOneSentenceFilmProgress(finished, nodes.filter(node => node.id !== shotNodes[1].image.id), connections).ready, false);
});

test("full mode before planning has a pending script and does not count existing reference media", () => {
    const reference = savedVideo("old-video");
    const summary = summarizeOneSentenceFilmProgress(run({ pipelineMode: "full", nodeIds: [reference.id] }), [reference]);
    assert.deepEqual(summary.stages.map(stage => [stage.completed, stage.total]), [[0, 1], [0, 0], [0, 0], [0, 1]]);
    assert.equal(summary.fullPipeline, true);
    assert.equal(summary.ready, false);
});
