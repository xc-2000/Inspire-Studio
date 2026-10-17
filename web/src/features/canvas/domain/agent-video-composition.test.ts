import assert from "node:assert/strict";
import test from "node:test";
import { createVideoNode, createVideoCompositionNode } from "../constants.ts";
import { executeCanvasAgentComposition } from "./agent-video-composition.ts";
import type { CanvasNode, CanvasVideoNode } from "../types";
import type { VideoCompositionTask } from "@/services/api/video-composition";

function fixture() {
    const video = (id: string) => ({ ...createVideoNode({ id, position: { x: 0, y: 0 } }),
        execution: { phase: "succeeded" as const }, content: { source: `https://media.test/${id}.mp4`, storageKey: `video:${id}` } });
    const composition = { ...createVideoCompositionNode({ id: "film", position: { x: 0, y: 0 } }),
        composition: { inputVideoNodeIds: ["second", "first"] } };
    let nodes: CanvasNode[] = [video("first"), video("second"), composition];
    const controller = new AbortController();
    let starts = 0, cancels = 0;
    const final: VideoCompositionTask = { id: "compose-task", status: "succeeded", progress: 100,
        sourceStorageKeys: ["video:second", "video:first"], resultData: { storageKey: "video:result", url: "https://media.test/result.mp4" } };
    const options: Parameters<typeof executeCanvasAgentComposition>[0] = {
        nodeId: "film", signal: controller.signal, getNodes: () => nodes,
        start: async node => {
            starts++;
            assert.deepEqual(node.composition.inputVideoNodeIds, ["second", "first"]);
            nodes = nodes.map(item => item.id === "film" ? { ...composition,
                execution: { phase: "running", taskId: final.id },
                composition: { ...composition.composition, resultVideoNodeId: "result", inputStorageKeys: final.sourceStorageKeys } } : item);
            nodes.push({ ...video("result"), execution: { phase: "running" }, content: { source: "" } });
            return { taskId: final.id, resultId: "result" };
        },
        wait: async () => final,
        apply: (_nodeId, resultId, task) => {
            nodes = nodes.map(node => node.id === "film" ? { ...node, execution: { phase: task.status === "succeeded" ? "succeeded" : "failed" } }
                : node.id === resultId ? { ...node as CanvasVideoNode,
                    execution: { phase: task.status === "succeeded" ? "succeeded" : "failed" },
                    content: { source: task.resultData.url || "", storageKey: task.resultData.storageKey } } : node);
        },
        cancel: async () => { cancels++; return { ...final, status: "canceled", resultData: {} }; },
    };
    return { options, final, controller, nodes: () => nodes, setNodes: (next: CanvasNode[]) => { nodes = next; }, counts: () => ({ starts, cancels }) };
}

test("composition waits for real saved output and preserves clip order", async () => {
    const f = fixture();
    let finish!: (value: VideoCompositionTask) => void;
    let waiting!: () => void;
    const entered = new Promise<void>(resolve => { waiting = resolve; });
    f.options.wait = () => { waiting(); return new Promise(resolve => { finish = resolve; }); };
    let done = false;
    const work = executeCanvasAgentComposition(f.options).then(result => { done = true; return result; });
    await entered;
    assert.equal(done, false);
    finish(f.final);
    const result = await work;
    assert.equal(result.ok, true);
    assert.equal(result.data?.nodeId, "result");
    assert.equal((await executeCanvasAgentComposition(f.options)).ok, true);
    assert.deepEqual(f.counts(), { starts: 1, cancels: 0 });
});

test("failed, unfinished, or unsaved clips never submit composition", async () => {
    for (const variant of ["failed", "running", "unsaved"] as const) {
        const f = fixture();
        f.setNodes(f.nodes().map(node => node.id !== "first" ? node : {
            ...node as CanvasVideoNode,
            execution: { phase: variant === "unsaved" ? "succeeded" : variant },
            content: { source: "https://media.test/first.mp4", storageKey: variant === "unsaved" ? undefined : "video:first" },
        }));
        assert.equal((await executeCanvasAgentComposition(f.options)).ok, false);
        assert.equal(f.counts().starts, 0);
    }
});

test("failed, canceled, and incomplete success responses cannot be finished films", async () => {
    for (const status of ["failed", "canceled", "succeeded"] as const) {
        const f = fixture();
        f.options.wait = async () => ({ ...f.final, status, resultData: { url: "https://media.test/result.mp4" } });
        assert.equal((await executeCanvasAgentComposition(f.options)).ok, false);
    }
});

test("resuming a running composition never creates another task", async () => {
    const f = fixture();
    await f.options.start(f.nodes().find(node => node.kind === "videoComposition")!);
    assert.equal((await executeCanvasAgentComposition(f.options)).ok, true);
    assert.equal(f.counts().starts, 1);
});

test("cancel after submission cancels the actual accepted task", async () => {
    const f = fixture();
    const start = f.options.start;
    f.options.start = async node => { const result = await start(node); f.controller.abort(); return result; };
    await assert.rejects(executeCanvasAgentComposition(f.options), { name: "AbortError" });
    assert.deepEqual(f.counts(), { starts: 1, cancels: 1 });
});

test("changed source storage keys invalidate an old completed film", async () => {
    const f = fixture();
    assert.equal((await executeCanvasAgentComposition(f.options)).ok, true);
    f.setNodes(f.nodes().map(node => node.id === "first" ? { ...node as CanvasVideoNode, content: { source: "https://media.test/new.mp4", storageKey: "video:new" } } : node));
    const result = await executeCanvasAgentComposition(f.options);
    assert.equal(result.ok, false);
    assert.equal(f.counts().starts, 2);
});
