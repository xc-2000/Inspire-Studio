import assert from "node:assert/strict";
import test from "node:test";

import { createStoryboardNode, createTextNode } from "../constants.ts";
import type { CanvasDocumentPersistence } from "../services/canvas-document-persistence.ts";
import type { CanvasScene } from "../types.ts";
import { createCanvasStore } from "./create-canvas-store.ts";

test("快照恢复等待持久化并同时还原场景、会话和剪辑草稿", async () => {
    let saved: import("../types.ts").CanvasDocument | undefined;
    const store = createCanvasStore({
        createId: () => "snapshot-project", createTimestamp: () => "2026-09-27", persistence: createMemoryPersistence(), onDeleteError: () => {},
        saveScheduler: { saveNow: async document => { await Promise.resolve(); saved = structuredClone(document); }, schedule: () => {}, cancel: () => {} },
    });
    store.getState().createDocument("快照测试");
    const snapshot = structuredClone(store.getState().findDocument("snapshot-project")!);
    snapshot.scene.nodes = [createTextNode({ id:"input", position:{x:0,y:0}, text:"保留文字" })];
    snapshot.preferences.videoTimeline = { clips:[], subtitles:[{id:"s",startMs:0,endMs:1000,text:"字幕"}], fontSize:36 };
    await store.getState().saveSnapshot(snapshot);
    assert.equal(saved!.scene.nodes.length,1);
    assert.equal(saved!.preferences.videoTimeline!.subtitles[0].text,"字幕");
    snapshot.preferences.videoTimeline = undefined;
    await store.getState().saveSnapshot(snapshot);
    assert.equal(store.getState().findDocument("snapshot-project")!.preferences.videoTimeline, undefined);
    assert.equal(saved!.preferences.videoTimeline, undefined);
});

test("新建画布文档立即写入状态并保存", () => {
    const savedDocumentIds: string[] = [];
    const store = createCanvasStore({
        createId: () => "document-1",
        createTimestamp: () => "2026-07-12T00:00:00.000Z",
        persistence: createMemoryPersistence(),
        onDeleteError: () => assert.fail("不应删除失败"),
        saveScheduler: {
            saveNow: async (document) => {
                savedDocumentIds.push(document.identity.id);
            },
            schedule: () => undefined,
            cancel: () => undefined,
        },
    });

    const documentId = store.getState().createDocument("测试画布");

    assert.equal(documentId, "document-1");
    assert.equal(store.getState().documents[0].identity.title, "测试画布");
    assert.deepEqual(savedDocumentIds, ["document-1"]);
});

test("分镜节点及其剧本连线可随画布场景序列化保存", () => {
    const scheduledScenes: CanvasScene[] = [];
    const store = createCanvasStore({
        createId: () => "document-1",
        createTimestamp: () => "2026-08-08T00:00:00.000Z",
        persistence: createMemoryPersistence(),
        onDeleteError: () => assert.fail("不应删除失败"),
        saveScheduler: {
            saveNow: async () => undefined,
            schedule: (document) => scheduledScenes.push(document.scene),
            cancel: () => undefined,
        },
    });
    const documentId = store.getState().createDocument("分镜画布");
    const script = createTextNode({ id: "text-1", position: { x: 0, y: 0 }, text: "侦探在雨夜追逐嫌疑人。" });
    const storyboard = createStoryboardNode({ id: "storyboard-1", position: { x: 440, y: 0 } });
    storyboard.content = { instruction: "生成雨夜追逐片段", visualStyle: "国风手绘厚涂", model: "channel-1::story-model" };
    storyboard.storyboard = {
        shots: [{ id: "shot-1", shotNumber: 1, durationSeconds: 5, visualDescription: "雨夜街道", shotSize: "远景", lightingAtmosphere: "霓虹反光", dialogueVoiceover: "别跑", soundEffect: "雨声", cameraMovement: "推进", finalPrompt: "雨夜街道远景，侦探追逐嫌疑人，霓虹反光，镜头推进。", assetIds: ["asset-1"] }],
        assets: [{ id: "asset-1", kind: "character", name: "侦探", description: "黑色风衣" }],
    };
    const scene: CanvasScene = {
        nodes: [script, storyboard],
        connections: [{ id: "connection-1", source: { nodeId: script.id }, target: { nodeId: storyboard.id } }],
        viewport: { offsetX: 0, offsetY: 0, zoom: 1 },
    };

    store.getState().replaceScene(documentId, scene);
    const serializedScene = JSON.parse(JSON.stringify(store.getState().findDocument(documentId)?.scene)) as CanvasScene;
    const restoredStoryboard = serializedScene.nodes.find((node) => node.id === storyboard.id);

    assert.equal(restoredStoryboard?.kind, "storyboard");
    if (!restoredStoryboard || restoredStoryboard.kind !== "storyboard") throw new Error("应恢复分镜节点");
    assert.equal(restoredStoryboard.content.instruction, "生成雨夜追逐片段");
    assert.equal(restoredStoryboard.content.visualStyle, "国风手绘厚涂");
    assert.equal(restoredStoryboard.storyboard.shots[0].finalPrompt, "雨夜街道远景，侦探追逐嫌疑人，霓虹反光，镜头推进。");
    assert.deepEqual(restoredStoryboard.storyboard.shots[0].assetIds, ["asset-1"]);
    assert.equal(restoredStoryboard.storyboard.assets[0].name, "侦探");
    assert.equal(serializedScene.connections[0].target.nodeId, storyboard.id);
    assert.equal(scheduledScenes.length, 1);
});

test("并发加载画布文档只请求一次", async () => {
    let loadCount = 0;
    let releaseLoad: (() => void) | undefined;
    const loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve;
    });
    const persistence = createMemoryPersistence();
    persistence.loadDocuments = async () => {
        loadCount += 1;
        await loadGate;
        return [];
    };
    const store = createCanvasStore({
        createId: () => "document-1",
        createTimestamp: () => "2026-07-12T00:00:00.000Z",
        persistence,
        onDeleteError: () => assert.fail("不应删除失败"),
        saveScheduler: {
            saveNow: async () => undefined,
            schedule: () => undefined,
            cancel: () => undefined,
        },
    });

    const firstLoading = store.getState().hydrateDocuments();
    const secondLoading = store.getState().hydrateDocuments();
    assert.equal(loadCount, 1);

    // A slow library request must not erase a canvas created after navigation.
    store.getState().createDocument("加载期间新建");

    releaseLoad?.();
    await Promise.all([firstLoading, secondLoading]);

    assert.equal(store.getState().hydrated, true);
    assert.equal(store.getState().findDocument("document-1")?.identity.title, "加载期间新建");
});

test("删除持久化失败时通过依赖明确上报", async () => {
    const errors: unknown[] = [];
    const persistence = createMemoryPersistence();
    persistence.deleteDocuments = async () => {
        throw new Error("删除失败");
    };
    const store = createCanvasStore({
        createId: () => "document-1",
        createTimestamp: () => "2026-07-12T00:00:00.000Z",
        persistence,
        onDeleteError: (_documentIds, error) => errors.push(error),
        saveScheduler: {
            saveNow: async () => undefined,
            schedule: () => undefined,
            cancel: () => undefined,
        },
    });

    await assert.rejects(store.getState().deleteDocuments(["document-1"]), /删除失败/);

    assert.equal(errors.length, 1);
});

function createMemoryPersistence(): CanvasDocumentPersistence {
    return {
        loadDocuments: async () => [],
        saveDocument: async () => undefined,
        deleteDocuments: async () => undefined,
    };
}

test("打开单个画布只读详情，并发去重且保留完整内容", async () => {
    const source = createCanvasStore({ createId: () => "detail", createTimestamp: () => "2026-10-13", persistence: createMemoryPersistence(), onDeleteError: () => {}, saveScheduler: { saveNow: async () => {}, schedule: () => {}, cancel: () => {} } });
    source.getState().createDocument("详情");
    const document = source.getState().findDocument("detail")!;
    document.scene.nodes = [createTextNode({ id: "text", position: { x: 0, y: 0 }, text: "完整剧本文本" })];
    let requests = 0;
    const store = createCanvasStore({
        createId: () => "other", createTimestamp: () => "2026-10-13", onDeleteError: () => {},
        persistence: { ...createMemoryPersistence(), loadDocuments: async () => { throw new Error("不应该加载全库"); }, loadDocument: async () => { requests++; await Promise.resolve(); return document; } },
        saveScheduler: { saveNow: async () => {}, schedule: () => {}, cancel: () => {} },
    });
    await Promise.all([store.getState().loadDocument("detail"), store.getState().loadDocument("detail")]);
    assert.equal(requests, 1);
    assert.equal(store.getState().findDocument("detail")?.scene.nodes.length, 1);
    assert.equal(store.getState().hydrated, false, "部分详情缓存不能被当作完整库用于清理素材");
    await store.getState().loadDocument("detail");
    assert.equal(requests, 1);
});

test("详情失败可重试，切换账号后旧请求不能回写", async () => {
    const source = createCanvasStore({ createId: () => "detail", createTimestamp: () => "2026-10-13", persistence: createMemoryPersistence(), onDeleteError: () => {}, saveScheduler: { saveNow: async () => {}, schedule: () => {}, cancel: () => {} } });
    source.getState().createDocument();
    const document = source.getState().findDocument("detail")!;
    let fail = true;
    const store = createCanvasStore({ createId: () => "x", createTimestamp: () => "2026-10-13", onDeleteError: () => {},
        persistence: { ...createMemoryPersistence(), loadDocument: async () => { await Promise.resolve(); if (fail) throw new Error("断网"); return document; } },
        saveScheduler: { saveNow: async () => {}, schedule: () => {}, cancel: () => {} },
    });
    await assert.rejects(store.getState().loadDocument("detail"), /断网/);
    fail = false;
    const pending = store.getState().loadDocument("detail");
    store.getState().resetDocuments();
    await assert.rejects(pending, /账号已切换/);
    assert.equal(store.getState().documents.length, 0);
    await store.getState().loadDocument("detail");
    assert.equal(store.getState().documents.length, 1);
    await store.getState().deleteDocuments(["detail"]);
    assert.deepEqual(store.getState().deletedDocumentIds, ["detail"]);
    assert.equal(store.getState().documents.length, 0);
});

test("离开前立即保存读取最新场景，失败保留明确错误并阻止成功返回", async () => {
    let failure = false;
    let savedText = "";
    const store = createCanvasStore({
        createId: () => "flush-project", createTimestamp: () => "2026-09-30", persistence: createMemoryPersistence(), onDeleteError: () => {},
        saveScheduler: {
            saveNow: async document => {
                if (failure) throw new Error("保存接口不可用");
                const node = document.scene.nodes[0];
                savedText = node?.kind === "text" ? node.content.text : "";
            }, schedule: () => {}, cancel: () => {},
        },
    });
    const id = store.getState().createDocument();
    const document = store.getState().findDocument(id)!;
    store.getState().replaceScene(id, { ...document.scene, nodes: [createTextNode({ id: "draft", position: { x: 0, y: 0 }, text: "最新文字" })] });
    await store.getState().flushDocument(id);
    assert.equal(savedText, "最新文字");
    failure = true;
    await assert.rejects(store.getState().flushDocument(id), /保存接口不可用/);
    assert.equal(store.getState().saveStatuses[id].phase, "failed");
    assert.equal(store.getState().hasUnsavedChanges(id), true);
    assert.equal(store.getState().findDocument(id)!.scene.nodes.length, 1);
    store.getState().setSaveStatus(id, { phase: "saved", savedAt: "2026-09-30" });
    assert.equal(store.getState().saveErrors[id], "");
    assert.equal(store.getState().hasUnsavedChanges(id), false);
});
