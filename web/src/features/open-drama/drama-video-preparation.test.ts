import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode, createTextNode } from "@/features/canvas/constants";
import { createCanvasDocument } from "@/features/canvas/domain/canvas-document";
import type { CanvasStoryboardShot, CanvasStoryboardShotVideo } from "@/features/canvas/types";
import { prepareDramaVideoMedia } from "./drama-video-preparation";

function fixture() {
    const document = createCanvasDocument({ id: "prepare", title: "完整短剧", now: "2026-09-30" });
    const script = createTextNode({ id: "script", text: "开端经过结局", position: { x: 0, y: 0 } });
    const board = createStoryboardNode({ id: "board", title: "第一章", position: { x: 0, y: 0 } });
    board.storyboard.shots = [1, 2, 3].map((number): CanvasStoryboardShot => ({
        id: `shot-${number}`, shotNumber: number, durationSeconds: 5, visualDescription: "剧情", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "提示词", assetIds: [],
        video: { source: `/original-${number}.mp4`, poster: `/poster-${number}.png` },
    }));
    document.scene.nodes = [board, script];
    document.preferences.drama = { version: 1, chapters: [{ id: "chapter", title: "第一章", storyboardNodeId: board.id, scriptNodeId: script.id }], assets: [], activeChapterId: "chapter", view: "shots" };
    return { document, board };
}

test("完整性检查先于存储：缺章或视频时不保存任何片段", async () => {
    const { document, board } = fixture();
    const calls: string[] = [];
    board.storyboard.shots[1].video = undefined;
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => { calls.push(source); return { url: source, storageKey: source }; },
        onVideo: async () => { calls.push("write"); },
    }), /第一章：镜头 2 缺少视频/);
    assert.equal(calls.length, 0);
    document.scene.nodes = document.scene.nodes.filter(node => node.id !== board.id);
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => { calls.push(source); return { url: source, storageKey: source }; },
        onVideo: async () => { calls.push("write"); },
    }), /分镜节点缺失/);
    assert.equal(calls.length, 0);
});

test("已有存储跳过，同源只下载一次，逐镜等待回填并保留各自封面", async () => {
    const { document, board } = fixture();
    board.storyboard.shots[0].video!.storageKey = "existing";
    board.storyboard.shots[2].video!.source = "/original-2.mp4";
    const operations: string[] = [];
    const writes: Array<{ id: string; media: CanvasStoryboardShotVideo }> = [];
    const snapshot = JSON.stringify(document);
    await prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => { operations.push(`store:${source}`); return { url: "https://media.test/stored.mp4", storageKey: "new-video", mimeType: "video/mp4" }; },
        onVideo: async (boardId, id, original, media) => {
            assert.equal(boardId, board.id);
            assert.equal(original, "/original-2.mp4");
            operations.push(`write:${id}`);
            await Promise.resolve();
            writes.push({ id, media });
            operations.push(`saved:${id}`);
        },
    });
    assert.deepEqual(operations, ["store:/original-2.mp4", "write:shot-2", "saved:shot-2", "write:shot-3", "saved:shot-3"]);
    assert.deepEqual(writes.map(write => write.media.poster), ["/poster-2.png", "/poster-3.png"]);
    assert.ok(writes.every(write => write.media.source === "https://media.test/stored.mp4" && write.media.storageKey === "new-video"));
    assert.equal(JSON.stringify(document), snapshot);
});

test("中途下载失败立即结束，再次提交只处理未持久化镜头", async () => {
    const { document, board } = fixture();
    const calls: string[] = [];
    const persist = async (_boardId: string, shotId: string, original: string, media: CanvasStoryboardShotVideo) => {
        const shot = board.storyboard.shots.find(shot => shot.id === shotId)!;
        assert.equal(shot.video!.source, original);
        shot.video = media;
    };
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => {
            calls.push(source);
            if (source === "/original-2.mp4") throw new Error("远程视频失效");
            return { url: `https://media.test${source}`, storageKey: source };
        }, onVideo: persist,
    }), /第一章 · 镜头 2 视频保存失败：远程视频失效/);
    assert.deepEqual(calls, ["/original-1.mp4", "/original-2.mp4"]);
    calls.length = 0;
    await prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => { calls.push(source); return { url: `https://media.test${source}`, storageKey: source }; }, onVideo: persist,
    });
    assert.deepEqual(calls, ["/original-2.mp4", "/original-3.mp4"]);
    assert.ok(board.storyboard.shots.every(shot => shot.video?.storageKey));
});

test("存储返回无效结果或回填失败时不继续后续镜头", async () => {
    const { document } = fixture();
    const calls: string[] = [];
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => { calls.push(source); return { url: source, storageKey: " " }; },
        onVideo: async () => { calls.push("write"); },
    }), /第一章 · 镜头 1 视频保存失败：存储服务未返回/);
    assert.deepEqual(calls, ["/original-1.mp4"]);
    calls.length = 0;
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => { calls.push(source); return { url: source, storageKey: "key" }; },
        onVideo: async () => { throw new Error("工程已切换"); },
    }), /第一章 · 镜头 1 记录保存失败：工程已切换/);
    assert.deepEqual(calls, ["/original-1.mp4"]);
});

test("下载期间切换工程时中止回填且不发后续下载，AbortError 原样传播", async () => {
    const { document } = fixture();
    const controller = new AbortController();
    const reason = new DOMException("工程已切换", "AbortError");
    const calls: string[] = [];
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        signal: controller.signal,
        store: async source => {
            calls.push(source);
            controller.abort(reason);
            return { url: source, storageKey: "stored" };
        },
        onVideo: async () => { calls.push("write"); },
    }), error => error === reason);
    assert.deepEqual(calls, ["/original-1.mp4"]);
});

test("逐镜保存后中止时后续下载不启动，已经中止的准备不做工作", async () => {
    const { document } = fixture();
    const controller = new AbortController();
    const reason = new DOMException("页面已卸载", "AbortError");
    const calls: string[] = [];
    const options = {
        signal: controller.signal,
        store: async (source: string) => { calls.push(source); return { url: source, storageKey: source }; },
        onVideo: async () => { calls.push("write"); controller.abort(reason); },
    };
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, options), error => error === reason);
    assert.deepEqual(calls, ["/original-1.mp4", "write"]);
    calls.length = 0;
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, options), error => error === reason);
    assert.equal(calls.length, 0);
});

test("存储和回填主动抛出的 AbortError 均保持原错误", async () => {
    const { document } = fixture();
    const reason = new DOMException("取消操作", "AbortError");
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async () => { throw reason; }, onVideo: async () => { assert.fail("不应回填"); },
    }), error => error === reason);
    await assert.rejects(prepareDramaVideoMedia(document, document.scene.nodes, {
        store: async source => ({ url: source, storageKey: source }), onVideo: async () => { throw reason; },
    }), error => error === reason);
});
