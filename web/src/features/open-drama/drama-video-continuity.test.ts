import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode } from "@/features/canvas/constants";
import type { CanvasStoryboardShot } from "@/features/canvas/types";
import type { ReferenceImage } from "@/features/generation/types/image";
import { assertDramaVideoShotUnchanged, captureDramaVideoShot, dramaShotVideoSignature, prepareDramaVideoReferences, previousContinuousShot, readDramaVideoDependencyIssue, runDramaVideoSequence } from "./drama-video-continuity";

function shot(id: string, number: number, transition: "establish" | "continue" | "cut" = "establish", sceneId = "室内"): CanvasStoryboardShot {
    return { id, shotNumber: number, durationSeconds: 8, visualDescription: `人物执行动作${number}`, shotSize: "中景", lightingAtmosphere: "自然光",
        dialogueVoiceover: "", cameraMovement: "固定", soundEffect: "", finalPrompt: "行动", assetIds: [],
        continuity: { sceneId, time: "白天", transition, openingState: "人物坐着", closingState: "人物站起", storyBeat: "发现线索" } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    const first = shot("first", 1), next = shot("next", 2, "continue");
    board.storyboard.shots = [first, next];
    first.video = { source: "/first.mp4", storageKey: "video-first", model: "model-A", size: "16:9" };
    first.video.sourceSignature = dramaShotVideoSignature(first, board);
    const references: ReferenceImage[] = [{ id: "old", name: "旧分镜图", type: "image/png", dataUrl: "/old.png", url: "/old.png" }];
    return { board, first, next, references, settings: { model: "model-A", size: "16:9" } };
}

test("完整提示词标记改变视频签名，未标记镜头与旧版已保存签名完全一致", () => {
    const source = shot("signature-shot", 1);
    source.visualDescription = "人物站起";
    source.finalPrompt = "人物行动";
    const legacySignature = "1081287e9414d94a";
    assert.equal(dramaShotVideoSignature(source), legacySignature);
    source.videoPromptContextMode = "self-contained";
    assert.notEqual(dramaShotVideoSignature(source), legacySignature);
    delete source.videoPromptContextMode;
    assert.equal(dramaShotVideoSignature(source), legacySignature);
});

test("最多同时生成5个独立场景，空列表安全返回，结果保持调用顺序", async () => {
    assert.deepEqual(await runDramaVideoSequence([], async () => true, () => {}), []);
    const items = Array.from({ length: 9 }, (_, index) => ({ shot: shot(String(index), index + 1) })).reverse();
    let active = 0, maximum = 0;
    const release = new Map<string, () => void>();
    const pending = runDramaVideoSequence(items, async item => {
        active++; maximum = Math.max(maximum, active);
        await new Promise<void>(resolve => release.set(item.shot.id, resolve));
        active--; return item.shot.id !== "7";
    }, () => {});
    await tick();
    assert.equal(active, 5); assert.equal(maximum, 5); assert.equal(release.size, 5);
    release.get("0")!();
    await tick();
    assert.equal(active, 5); assert.equal(release.size, 6);
    for (const resolve of release.values()) resolve();
    await tick();
    for (const resolve of release.values()) resolve();
    assert.deepEqual(await pending, items.map(item => item.shot.id !== "7"));
    assert.equal(maximum, 5);
});

test("连续镜头等待前镜完成，独立场景可并行且不受输入顺序干扰", async () => {
    const events: string[] = [];
    const items = [shot("a3", 3, "continue"), shot("b1", 4, "establish", "街道"), shot("a1", 1), shot("a2", 2, "continue")].map(shot => ({ shot }));
    const result = await runDramaVideoSequence(items, async item => {
        events.push(`start:${item.shot.id}`); await tick(); events.push(`end:${item.shot.id}`); return true;
    }, () => assert.fail("不应阻断"));
    assert.deepEqual(result, [true, true, true, true]);
    assert.ok(events.indexOf("end:a1") < events.indexOf("start:a2"));
    assert.ok(events.indexOf("end:a2") < events.indexOf("start:a3"));
    assert.ok(events.indexOf("start:b1") < events.indexOf("end:a1"));
});

test("失败或异常均阻止后续连续镜头，其他场景仍能完成", async () => {
    const attempted: string[] = [], blocked: string[] = [];
    const items = [shot("a1", 1), shot("a2", 2, "continue"), shot("b1", 3, "establish", "街道"), shot("c1", 4, "establish", "学校"), shot("c2", 5, "continue", "学校")].map(shot => ({ shot }));
    const result = await runDramaVideoSequence(items, async item => {
        attempted.push(item.shot.id);
        if (item.shot.id === "c1") throw new Error("模拟上游失败");
        return item.shot.id !== "a1";
    }, (item, message) => { assert.ok(message); blocked.push(item.shot.id); });
    assert.deepEqual(result, [false, false, true, false, false]);
    assert.deepEqual(new Set(attempted), new Set(["a1", "b1", "c1"]));
    assert.deepEqual(new Set(blocked), new Set(["a2", "c1", "c2"]));
});

test("连续镜头只使用前镜视频真正提取的尾帧，替换静态旧图", async () => {
    const { board, references, settings } = fixture();
    const calls: string[] = [];
    const result = await prepareDramaVideoReferences(board, "next", references, settings, async key => {
        calls.push(key); return { coverUrl: "/actual-tail.jpg", coverStorageKey: "tail-key" };
    });
    assert.deepEqual(calls, ["video-first"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, "/actual-tail.jpg");
    assert.equal(result[0].storageKey, "tail-key");
    assert.equal(references[0].url, "/old.png");
});

test("明确转场保持本镜参考图，不请求前镜尾帧", async () => {
    const { board, next, references, settings } = fixture();
    next.continuity!.transition = "cut";
    const result = await prepareDramaVideoReferences(board, "next", references, settings, async () => assert.fail("转场不应提取前镜"));
    assert.strictEqual(result, references);
    assert.equal(previousContinuousShot(board.storyboard.shots, "next"), undefined);
});

test("缺少前镜、前镜视频未保存、时空不一致、尾帧失败时均阻止提交", async () => {
    for (const mode of ["missing-shot", "missing-video", "no-storage", "different-scene", "different-time"] as const) {
        const { board, first, next, references, settings } = fixture();
        if (mode === "missing-shot") board.storyboard.shots = [next];
        if (mode === "missing-video") first.video = undefined;
        if (mode === "no-storage") delete first.video!.storageKey;
        if (mode === "different-scene") next.continuity!.sceneId = "街道";
        if (mode === "different-time") next.continuity!.time = "夜晚";
        await assert.rejects(prepareDramaVideoReferences(board, "next", references, settings, async () => assert.fail("不可请求尾帧")), /前镜|先完成/);
    }
    const { board, references, settings } = fixture();
    await assert.rejects(prepareDramaVideoReferences(board, "next", references, settings, async () => ({ coverUrl: "", coverStorageKey: "" })), /尾帧提取失败/);
});

test("模型和画幅必须与同场前镜一致", async () => {
    const { board, references } = fixture();
    for (const settings of [{ model: "model-B", size: "16:9" }, { model: "model-A", size: "9:16" }]) {
        await assert.rejects(prepareDramaVideoReferences(board, "next", references, settings, async () => assert.fail("不同设置不应提取尾帧")), /模型不一致|画幅不一致/);
    }
});

test("前镜剧情、动作、身份参考图变化使旧视频签名失效", async () => {
    for (const mode of ["prompt", "state", "asset", "image"] as const) {
        const { board, first, references, settings } = fixture();
        if (mode === "prompt") first.visualDescription += "改为转身离开";
        if (mode === "state") first.continuity!.closingState = "人物跑到门外";
        if (mode === "asset") { first.assetIds = ["hero"]; board.storyboard.assets = [{ id: "hero", kind: "character", name: "角色", description: "蓝衣", image: { source: "/hero.png" } }]; }
        if (mode === "image") first.image = { source: "/new-first.png" };
        await assert.rejects(prepareDramaVideoReferences(board, "next", references, settings, async () => assert.fail("旧视频不可提取尾帧")), /已修改/);
    }
});

test("记录实际前镜视频依赖，前镜同提示词重生也会使后镜旧视频失效", () => {
    const { board, first, next } = fixture();
    const captured = captureDramaVideoShot(board, next.id);
    assert.equal(captured.previousVideoStorageKey, "video-first");
    assert.doesNotThrow(() => assertDramaVideoShotUnchanged(captured, board));
    next.video = { source: "/second.mp4", storageKey: "video-second", sourceSignature: captured.signature, previousVideoStorageKey: captured.previousVideoStorageKey };
    assert.equal(readDramaVideoDependencyIssue(board, next), null);
    const ownSignature = dramaShotVideoSignature(next, board);
    first.video = { ...first.video!, source: "/first-new.mp4", storageKey: "video-first-new" };
    assert.equal(dramaShotVideoSignature(next, board), ownSignature, "剧情签名不递归包含视频依赖，避免队列中前镜完成引起误失效");
    assert.match(readDramaVideoDependencyIssue(board, next) || "", /前镜视频已替换/);
    assert.throws(() => assertDramaVideoShotUnchanged(captured, board), /前镜视频已替换/);
    assert.equal(captureDramaVideoShot(board, next.id).previousVideoStorageKey, "video-first-new");
});

test("单镜快照阻止晚到结果覆盖新剧情、新参考图及已删除分镜", () => {
    for (const change of ["prompt", "image", "delete", "replace-board"] as const) {
        const { board, first } = fixture();
        const snapshot = captureDramaVideoShot(board, first.id);
        if (change === "prompt") first.visualDescription = "用户已改为逃离";
        if (change === "image") first.image = { source: "/new-frame.png" };
        if (change === "delete") board.storyboard.shots = [];
        if (change === "replace-board") board.id = "replacement";
        assert.throws(() => assertDramaVideoShotUnchanged(snapshot, board), /已修改|已被替换|已删除或替换/);
    }
});

test("前镜自身依赖已过时不能再把它的尾帧用于第三镜", async () => {
    const { board, first, next, references, settings } = fixture();
    const third = shot("third", 3, "continue");
    const secondSnapshot = captureDramaVideoShot(board, next.id);
    next.video = { source: "/second.mp4", storageKey: "video-second", sourceSignature: secondSnapshot.signature, previousVideoStorageKey: secondSnapshot.previousVideoStorageKey };
    board.storyboard.shots.push(third);
    assert.equal(captureDramaVideoShot(board, third.id).previousVideoStorageKey, "video-second");
    first.video!.storageKey = "new-first";
    await assert.rejects(prepareDramaVideoReferences(board, third.id, references, settings, async () => assert.fail("不可使用过期前镜尾帧")), /前镜视频已替换/);
});

test("独立转场不依赖前镜视频，清除前镜不使它的快照失效", () => {
    const { board, first, next } = fixture();
    next.continuity!.transition = "cut";
    const snapshot = captureDramaVideoShot(board, next.id);
    assert.equal(snapshot.previousVideoStorageKey, undefined);
    first.video = undefined;
    assert.doesNotThrow(() => assertDramaVideoShotUnchanged(snapshot, board));
});
