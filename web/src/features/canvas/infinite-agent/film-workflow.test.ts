import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/features/settings/stores/use-config-store";
import { createImageNode, createVideoNode } from "../constants";
import type { CanvasNode } from "../types";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import { createFilmWorkflow, runFilmWorkflow, type FilmWorkflow, type FilmWorkflowInput, type FilmWorkflowOptions } from "./film-workflow";
import { compileFilmStoryPlan } from "./film-story-plan";
import { filmStoryFixture } from "./film-story-plan-fixture";
import { buildNodeGenerationContext } from "../components/canvas-node-generation";

const plan = (count = 3): FilmWorkflowInput => ({ title: "归家的猫", script: "小猫出发，穿过树林，回到家中。", shots: Array.from({ length: count }, (_, index) => ({ title: `场景 ${index + 1}`, description: `第 ${index + 1} 个叙事节拍`, imagePrompt: `猫在场景 ${index + 1} 中`, videoPrompt: `猫在场景 ${index + 1} 中行动`, seconds: 5 })) });
function fixture() {
    let current: CanvasAgentSnapshot = { projectId: "film-project", title: "测试项目", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    const calls: CanvasAgentOp[][] = [];
    let counter = 0;
    let failNodeId = "";
    const options: FilmWorkflowOptions = {
        getSnapshot: () => current, createId: () => String(++counter),
        config: { ...defaultConfig, model: "text-model", textModel: "text-model", imageModel: "image-model", videoModel: "video-model", size: "16:9", videoSeconds: "5", vquality: "720p", count: "9", canvasImageCount: "5", canvasVideoCount: "5", videoModelBillingConfigurations: [{ model: "video-model", capabilities: ["image-to-video"], videoBillingConfiguration: { billingUnit: "generation", minimumDurationSeconds: 1, modePrices: { "image-to-video": { "720p": 10 } } } }] },
        onApplyOps: async (ops, signal) => {
            signal.throwIfAborted();
            calls.push(ops || []);
            current = applyCanvasAgentOps(current, ops);
            let failed = false;
            for (const op of ops || []) {
                if (op.type === "run_generation") {
                    current = { ...current, nodes: current.nodes.map(node => {
                        if (node.id !== op.nodeId || (node.kind !== "image" && node.kind !== "video")) return node;
                        if (node.id === failNodeId) { failed = true; return { ...node, execution: { phase: "failed", errorMessage: "provider failed" } }; }
                        return { ...node, execution: { phase: "succeeded" }, content: { source: `https://media.example/${node.id}`, storageKey: `${node.kind}:${node.id}` } };
                    }) };
                }
                if (op.type === "run_speech") {
                    current = { ...current, nodes: current.nodes.map(node => node.id === op.nodeId && node.kind === "audio"
                        ? { ...node, execution: { phase: "succeeded" as const }, content: { ...node.content, source: `https://media.example/${node.id}.mp3`, storageKey: `audio:${node.id}` } } : node) };
                }
                if (op.type === "run_composition") {
                    const result = createVideoNode({ id: `final-${counter++}`, position: { x: 2500, y: 0 } });
                    result.execution = { phase: "succeeded" };
                    result.content = { source: `https://media.example/${result.id}.mp4`, storageKey: `video:${result.id}` };
                    current = { ...current, nodes: [...current.nodes.map(node => node.id === op.nodeId && node.kind === "videoComposition" ? {
                        ...node, execution: { phase: "succeeded" as const }, composition: { ...node.composition, resultVideoNodeId: result.id, inputStorageKeys: node.composition.inputVideoNodeIds.map(id => {
                            const source = current.nodes.find(item => item.id === id);
                            return source?.kind === "video" ? source.content.storageKey! : "";
                        }), inputAudioStorageKeys: current.connections.filter(edge => edge.target.nodeId === node.id).flatMap(edge => {
                            const source = current.nodes.find(item => item.id === edge.source.nodeId);
                            return source?.kind === "audio" && source.content.storageKey ? [source.content.storageKey] : [];
                        }) },
                    } : node), result] };
                }
            }
            return { snapshot: current, result: { ok: !failed, message: failed ? "provider failed" : "真实步骤已完成", data: { taskId: "mock-task" } } };
        },
    };
    return { options, calls, get snapshot() { return current; }, setSnapshot(value: CanvasAgentSnapshot) { current = value; }, fail(id: string) { failNodeId = id; } };
}
async function create(f: ReturnType<typeof fixture>, input = plan()) {
    const result = await createFilmWorkflow(input, f.options);
    assert.equal(result.ok, true, result.message);
    return result.workflow as FilmWorkflow;
}
const generated = (f: ReturnType<typeof fixture>) => f.calls.flatMap(ops => ops.filter(op => op.type === "run_generation").map(op => op.nodeId));

test("film output ratio propagates through the frozen plan into actual image and video parameters", async () => {
    const f = fixture(), { plan, clips } = filmStoryFixture();
    f.options.config.size = "1:1";
    f.options.config.imageSize = "1:1";
    f.options.config.videoSize = "1:1";
    plan.aspectRatio = "16:9";
    await create(f, compileFilmStoryPlan(plan, clips));
    const media = f.snapshot.nodes.filter(node => node.kind === "image" || node.kind === "video");
    assert.ok(media.length > 0);
    assert.ok(media.every(node => node.generation.size === "16:9"));
});

test("film graph passes a single-frame prompt to images while retaining dependency links and asset references", async () => {
    const f = fixture(), { plan, clips } = filmStoryFixture();
    const compiled = compileFilmStoryPlan(plan, clips);
    const workflow = await create(f, compiled);
    for (const binding of workflow.assets || []) {
        const node = f.snapshot.nodes.find(n => n.id === binding.imageNodeId)!;
        if (node.kind === "image") { node.content.source = "https://example.com/reference.png"; node.content.storageKey = "reference"; }
    }
    const id = workflow.shots[0].imageNodeId;
    const context = buildNodeGenerationContext(id, f.snapshot.nodes, f.snapshot.connections, compiled.shots[0].imagePrompt);
    assert.equal(context.prompt, compiled.shots[0].imagePrompt);
    assert.equal(context.textCount, 0);
    assert.equal(context.referenceImages.length, 1);
    assert.ok(f.snapshot.connections.some(edge => edge.target.nodeId === id && edge.source.nodeId === workflow.shots[0].textNodeId));
});

test("TapCanvas plan executes shared assets then variable-duration clips and ordered composition, preserving durations on resume", async () => {
    const f = fixture(), { plan, clips } = filmStoryFixture();
    f.options.config.videoSeconds = "10";
    const workflow = await create(f, compileFilmStoryPlan(plan, clips));
    assert.equal(workflow.shots.length, 4);
    assert.equal(workflow.assets?.length, 1);
    const seconds = () => workflow.shots.map(shot => {
        const node = f.snapshot.nodes.find(node => node.id === shot.videoNodeId);
        return node?.kind === "video" ? node.generation.seconds : undefined;
    });
    assert.deepEqual(seconds(), ["3", "7", "4", "6"]);
    const assetId = workflow.assets![0].imageNodeId;
    assert.ok(workflow.shots.every(shot => shot.referenceImageNodeIds?.includes(assetId)));
    f.fail(workflow.shots[1].videoNodeId);
    assert.equal((await runFilmWorkflow(workflow, f.options)).ok, false);
    const batches = f.calls.map(ops => ops.filter(op => op.type === "run_generation").map(op => op.nodeId)).filter(ids => ids.length);
    assert.deepEqual(batches, [[assetId], workflow.shots.map(shot => shot.imageNodeId), workflow.shots.map(shot => shot.videoNodeId)]);
    const before = generated(f).length;
    f.fail("");
    assert.equal((await runFilmWorkflow(workflow, f.options)).ok, true);
    assert.deepEqual(generated(f).slice(before), [workflow.shots[1].videoNodeId]);
    assert.deepEqual(seconds(), ["3", "7", "4", "6"]);
    assert.deepEqual(f.calls.at(-1), [{ type: "run_composition", nodeId: workflow.compositionNodeId }]);
});

test("TapCanvas shared assets reuse actual user images and never regenerate them", async () => {
    const f = fixture(), { plan, clips } = filmStoryFixture([6]);
    const image = createImageNode({ id: "uploaded", position: { x: 0, y: 0 } });
    image.content = { source: "https://media.example/user.png", storageKey: "user-image" }; image.execution.phase = "succeeded";
    f.setSnapshot({ ...f.snapshot, nodes: [image] });
    plan.assets[0].sourceNodeId = image.id;
    const workflow = await create(f, compileFilmStoryPlan(plan, clips));
    assert.equal(workflow.compositionNodeId, undefined);
    assert.equal((await runFilmWorkflow(workflow, f.options)).ok, true);
    assert.deepEqual(generated(f), [workflow.shots[0].imageNodeId, workflow.shots[0].videoNodeId]);
});

test("duration total mismatches create no nodes and make no paid calls", async () => {
    const f = fixture();
    const result = await createFilmWorkflow({ ...plan(), targetDurationSeconds: 30 }, f.options);
    assert.equal(result.code, "film_duration_mismatch");
    assert.equal(f.calls.length, 0);
});

test("creation materializes script and every text-image-video step with ordered composition and references, without generation", async () => {
    const f = fixture();
    const reference = createImageNode({ id: "reference", position: { x: 0, y: 0 } });
    reference.content = { source: "https://media.example/ref.png", storageKey: "image:ref" }; reference.execution = { phase: "succeeded" };
    f.setSnapshot({ ...f.snapshot, nodes: [reference] });
    const workflow = await create(f, { ...plan(), sourceNodeIds: ["reference"] });
    assert.equal(f.snapshot.nodes.length, 12); // 1 reference + 1 script + 9 shot nodes + 1 composition.
    assert.equal(generated(f).length, 0);
    assert.equal(f.calls.flat().some(op => op.type === "run_composition"), false);
    const linked = (source: string, target: string) => f.snapshot.connections.some(edge => edge.source.nodeId === source && edge.target.nodeId === target);
    for (const [index, shot] of workflow.shots.entries()) {
        assert.ok(linked(workflow.scriptNodeId, shot.textNodeId)); assert.ok(linked(shot.textNodeId, shot.imageNodeId)); assert.ok(linked(shot.imageNodeId, shot.videoNodeId));
        assert.ok(linked("reference", shot.imageNodeId)); assert.ok(linked(shot.videoNodeId, workflow.compositionNodeId!));
        if (index) assert.ok(linked(workflow.shots[0].imageNodeId, shot.imageNodeId));
        const image = f.snapshot.nodes.find(node => node.id === shot.imageNodeId)!;
        const video = f.snapshot.nodes.find(node => node.id === shot.videoNodeId)!;
        assert.ok(image.kind === "image" && video.kind === "video");
        assert.equal(image.generation.count, 1); assert.equal(video.generation.count, 1);
        assert.equal(video.generation.videoGenerationMode, "image-to-video");
        assert.equal(video.generation.seconds, "5"); assert.equal(video.generation.model, "video-model");
        assert.ok(image.frame.position.x < video.frame.position.x);
    }
    const composition = f.snapshot.nodes.find(node => node.id === workflow.compositionNodeId)!;
    assert.ok(composition.kind === "videoComposition");
    assert.deepEqual(composition.composition.inputVideoNodeIds, workflow.shots.map(shot => shot.videoNodeId));
});

test("execution runs first image, remaining images, videos then final composition on reserved IDs", async () => {
    const f = fixture(), workflow = await create(f);
    const before = f.snapshot.nodes.map(node => node.id);
    const result = await runFilmWorkflow(workflow, f.options);
    assert.equal(result.ok, true, result.message); assert.equal(result.status, "success");
    const batches = f.calls.map(ops => ops.filter(op => op.type === "run_generation").map(op => op.nodeId)).filter(ids => ids.length);
    assert.deepEqual(batches, [[workflow.shots[0].imageNodeId], workflow.shots.slice(1).map(shot => shot.imageNodeId), workflow.shots.map(shot => shot.videoNodeId)]);
    assert.deepEqual(f.calls.at(-1), [{ type: "run_composition", nodeId: workflow.compositionNodeId }]);
    assert.deepEqual(f.snapshot.nodes.slice(0, before.length).map(node => node.id), before);
    assert.equal(f.snapshot.nodes.length, before.length + 1); // Only the actual final result is new.
    assert.equal(result.taskId, "mock-task");
    const callCount = f.calls.length;
    const repeat = await runFilmWorkflow(workflow, f.options);
    assert.equal(repeat.ok, true); assert.equal(repeat.nodeId, result.nodeId); assert.equal(repeat.reused, true);
    assert.equal(f.calls.length, callCount);
});

test("failed image stops dependent videos and preserves successful media for an explicit resume", async () => {
    const f = fixture(), workflow = await create(f);
    f.fail(workflow.shots[1].imageNodeId);
    const result = await runFilmWorkflow(workflow, f.options);
    assert.equal(result.ok, false); assert.equal(result.code, "film_generation_failed");
    assert.equal(f.calls.flat().some(op => op.type === "run_generation" && op.mode === "video"), false);
    assert.equal(f.calls.flat().some(op => op.type === "run_composition"), false);
    const before = generated(f).length;
    f.fail("");
    const resumed = await runFilmWorkflow(workflow, f.options);
    assert.equal(resumed.ok, true, resumed.message);
    assert.deepEqual(generated(f).slice(before), [workflow.shots[1].imageNodeId, ...workflow.shots.map(shot => shot.videoNodeId)]);
});

test("running nodes return waiting without submitting any duplicate work", async () => {
    const f = fixture(), workflow = await create(f);
    f.setSnapshot({ ...f.snapshot, nodes: f.snapshot.nodes.map(node => node.id === workflow.shots[0].imageNodeId ? { ...node, execution: { phase: "running", taskId: "existing-task" } } : node) });
    const before = f.calls.length;
    const result = await runFilmWorkflow(workflow, f.options);
    assert.equal(result.ok, false); assert.equal(result.status, "waiting"); assert.equal(result.code, "film_workflow_running");
    assert.equal(f.calls.length, before);
});

test("batch failure reports each failed shot's concrete error and falls back to the host message only when absent", async () => {
    for (const messages of [["HTTP connect timed out", "视频下载失败"], ["", "   "]]) {
        const f = fixture(), workflow = await create(f);
        const apply = f.options.onApplyOps;
        const failedIds = workflow.shots.slice(1).map(shot => shot.videoNodeId);
        const hostMessage = "部分画布节点生成失败";
        f.options.onApplyOps = async (ops, signal) => {
            const applied = await apply(ops, signal);
            if (!ops?.some(op => op.type === "run_generation" && op.mode === "video")) return applied;
            const snapshot = { ...applied.snapshot, nodes: applied.snapshot.nodes.map(node => {
                const index = failedIds.indexOf(node.id);
                return index < 0 ? node : { ...node, execution: { phase: "failed" as const, errorMessage: messages[index] } };
            }) };
            f.setSnapshot(snapshot);
            return { snapshot, result: { ok: false, message: hostMessage } };
        };
        const result = await runFilmWorkflow(workflow, f.options);
        assert.equal(result.ok, false); assert.equal(result.code, "film_generation_failed");
        const expected = failedIds.flatMap((id, index) => messages[index].trim()
            ? [`「${f.snapshot.nodes.find(node => node.id === id)!.title}」：${messages[index]}`] : []);
        assert.equal(result.message, expected.join("\n") || hostMessage);
        assert.equal(f.calls.flat().some(op => op.type === "run_composition"), false);
    }
});

test("missing video model or image-to-video capability retains full graph and does not spend on images", async () => {
    for (const missing of ["model", "mode"]) {
        const f = fixture();
        if (missing === "model") f.options.config.videoModel = "";
        else f.options.config.videoModelBillingConfigurations = [];
        const workflow = await create(f);
        assert.equal(f.snapshot.nodes.length, 11);
        const result = await runFilmWorkflow(workflow, f.options);
        assert.equal(result.ok, false);
        assert.equal(result.code, missing === "model" ? "model_not_configured" : "image_to_video_unsupported");
        assert.equal(generated(f).length, 0);
        assert.equal(f.snapshot.nodes.length, 11);
    }
});

test("auto generation disabled retains graph and avoids every paid operation", async () => {
    const f = fixture(); f.options.config.autoGenerateMedia = false;
    const workflow = await create(f), before = f.calls.length;
    const result = await runFilmWorkflow(workflow, f.options);
    assert.equal(result.ok, true); assert.equal(result.status, "planned"); assert.equal(f.calls.length, before);
});

test("illegal durations, incomplete plans and invalid references cannot create a partial graph", async () => {
    const f = fixture();
    for (const invalid of [ { ...plan(), shots: [] }, { ...plan(), shots: Array.from({ length: 21 }, () => plan(1).shots[0]) }, { ...plan(1), shots: [{ ...plan(1).shots[0], seconds: 16 }] }, { ...plan(1), shots: [{ ...plan(1).shots[0], videoPrompt: "" }] }, { ...plan(), sourceNodeIds: ["deleted"] } ]) {
        const result = await createFilmWorkflow(invalid, f.options);
        assert.equal(result.ok, false);
    }
    assert.equal(f.calls.length, 0); assert.equal(f.snapshot.nodes.length, 0);
});

test("deleted dependency links and fabricated success receipts stop before video generation", async () => {
    const f = fixture(), workflow = await create(f);
    const original = f.snapshot;
    f.setSnapshot({ ...original, connections: original.connections.filter(edge => edge.source.nodeId !== workflow.shots[0].imageNodeId) });
    assert.equal((await runFilmWorkflow(workflow, f.options)).code, "film_connection_missing");
    assert.equal(generated(f).length, 0);
    f.setSnapshot(original);
    f.options.onApplyOps = async () => ({ snapshot: f.snapshot, result: { ok: true, message: "queued" } });
    const result = await runFilmWorkflow(workflow, f.options);
    assert.equal(result.ok, false); assert.equal(result.code, "film_generation_incomplete");
});

test("a changed source video invalidates cached composition while successful images and videos remain reusable", async () => {
    const f = fixture(), workflow = await create(f);
    const first = await runFilmWorkflow(workflow, f.options);
    const count = generated(f).length;
    f.setSnapshot({ ...f.snapshot, nodes: f.snapshot.nodes.map(node => node.id === workflow.shots[1].videoNodeId && node.kind === "video" ? { ...node, content: { source: "https://media.example/replaced.mp4", storageKey: "video:replacement" } } : node) });
    const next = await runFilmWorkflow(workflow, f.options);
    assert.equal(next.ok, true); assert.notEqual(next.nodeId, first.nodeId); assert.equal(generated(f).length, count);
    assert.equal(f.calls.flat().filter(op => op.type === "run_composition").length, 2);
});

test("single shot still creates text, image and video nodes and delivers the existing video without composition", async () => {
    const f = fixture(), workflow = await create(f, plan(1));
    assert.equal(f.snapshot.nodes.length, 4); assert.equal(workflow.compositionNodeId, undefined);
    const result = await runFilmWorkflow(workflow, f.options);
    assert.equal(result.ok, true); assert.equal(result.nodeId, workflow.shots[0].videoNodeId);
    assert.equal(f.snapshot.nodes.length, 4); assert.equal(f.calls.flat().some(op => op.type === "run_composition"), false);
});

test("canceled runs stop without advancing dependent operations", async () => {
    const f = fixture(), workflow = await create(f);
    const controller = new AbortController(); f.options.signal = controller.signal;
    const apply = f.options.onApplyOps;
    f.options.onApplyOps = async (ops, signal) => { const result = await apply(ops, signal); controller.abort(); return result; };
    await assert.rejects(runFilmWorkflow(workflow, f.options), { name: "AbortError" });
    assert.deepEqual(generated(f), [workflow.shots[0].imageNodeId]);
});

test("run passes selected style snapshots to the actual host generation operations", async () => {
    const f = fixture();
    const styles = [{ id: 4, name: "胶片", generationType: "image" as const, stylePrompt: "film" }, { id: 7, name: "动画", generationType: "video" as const, stylePrompt: "animation" }];
    f.options.config.generationStyleIdsByType = { image: [4], video: [7] };
    f.options.config.generationStyleSnapshots = styles;
    const workflow = await create(f, plan(1));
    assert.equal((await runFilmWorkflow(workflow, f.options)).ok, true);
    const imageOp = f.calls.flat().find(op => op.type === "run_generation" && op.mode === "image")!;
    const videoOp = f.calls.flat().find(op => op.type === "run_generation" && op.mode === "video")!;
    assert.deepEqual(imageOp.generationStyleIds, [4]); assert.deepEqual(imageOp.generationStyleSnapshots, [styles[0]]);
    assert.deepEqual(videoOp.generationStyleIds, [7]); assert.deepEqual(videoOp.generationStyleSnapshots, [styles[1]]);
});

test("film planning applies the model default to video nodes when resolution is unset", async () => {
    const f = fixture();
    f.options.config.vquality = "";
    f.options.config.videoModelBillingConfigurations![0].videoBillingConfiguration = {
        billingUnit: "generation", minimumDurationSeconds: 1, defaultResolution: "480p",
        modePrices: { "image-to-video": { "480p": 5, "720p": 10 } },
    };
    const workflow = await create(f, plan(1));
    const video = f.snapshot.nodes.find(node => node.id === workflow.shots[0].videoNodeId);
    assert.equal(video?.kind === "video" && video.generation.quality, "480p");
    assert.equal((await runFilmWorkflow(workflow, f.options)).ok, true);
});

test("missing selected video resolution price blocks before images are submitted", async () => {
    const f = fixture(); f.options.config.vquality = "1080p";
    const workflow = await create(f);
    const result = await runFilmWorkflow(workflow, f.options);
    assert.equal(result.ok, false); assert.equal(result.code, "film_video_configuration");
    assert.equal(generated(f).length, 0); assert.equal(f.snapshot.nodes.length, 11);
});

test("a partially applied graph returns its reserved workflow to prevent duplicate recreation", async () => {
    const f = fixture();
    f.options.onApplyOps = async ops => {
        const first = ops?.find(op => op.type === "add_node");
        const snapshot = applyCanvasAgentOps(f.snapshot, first ? [first] : []);
        f.setSnapshot(snapshot);
        return { snapshot };
    };
    const result = await createFilmWorkflow(plan(), f.options);
    assert.equal(result.ok, false); assert.equal(result.code, "film_node_missing");
    assert.ok(result.workflow); assert.equal((result.workflow as FilmWorkflow).scriptNodeId, f.snapshot.nodes[0].id);
});


test("one 30-second clip containing multiple internal shots submits exactly one video task", async () => {
    const f = fixture(), { plan, clips } = filmStoryFixture([30]);
    f.options.config.videoSeconds = "10";
    f.options.config.videoModelBillingConfigurations![0].videoBillingConfiguration!.supportedDurationsSeconds = [15, 30];
    const beat = plan.beats[0];
    const states = [beat.entryState, "邮递员发现备用电池", "邮递员检查电池仍有电", beat.exitState];
    beat.storyEvents = ["发现备用电池", "检查电池", "提起电池准备出发"].map((event, i) => ({ sourceBeatId: `event-${i}`, event, entryState: states[i], exitState: states[i + 1], startSeconds: i * 10, endSeconds: (i + 1) * 10 }));
    clips[0].timeline.shots = beat.storyEvents.map((event, i) => ({ action: event.event, camera: ["远景建立", "电池特写", "跟随人物"][i], sound: "雨声", storyEventIds: [event.sourceBeatId], speechEventIds: i === 0 ? ["line-1"] : [] }));
    const workflow = await create(f, compileFilmStoryPlan(plan, clips));
    assert.equal(workflow.shots.length, 1);
    assert.equal(workflow.compositionNodeId, undefined);
    const id = workflow.shots[0].videoNodeId;
    const video = f.snapshot.nodes.find(node => node.id === id);
    assert.equal(video?.kind === "video" && video.generation.seconds, "30");
    assert.ok(video?.kind === "video" && video.generation.prompt.includes("本次生成总时长：30 秒"));
    assert.equal((await runFilmWorkflow(workflow, f.options)).ok, true);
    assert.deepEqual(f.calls.flat().filter(op => op.type === "run_generation" && op.mode === "video").map(op => op.nodeId), [id]);
});

test("AI-authored long clips and shorter endings keep their chosen durations and composition order", async () => {
    for (const durations of [[30, 15], [30, 30], [60]]) {
        const f = fixture(), { plan, clips } = filmStoryFixture(durations);
        f.options.config.videoSeconds = "10";
        f.options.config.videoModelBillingConfigurations![0].videoBillingConfiguration!.supportedDurationsSeconds = [15, 30, 60];
        const workflow = await create(f, compileFilmStoryPlan(plan, clips));
        assert.equal((await runFilmWorkflow(workflow, f.options)).ok, true);
        const nodes = workflow.shots.map(shot => f.snapshot.nodes.find(node => node.id === shot.videoNodeId));
        assert.deepEqual(nodes.map(node => node?.kind === "video" ? Number(node.generation.seconds) : null), durations);
        assert.equal(f.calls.flat().filter(op => op.type === "run_generation" && op.mode === "video").length, durations.length);
        if (workflow.compositionNodeId) {
            const composition = f.snapshot.nodes.find(node => node.id === workflow.compositionNodeId);
            assert.deepEqual(composition?.kind === "videoComposition" && composition.composition.inputVideoNodeIds, workflow.shots.map(shot => shot.videoNodeId));
        }
    }
});

test("with a speech model, frozen dialogue becomes timed voiceover nodes generated before paid videos and mixed into the film", async () => {
    const f = fixture(), { plan, clips } = filmStoryFixture();
    f.options.config.audioModel = "newapi::grok-voice-latest";
    plan.assets[0].voice = "rex";
    const workflow = await create(f, compileFilmStoryPlan(plan, clips));
    assert.equal(workflow.voiceover?.length, 1);
    const audio = f.snapshot.nodes.find(node => node.id === workflow.voiceover![0].audioNodeId);
    assert.equal(audio?.kind, "audio");
    if (audio?.kind !== "audio") return;
    assert.deepEqual({ text: audio.speech?.text, voice: audio.speech?.voice, speaker: audio.speech?.speaker }, { text: "我去点亮它。", voice: "rex", speaker: "邮递员" });
    assert.equal(audio.content.timelineStartMilliseconds, 0);
    const composition = f.snapshot.nodes.find(node => node.id === workflow.compositionNodeId);
    assert.equal(composition?.kind === "videoComposition" ? composition.composition.originalAudioVolume : "missing", 0, "voiced films mute the video's own audio so lines are not heard twice");
    const firstVideo = f.snapshot.nodes.find(node => node.id === workflow.shots[0].videoNodeId);
    const videoPrompt = firstVideo?.kind === "video" ? firstVideo.generation.prompt : "";
    assert.equal(videoPrompt.includes("我去点亮它。"), false, "the dubbed line must not reach the video model");
    assert.match(videoPrompt, /不要生成任何人声/);
    assert.ok(f.snapshot.connections.some(edge => edge.source.nodeId === audio.id && edge.target.nodeId === workflow.compositionNodeId));
    assert.equal((await runFilmWorkflow(workflow, f.options)).ok, true);
    const order = f.calls.flat().filter(op => op.type === "run_speech" || op.type === "run_generation" || op.type === "run_composition").map(op => op.type === "run_generation" ? (f.snapshot.nodes.find(node => node.id === op.nodeId)?.kind || "") : op.type);
    assert.ok(order.indexOf("run_speech") < order.indexOf("video"), `speech must run before paid videos: ${order.join(",")}`);
    assert.equal(order.at(-1), "run_composition");
    const before = f.calls.length;
    const resumed = await runFilmWorkflow(workflow, f.options);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.reused, true, "an unchanged voiced film is reused, not recomposed");
    assert.equal(f.calls.slice(before).flat().some(op => op.type === "run_speech"), false);
});

test("a single voiced shot still gets a composition node, and missing speech models never create voice nodes", async () => {
    const voiced = fixture(), single = filmStoryFixture([6]);
    voiced.options.config.audioModel = "newapi::grok-voice-latest";
    const workflow = await create(voiced, compileFilmStoryPlan(single.plan, single.clips));
    assert.ok(workflow.compositionNodeId, "voice needs the mixer even for one shot");
    assert.equal(workflow.voiceover?.length, 1);
    const silent = fixture(), again = filmStoryFixture([6]);
    const result = await createFilmWorkflow(compileFilmStoryPlan(again.plan, again.clips), silent.options);
    assert.equal(result.ok, true);
    assert.equal((result.workflow as FilmWorkflow).voiceover, undefined);
    assert.equal((result.workflow as FilmWorkflow).compositionNodeId, undefined);
    const silentVideo = silent.snapshot.nodes.find(node => node.id === (result.workflow as FilmWorkflow).shots[0].videoNodeId);
    assert.ok(silentVideo?.kind === "video" && silentVideo.generation.prompt.includes("我去点亮它。"), "without TTS the video model keeps its own dialogue");
    assert.match(String(result.message), /没有默认语音模型/);
});
