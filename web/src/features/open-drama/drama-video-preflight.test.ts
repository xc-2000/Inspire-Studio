import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode } from "@/features/canvas/constants";
import type { CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { captureDramaVideoShot } from "./drama-video-continuity";
import { readDramaVideoContinuationSettings, readDramaVideoPreflight } from "./drama-video-preflight";

const settings = { model: "model-A", size: "16:9" };

function shot(number: number, transition: "establish" | "continue" = "establish"): CanvasStoryboardShot {
    return { id: `shot-${number}`, shotNumber: number, durationSeconds: 8, visualDescription: `人物完成动作${number}`, shotSize: "中景",
        lightingAtmosphere: "自然光", dialogueVoiceover: "", cameraMovement: "固定", soundEffect: "", finalPrompt: "人物行动", assetIds: [],
        continuity: { sceneId: "室内", time: "白天", transition, openingState: "人物坐着", closingState: "人物站起", storyBeat: "发现线索" } };
}

function fixture() {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    const first = shot(4), second = shot(5, "continue"), third = shot(6, "continue");
    board.storyboard.shots = [shot(1), first, second, third, shot(7)];
    return { board, first, second, third };
}

function save(board: CanvasStoryboardNode, shot: CanvasStoryboardShot, key = `video-${shot.id}`) {
    const snapshot = captureDramaVideoShot(board, shot.id);
    shot.video = { source: `/${key}.mp4`, storageKey: key, ...settings,
        sourceSignature: snapshot.signature, previousVideoStorageKey: snapshot.previousVideoStorageKey };
}

test("单选镜头6明确建议缺失前镜4和5，保持输入和选择不变", () => {
    const { board, third } = fixture();
    third.image = { source: "/shot6.png" };
    const selected = [third.id];
    const before = JSON.stringify(board);
    const result = readDramaVideoPreflight(board, selected, settings);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].shotId, "shot-6");
    assert.match(result.issues[0].message, /请先完成镜头 5/);
    assert.deepEqual(result.issues[0].prerequisiteShotIds, ["shot-4", "shot-5"]);
    assert.deepEqual(result.prerequisiteShotIds, ["shot-4", "shot-5"]);
    assert.deepEqual(selected, ["shot-6"]);
    assert.equal(JSON.stringify(board), before);
});

test("可用的前镜4停止补齐链，不涉及其他独立场景", () => {
    const { board, first } = fixture();
    save(board, first);
    const result = readDramaVideoPreflight(board, ["shot-6"], settings);
    assert.deepEqual(result.prerequisiteShotIds, ["shot-5"]);
    assert.ok(!result.prerequisiteShotIds.includes("shot-1"));
    assert.ok(!result.prerequisiteShotIds.includes("shot-7"));
    assert.deepEqual(readDramaVideoPreflight(board, [], settings), { issues: [], prerequisiteShotIds: [] });
});

test("同批已选前镜按镜号视为未来完成，不受选择顺序影响", () => {
    const { board } = fixture();
    assert.deepEqual(readDramaVideoPreflight(board, ["shot-6", "shot-4", "shot-5"], settings), { issues: [], prerequisiteShotIds: [] });
    const partial = readDramaVideoPreflight(board, ["shot-6", "shot-5"], settings);
    assert.deepEqual(partial.issues.map(issue => issue.shotId), ["shot-5", "shot-6"]);
    assert.deepEqual(partial.prerequisiteShotIds, ["shot-4"]);
});

test("前镜剧情签名失效需要重生，前镜链自身失效时继续向前补齐", () => {
    const { board, first, second } = fixture();
    save(board, first);
    save(board, second);
    second.image = { source: "/changed-shot5.png" };
    const firstResult = readDramaVideoPreflight(board, ["shot-6"], settings);
    assert.match(firstResult.issues[0].message, /剧情或参考图已修改/);
    assert.deepEqual(firstResult.prerequisiteShotIds, ["shot-5"]);
    first.visualDescription += "然后离开";
    assert.deepEqual(readDramaVideoPreflight(board, ["shot-6"], settings).prerequisiteShotIds, ["shot-4", "shot-5"]);
});

test("前镜旧视频依赖已替换时只补齐受影响的镜头", () => {
    const { board, first, second } = fixture();
    save(board, first);
    save(board, second);
    first.video!.storageKey = "replacement-shot4"; // gitleaks:allow -- synthetic redaction/storage-key fixture, not a credential
    const result = readDramaVideoPreflight(board, ["shot-6"], settings);
    assert.match(result.issues[0].message, /前镜视频已替换/);
    assert.deepEqual(result.prerequisiteShotIds, ["shot-5"]);
});

test("前镜只有未保存的视频也须补齐，当前可用视频允许单镜生成", () => {
    const { board, first, second } = fixture();
    save(board, first);
    save(board, second);
    assert.deepEqual(readDramaVideoPreflight(board, ["shot-6"], settings), { issues: [], prerequisiteShotIds: [] });
    delete second.video!.storageKey;
    const result = readDramaVideoPreflight(board, ["shot-6"], settings);
    assert.match(result.issues[0].message, /保存视频/);
    assert.deepEqual(result.prerequisiteShotIds, ["shot-5"]);
});

test("新模型或画幅与旧前镜不一致，同批重生全部连续镜头则可通过", () => {
    for (const nextSettings of [{ model: "model-B", size: "16:9" }, { model: "model-A", size: "9:16" }]) {
        const { board, first, second } = fixture();
        save(board, first);
        save(board, second);
        const single = readDramaVideoPreflight(board, ["shot-6"], nextSettings);
        assert.match(single.issues[0].message, /模型不一致|画幅不一致/);
        assert.deepEqual(single.prerequisiteShotIds, ["shot-4", "shot-5"]);
        assert.deepEqual(readDramaVideoPreflight(board, ["shot-4", "shot-5", "shot-6"], nextSettings), { issues: [], prerequisiteShotIds: [] });
    }
});

test("结构和台词错误在提交前阻止生成，勾选前镜不会绕过检查", () => {
    for (const change of ["missing-continuity", "different-scene", "blank-time", "speech-too-long"] as const) {
        const { board, third } = fixture();
        if (change === "missing-continuity") third.continuity = undefined;
        if (change === "different-scene") third.continuity!.sceneId = "街道";
        if (change === "blank-time") third.continuity!.time = "";
        if (change === "speech-too-long") { third.durationSeconds = 1; third.dialogueVoiceover = "人物：这段台词远远超过了一秒能够说完的长度。"; }
        const result = readDramaVideoPreflight(board, ["shot-4", "shot-5", "shot-6"], settings);
        assert.equal(result.issues.length, 1, change);
        assert.equal(result.issues[0].shotId, third.id);
        assert.match(result.issues[0].message, /尚未规划|场景、时间不一致|缺少同一时空|台词预计/);
        assert.deepEqual(result.prerequisiteShotIds, []);
    }
});

test("无法修复的前镜结构不会产生无效的补齐建议或沿用它的旧视频", () => {
    const { board, first, second } = fixture();
    save(board, first);
    save(board, second);
    second.durationSeconds = 1;
    second.dialogueVoiceover = "人物：这个镜头有一段必须先修复的过长台词。";
    const result = readDramaVideoPreflight(board, ["shot-5", "shot-6"], settings);
    assert.deepEqual(result.issues.map(issue => issue.shotId), ["shot-5", "shot-6"]);
    assert.match(result.issues[0].message, /台词预计/);
    assert.deepEqual(result.prerequisiteShotIds, []);
});

test("重生较早前镜使中间未选的旧视频失效，建议补入准确的中间镜头", () => {
    const { board, first, second } = fixture();
    save(board, first);
    save(board, second);
    const result = readDramaVideoPreflight(board, ["shot-4", "shot-6"], settings);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].shotId, "shot-6");
    assert.deepEqual(result.prerequisiteShotIds, ["shot-5"]);
});

test("已删除标识产生明确错误，重复标识不会扩大生成范围", () => {
    const { board } = fixture();
    const result = readDramaVideoPreflight(board, ["deleted", "deleted", "shot-7", "shot-7"], settings);
    assert.deepEqual(result.issues, [{ shotId: "deleted", message: "所选镜头已发生变化，请重新选择", prerequisiteShotIds: [] }]);
    assert.deepEqual(result.prerequisiteShotIds, []);
});

test("镜头6沿缺失的4和5找到就绪的3，沿用模型和1:1画幅", () => {
    const { board, first } = fixture();
    const anchor = shot(3);
    board.storyboard.shots.splice(1, 0, anchor);
    first.continuity!.transition = "continue";
    save(board, anchor);
    anchor.video!.model = "muse-video::sora-2";
    anchor.video!.size = "1:1";
    const before = JSON.stringify(board);
    assert.deepEqual(readDramaVideoContinuationSettings(board, ["shot-6"]), { model: "muse-video::sora-2", size: "1:1" });
    assert.equal(JSON.stringify(board), before);
});

test("同批前镜的旧视频不作为设置依据，继续寻找批次前的有效视频", () => {
    const { board, first, second } = fixture();
    save(board, first);
    save(board, second);
    second.video!.model = "old-model";
    second.video!.size = "9:16";
    assert.deepEqual(readDramaVideoContinuationSettings(board, ["shot-6", "shot-5"]), settings);
    assert.equal(readDramaVideoContinuationSettings(board, ["shot-4", "shot-5", "shot-6"]), undefined);
});

test("无前镜依据或明确转场不推断设置，也不读取所选镜头自己的旧视频", () => {
    const { board, first, second } = fixture();
    assert.equal(readDramaVideoContinuationSettings(board, ["shot-6"]), undefined);
    assert.equal(readDramaVideoContinuationSettings(board, []), undefined);
    save(board, first);
    assert.equal(readDramaVideoContinuationSettings(board, ["shot-4"]), undefined);
    second.continuity!.transition = "establish";
    save(board, second);
    assert.equal(readDramaVideoContinuationSettings(board, ["shot-5"]), undefined);
});

test("失效视频不提供默认设置，结构边界阻止跨场景追溯", () => {
    const { board, first, second, third } = fixture();
    save(board, first);
    save(board, second);
    second.video!.model = "stale-model";
    second.video!.size = "9:16";
    second.image = { source: "/changed5.png" };
    assert.deepEqual(readDramaVideoContinuationSettings(board, ["shot-6"]), settings);
    third.continuity!.sceneId = "另一场景";
    assert.equal(readDramaVideoContinuationSettings(board, ["shot-6"]), undefined);
});

test("多个连续场景的有效前镜设置冲突时不自动推断", () => {
    for (const key of ["model", "size"] as const) {
        const { board, first } = fixture();
        save(board, first);
        const otherAnchor = shot(8), other = shot(9, "continue");
        otherAnchor.continuity!.sceneId = other.continuity!.sceneId = "街道";
        board.storyboard.shots.push(otherAnchor, other);
        save(board, otherAnchor);
        assert.deepEqual(readDramaVideoContinuationSettings(board, ["shot-5", "shot-9"]), settings);
        otherAnchor.video![key] = key === "model" ? "model-B" : "1:1";
        assert.equal(readDramaVideoContinuationSettings(board, ["shot-5", "shot-9"]), undefined);
    }
});

test("前镜仅保存部分设置时只推断已知字段", () => {
    const { board, first } = fixture();
    save(board, first);
    delete first.video!.model;
    assert.deepEqual(readDramaVideoContinuationSettings(board, ["shot-5"]), { size: "16:9" });
    delete first.video!.size;
    assert.equal(readDramaVideoContinuationSettings(board, ["shot-5"]), undefined);
});
