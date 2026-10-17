import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createStoryboardNode, createTextNode, createVideoCompositionNode } from "../constants.ts";
import type { CanvasNode } from "../types.ts";
import { rememberCanvasTaskRuntime, rememberInterruptedCanvasTaskRuntime, restoreCanvasHistoryScene, sameCanvasEditingHistoryValue, sameCanvasHistoryValue } from "./canvas-history.ts";

const entry = (nodes: CanvasNode[]) => ({ nodes, connections: [], backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null });

test("restoring identical serialized nodes does not invalidate redo", () => {
    const entry = { nodes: [{ id: "a", frame: { position: { x: 1, y: 2 } }, content: { text: "draft" } }], connections: [] };
    assert.equal(sameCanvasHistoryValue(entry, structuredClone(entry)), true);
    const edited = structuredClone(entry);
    edited.nodes[0].content.text = "edited";
    assert.equal(sameCanvasHistoryValue(entry, edited), false);
    assert.equal(sameCanvasHistoryValue(entry, { ...entry, nodes: [] }), false);
    assert.equal(sameCanvasHistoryValue({ taskId: undefined }, {}), true);
    assert.equal(sameCanvasHistoryValue([undefined], []), false);
});

test("starting and updating an image task leaves edit history unchanged", () => {
    const image = createImageNode({ id: "image", position: { x: 0, y: 0 } });
    const running = structuredClone(image);
    running.execution = { phase: "running", taskId: "image-task", progress: 0 };
    assert.equal(sameCanvasEditingHistoryValue(entry([image]), entry([running])), true);
    const progressed = structuredClone(running);
    progressed.execution.progress = 50;
    assert.equal(sameCanvasEditingHistoryValue(entry([running]), entry([progressed])), true);
});

test("composition source snapshots are task metadata and survive undo while a task runs", () => {
    const original = createVideoCompositionNode({ id: "composition", position: { x: 0, y: 0 } });
    original.composition.inputVideoNodeIds = ["a", "b"];
    const running = structuredClone(original);
    running.execution = { phase: "running", taskId: "compose-task", progress: 15 };
    running.composition = { ...running.composition, resultVideoNodeId: "result", inputStorageKeys: ["video:a-new", "video:b"] };
    assert.equal(sameCanvasEditingHistoryValue(entry([original]), entry([running])), true);
    running.frame.position.x = 240;
    const restored = restoreCanvasHistoryScene(entry([original]), entry([running]), new Map()).nodes[0];
    assert.equal(restored.kind, "videoComposition");
    assert.equal(restored.frame.position.x, 0);
    assert.equal(restored.execution.taskId, "compose-task");
    if (restored.kind === "videoComposition") {
        assert.deepEqual(restored.composition.inputStorageKeys, ["video:a-new", "video:b"]);
        assert.equal(restored.composition.resultVideoNodeId, "result");
    }
});

test("undo after a composition finishes keeps the input snapshot paired with its real output", () => {
    const original = createVideoCompositionNode({ id: "composition", position: { x: 0, y: 0 } });
    original.composition = { inputVideoNodeIds: ["a", "b"], inputStorageKeys: ["video:a-old", "video:b"], resultVideoNodeId: "old-result" };
    original.execution = { phase: "running", taskId: "new-task" };
    const completed = structuredClone(original);
    completed.execution = { phase: "succeeded", progress: 100 };
    completed.composition = { ...completed.composition, inputStorageKeys: ["video:a-new", "video:b"], resultVideoNodeId: "new-result" };
    const restored = restoreCanvasHistoryScene(entry([original]), entry([completed]), new Map()).nodes[0];
    assert.equal(restored.kind, "videoComposition");
    assert.equal(restored.execution.phase, "succeeded");
    if (restored.kind === "videoComposition") {
        assert.deepEqual(restored.composition.inputStorageKeys, ["video:a-new", "video:b"]);
        assert.equal(restored.composition.resultVideoNodeId, "new-result");
    }
});

test("progress, streamed text and conversation updates do not consume edit history", () => {
    const text = createTextNode({ id: "text", position: { x: 0, y: 0 } });
    text.execution = { phase: "running", taskId: "text-task", progress: 10 };
    const streamed = structuredClone(text);
    streamed.execution.progress = 70;
    streamed.content.text = "流式响应";
    const conversationUpdate = { ...entry([streamed]), activeChatId: "new-conversation" };
    assert.equal(sameCanvasEditingHistoryValue(entry([text]), conversationUpdate), true);
    streamed.frame.position.x = 80;
    assert.equal(sameCanvasEditingHistoryValue(entry([text]), entry([streamed])), false);
});

test("task completion and output dimensions do not create a no-op undo step", () => {
    const image = createImageNode({ id: "image", position: { x: 0, y: 0 } });
    image.execution = { phase: "running", taskId: "image-task" };
    const completed = structuredClone(image);
    completed.execution = { phase: "succeeded", taskId: "image-task", progress: 100 };
    completed.content.source = "https://r2.example/result.png";
    completed.frame.height = 600;
    completed.frame.naturalWidth = 1024;
    completed.frame.naturalHeight = 1536;
    assert.equal(sameCanvasEditingHistoryValue(entry([image]), entry([completed])), true);
    const changedPrompt = structuredClone(completed);
    changedPrompt.generation.prompt = "新的提示词";
    assert.equal(sameCanvasEditingHistoryValue(entry([completed]), entry([changedPrompt])), false);
});

test("undo restores the edited frame while preserving completed task and media", () => {
    const original = createImageNode({ id: "image", position: { x: 0, y: 0 } });
    original.execution = { phase: "running", taskId: "image-task", progress: 5 };
    const latest = structuredClone(original);
    latest.frame.position.x = 200;
    latest.execution = { phase: "succeeded", taskId: "image-task", progress: 100 };
    latest.content = { source: "https://r2.example/result.png", storageKey: "result.png" };
    const restored = restoreCanvasHistoryScene(entry([original]), entry([latest]), new Map());
    assert.equal(restored.nodes[0].frame.position.x, 0);
    assert.deepEqual(restored.nodes[0].execution, latest.execution);
    assert.deepEqual((restored.nodes[0] as typeof latest).content, latest.content);
});

test("upload replacements after completion remain undoable", () => {
    const generated = createImageNode({ id: "image", position: { x: 0, y: 0 } });
    generated.execution = { phase: "succeeded", taskId: "image-task", progress: 100 };
    generated.content.source = "https://r2.example/generated.png";
    const uploaded = structuredClone(generated);
    uploaded.content.source = "https://r2.example/uploaded.png";
    assert.equal(sameCanvasEditingHistoryValue(entry([generated]), entry([uploaded])), false);
    const restored = restoreCanvasHistoryScene(entry([generated]), entry([uploaded]), new Map());
    assert.equal((restored.nodes[0] as typeof generated).content.source, generated.content.source);
});

test("undo deletion uses the remembered terminal task state", () => {
    const old = createImageNode({ id: "image", position: { x: 0, y: 0 } });
    old.execution = { phase: "running", taskId: "image-task" };
    const completed = structuredClone(old);
    completed.execution = { phase: "succeeded", taskId: "image-task" };
    completed.content.source = "https://r2.example/result.png";
    const registry = new Map<string, CanvasNode>();
    rememberCanvasTaskRuntime(registry, [old]);
    rememberCanvasTaskRuntime(registry, [completed]);
    const restored = restoreCanvasHistoryScene(entry([old]), entry([]), registry);
    assert.equal(restored.nodes[0].execution.phase, "succeeded");
    assert.equal((restored.nodes[0] as typeof completed).content.source, completed.content.source);
});

test("undo does not remove a live task node and filters dangling edges", () => {
    const running = createImageNode({ id: "running", position: { x: 0, y: 0 } });
    running.execution = { phase: "running", taskId: "task" };
    const source = createTextNode({ id: "source", position: { x: 0, y: 0 } });
    const link = { id: "edge", source: { nodeId: "source" }, target: { nodeId: "running" } };
    const restored = restoreCanvasHistoryScene(entry([source]), { ...entry([source, running]), connections: [link] }, new Map());
    assert.equal(restored.retainedRunningNodeCount, 1);
    assert.deepEqual(restored.nodes.map((node) => node.id), ["source", "running"]);
    assert.deepEqual(restored.connections, [link]);
    const withoutSource = restoreCanvasHistoryScene(entry([]), { ...entry([source, running]), connections: [link] }, new Map());
    assert.deepEqual(withoutSource.connections, []);
});

test("restoring an explicitly deleted running node marks it interrupted", () => {
    const running = createImageNode({ id: "running", position: { x: 0, y: 0 } });
    running.execution = { phase: "running", taskId: "task" };
    const restored = restoreCanvasHistoryScene(entry([running]), entry([]), new Map([[running.id, running]]));
    assert.equal(restored.nodes[0].execution.phase, "failed");
    assert.match(restored.nodes[0].execution.errorMessage || "", /重新生成/);
});

test("deletion remembers cancellation before the deletion state is rendered", () => {
    const running = createImageNode({ id: "running", position: { x: 0, y: 0 } });
    running.execution = { phase: "running", taskId: "task" };
    const completed = createImageNode({ id: "completed", position: { x: 0, y: 0 } });
    completed.execution = { phase: "succeeded", taskId: "completed-task" };
    completed.content.source = "https://r2.example/completed.png";
    const registry = new Map<string, CanvasNode>();
    rememberInterruptedCanvasTaskRuntime(registry, [running, completed], new Set([running.id, completed.id]));
    const restored = restoreCanvasHistoryScene(entry([running, completed]), entry([]), registry);
    assert.equal(restored.nodes[0].execution.phase, "failed");
    assert.equal(restored.nodes[1].execution.phase, "succeeded");
    assert.equal((restored.nodes[1] as typeof completed).content.source, completed.content.source);
});

test("shot batch progress and image results preserve editorial fields and undo", () => {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    board.storyboard.shots = [{ id: "shot", shotNumber: 1, durationSeconds: 5, visualDescription: "原脚本", shotSize: "全景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "镜头提示词", assetIds: [] }];
    board.storyboard.shotImageGeneration = { batchId: "batch", phase: "running", selectedShotIds: ["shot"], tasks: { shot: { taskId: "image-task", status: "running", progress: 10 } } };
    const finished = structuredClone(board);
    assert.ok(finished.storyboard.shotImageGeneration);
    finished.storyboard.shotImageGeneration.phase = "succeeded";
    finished.storyboard.shotImageGeneration.tasks.shot.status = "succeeded";
    finished.storyboard.shotImageGeneration.tasks.shot.progress = 100;
    finished.storyboard.shots[0].image = { source: "https://r2.example/shot.png" };
    assert.equal(sameCanvasEditingHistoryValue(entry([board]), entry([finished])), true);
    finished.storyboard.shots[0].visualDescription = "修改脚本";
    assert.equal(sameCanvasEditingHistoryValue(entry([board]), entry([finished])), false);
    const restored = restoreCanvasHistoryScene(entry([board]), entry([finished]), new Map());
    const restoredBoard = restored.nodes[0] as typeof board;
    assert.equal(restoredBoard.storyboard.shots[0].visualDescription, "原脚本");
    assert.equal(restoredBoard.storyboard.shots[0].image?.source, "https://r2.example/shot.png");
    assert.equal(restoredBoard.storyboard.shotImageGeneration?.phase, "succeeded");
    board.execution = { phase: "running", taskId: "script-task", progress: 20 };
    finished.execution = { phase: "running", taskId: "script-task", progress: 30 };
    assert.equal(sameCanvasEditingHistoryValue(entry([board]), entry([finished])), false);
    const whileMainTaskRuns = restoreCanvasHistoryScene(entry([board]), entry([finished]), new Map());
    assert.equal((whileMainTaskRuns.nodes[0] as typeof board).storyboard.shots[0].visualDescription, "原脚本");
    assert.equal(whileMainTaskRuns.nodes[0].execution.progress, 30);
});
