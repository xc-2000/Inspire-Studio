import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasStoryboardShot } from "../types";
import { readStoryboardVideoSelection } from "./storyboard-video-selection";

function fixture(): CanvasStoryboardShot[] {
    return [1, 2, 3].map((number) => ({
        id: `shot-${number}`, shotNumber: number, durationSeconds: 5, visualDescription: "剧情画面", shotSize: "中景",
        lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "视频提示词", assetIds: [],
        video: number === 1 ? { source: "/existing.mp4" } : undefined,
    }));
}

test("整章入口显示全部镜头，仍默认只选择尚无视频的有效镜头", () => {
    const shots = fixture();
    const selection = readStoryboardVideoSelection(shots);
    assert.deepEqual(selection.shots, shots);
    assert.deepEqual(selection.selectedShotIds, ["shot-2", "shot-3"]);
});

test("明确勾选的已有视频可重新生成，顺序跟随分镜并过滤重复和已删除标识", () => {
    const shots = fixture();
    const requestedIds = ["shot-3", "deleted-shot", "shot-1", "shot-3"];
    const selection = readStoryboardVideoSelection(shots, requestedIds);
    assert.deepEqual(selection.shots.map((shot) => shot.id), ["shot-1", "shot-3"]);
    assert.deepEqual(selection.selectedShotIds, ["shot-1", "shot-3"]);
    assert.deepEqual(requestedIds, ["shot-3", "deleted-shot", "shot-1", "shot-3"]);
    assert.equal(shots.length, 3);
});

test("空选择或全部失效的选择不能回退为整章生成", () => {
    for (const requestedIds of [[], ["deleted-shot"]]) {
        assert.deepEqual(readStoryboardVideoSelection(fixture(), requestedIds), { shots: [], selectedShotIds: [] });
    }
});

test("同一分镜重新打开时按新的选择初始化，重新打开整章入口恢复默认选择", () => {
    const shots = fixture();
    const first = readStoryboardVideoSelection(shots, ["shot-1", "shot-3"]);
    const reopened = readStoryboardVideoSelection(shots, ["shot-2"]);
    assert.deepEqual(reopened.shots.map((shot) => shot.id), ["shot-2"]);
    assert.deepEqual(reopened.selectedShotIds, ["shot-2"]);
    assert.deepEqual(first.selectedShotIds, ["shot-1", "shot-3"]);
    assert.deepEqual(readStoryboardVideoSelection(shots).selectedShotIds, ["shot-2", "shot-3"]);
    assert.deepEqual(readStoryboardVideoSelection(shots.slice(0, 1), ["shot-2"]).selectedShotIds, []);
});

test("选中但缺少提示词或时长无效的镜头保留在预检列表，不自动提交", () => {
    const shots = fixture();
    shots[0].videoPrompt = " ";
    shots[1].durationSeconds = 0;
    const selection = readStoryboardVideoSelection(shots, ["shot-1", "shot-2", "shot-3"]);
    assert.equal(selection.shots.length, 3);
    assert.deepEqual(selection.selectedShotIds, ["shot-3"]);
});
