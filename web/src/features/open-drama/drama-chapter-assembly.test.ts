import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode, createVideoNode } from "@/features/canvas/constants";
import { createCanvasDocument } from "@/features/canvas/domain/canvas-document";
import type { CanvasStoryboardShot } from "@/features/canvas/types";
import { assertPreparedChapterPlan, materializeChapterAssembly, readChapterAssemblyPlan } from "./drama-chapter-assembly";
import { prepareDramaVideoMedia } from "./drama-video-preparation";
import type { DramaAssemblyState } from "./drama-assembly";

function fixture() {
    const document = createCanvasDocument({ id: "chapter-compose", title: "短剧", now: "2026-10-07" });
    const board = createStoryboardNode({ id: "board", title: "第一章", position: { x: 0, y: 0 } });
    board.dramaChapterId = "chapter";
    board.storyboard.shots = [3, 1, 2].map((number): CanvasStoryboardShot => ({
        id: `shot-${number}`, shotNumber: number, durationSeconds: 5, visualDescription: "剧情", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "提示词", assetIds: [],
        ...(number !== 2 ? { video: { source: `https://media.test/${number}.mp4`, storageKey: `key-${number}` } } : {}),
    }));
    const extraTake = createVideoNode({ id: "duplicate-take", position: { x: 0, y: 0 } });
    extraTake.dramaStoryboardId = board.id; extraTake.dramaShotId = "shot-1";
    extraTake.content = { source: "https://media.test/old.mp4", storageKey: "old-take" };
    document.scene.nodes = [board, extraTake];
    document.preferences.drama = { version: 1, chapters: [{ id: "chapter", title: "第一章", storyboardNodeId: board.id }, { id: "missing-chapter", title: "未生成章节", storyboardNodeId: "missing" }], assets: [], activeChapterId: "chapter", view: "canvas" };
    return { document, board, plan: () => readChapterAssemblyPlan(document, document.scene.nodes, "chapter") };
}

test("按镜号排序，只取分镜当前版本，显示未生成镜头且不依赖其他章节", () => {
    const { plan } = fixture();
    assert.deepEqual(plan().ready.map(shot => shot.shotNumber), [1, 3]);
    assert.deepEqual(plan().missing.map(shot => shot.shotNumber), [2]);
    assert.deepEqual(plan().sourceKeys, ["key-1", "key-3"]);
    assert.equal(plan().error, "");
    assert.equal(plan().durationSeconds, 10);
});

test("不同镜头刻意复用同一视频仍保留两段，重复分镜标识阻止合成", () => {
    const { board, plan } = fixture();
    board.storyboard.shots[0].video = board.storyboard.shots[1].video;
    assert.deepEqual(plan().sourceKeys, ["key-1", "key-1"]);
    board.storyboard.shots.push(board.storyboard.shots[0]);
    assert.match(plan().error, /标识重复/);
});

test("镜序、片段替换或补齐缺镜都会使旧成片失效", () => {
    for (const change of ["order", "media", "missing"] as const) {
        const { board, plan } = fixture();
        const before = plan();
        if (change === "order") board.storyboard.shots[0] = { ...board.storyboard.shots[0], shotNumber: 4 };
        if (change === "media") board.storyboard.shots[0] = { ...board.storyboard.shots[0], video: { source: "new.mp4", storageKey: "new" } };
        if (change === "missing") board.storyboard.shots[2] = { ...board.storyboard.shots[2], video: { source: "2.mp4", storageKey: "key-2" } };
        assert.notEqual(before.sourceSignature, plan().sourceSignature);
        assert.throws(() => assertPreparedChapterPlan(before, plan()), /变化/);
    }
});

test("只准备指定章节的可用片段，保留全剧合成完整性限制", async () => {
    const { document, board, plan } = fixture();
    board.storyboard.shots[0].video = { source: "https://media.test/3.mp4" };
    const before = plan();
    const stored: string[] = [];
    const options = {
        store: async (source: string) => { stored.push(source); return { url: "https://r2.test/3.mp4", storageKey: "stored-3" }; },
        onVideo: async (_boardId: string, id: string, _source: string, video: NonNullable<CanvasStoryboardShot["video"]>) => {
            board.storyboard.shots = board.storyboard.shots.map(shot => shot.id === id ? { ...shot, video } : shot);
        },
    };
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, options), /无法准备完整短剧/);
    assert.equal(stored.length, 0);
    await prepareDramaVideoMedia(document, document.scene.nodes, { ...options, selection: { chapterId: "chapter", shotIds: before.ready.map(shot => shot.id) } });
    assert.deepEqual(stored, ["https://media.test/3.mp4"]);
    assert.doesNotThrow(() => assertPreparedChapterPlan(before, plan()));
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, { ...options, selection: { chapterId: "chapter", shotIds: ["shot-2"] } }), /缺少视频/);
});

test("完成与恢复只生成一个成片节点，原片段和位置保持不变", () => {
    const { document, plan } = fixture();
    const before = structuredClone(document.scene.nodes);
    const state: DramaAssemblyState = { version: 1, phase: "succeeded", sourceKeys: plan().sourceKeys, batches: [], result: { storageKey: "film", url: "https://r2.test/film.mp4", durationMilliseconds: 10000, width: 1280, height: 720 } };
    const once = materializeChapterAssembly(document.scene.nodes, plan(), state);
    const twice = materializeChapterAssembly(once, plan(), state);
    assert.equal(twice.length, before.length + 1);
    assert.deepEqual(twice.slice(0, before.length), before);
    assert.match(twice.at(-1)!.title, /片段合成/);
    assert.equal(twice.at(-1)!.dramaChapterId, "chapter");
    assert.deepEqual(materializeChapterAssembly(before, plan(), { ...state, phase: "failed" }), before);
});
