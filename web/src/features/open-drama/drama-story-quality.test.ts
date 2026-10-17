import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasStoryboardShot } from "@/features/canvas/types";
import { estimateDramaSpeechSeconds, readDramaStoryQuality } from "./drama-story-quality";

const shot = (id: string, overrides: Partial<CanvasStoryboardShot> = {}): CanvasStoryboardShot => ({
    id, shotNumber: 1, durationSeconds: 8, visualDescription: "人物抬起手中的信件。", shotSize: "中景", lightingAtmosphere: "自然光",
    dialogueVoiceover: "", cameraMovement: "缓慢推近", soundEffect: "纸张轻响", finalPrompt: "人物抬起手中的信件。", assetIds: [],
    continuity: { sceneId: "书房", time: "清晨", transition: "establish", openingState: "人物坐在桌前，信件尚未打开。", closingState: "人物打开信件。", storyBeat: "得知真相" },
    ...overrides,
});

test("不同题材的小说都检查旧段落中的重复对白和时长，不依赖名字或镜号", () => {
    for (const [name, line] of [["乡村往事", "孩子啊，你赶紧把这封信送到村口，不要告诉别人。"], ["星际航行", "指挥官，我们的引擎已经失去动力，必须马上撤离。"]]) {
        const first = shot(`${name}-a`, { continuity: undefined, visualDescription: `母亲说：“${line}”`, dialogueVoiceover: "", cameraMovement: "" });
        const second = shot(`${name}-b`, { shotNumber: 2, durationSeconds: 2, continuity: undefined, visualDescription: `他又说：“${line}”`, dialogueVoiceover: "", cameraMovement: "" });
        const snapshot = JSON.stringify([first, second]);
        const issues = readDramaStoryQuality([second, first]);
        assert.ok(issues.some(issue => issue.code === "repeated-dialogue" && issue.shotId === second.id && issue.relatedShotId === first.id));
        assert.ok(issues.some(issue => issue.code === "speech-too-long" && issue.shotId === second.id && issue.severity === "error"));
        assert.equal(JSON.stringify([first, second]), snapshot);
    }
});

test("台词去掉说话人和表演提示，短语重复不误报", () => {
    assert.equal(estimateDramaSpeechSeconds("林夏：（小声地）我们今天回家"), 1.5);
    assert.equal(estimateDramaSpeechSeconds("Pilot: We will go home."), 2);
    assert.equal(estimateDramaSpeechSeconds("Alpha你好Beta12"), 2);
    assert.equal(estimateDramaSpeechSeconds("旁白：【轻声】无"), 0.25);
    const issues = readDramaStoryQuality([
        shot("1", { dialogueVoiceover: "好。" }),
        shot("2", { shotNumber: 2, dialogueVoiceover: "好！" }),
    ]);
    assert.ok(!issues.some(issue => issue.code === "repeated-dialogue" || issue.code === "speech-too-long"));
});

test("英语对白也按说话时长检查，同一句标点变化可被识别", () => {
    const issues = readDramaStoryQuality([
        shot("a", { dialogueVoiceover: "Pilot: We must leave the station before the engine fails." }),
        shot("b", { shotNumber: 2, durationSeconds: 1, dialogueVoiceover: "Pilot: We must leave the station before the engine fails!" }),
    ]);
    assert.ok(issues.some(issue => issue.code === "repeated-dialogue"));
    assert.ok(issues.some(issue => issue.code === "speech-too-long" && issue.shotId === "b"));
});

test("检测不合法的连续动作与缺失状态，明确转场则通过", () => {
    const first = shot("1");
    const second = shot("2", { shotNumber: 2, continuity: { sceneId: "工厂", time: "傍晚", transition: "continue", openingState: "", closingState: "工人离开", storyBeat: "下班" } });
    const issues = readDramaStoryQuality([first, second]);
    assert.ok(issues.some(issue => issue.code === "invalid-continuation"));
    assert.ok(issues.some(issue => issue.code === "missing-state"));
    second.continuity = { ...second.continuity!, transition: "time-jump", openingState: "傍晚，工厂外景建立地点" };
    assert.deepEqual(readDramaStoryQuality([first, second]), []);
});

test("本章首镜建立场景，不能在没有前镜素材时声明连续动作", () => {
    const first = shot("1");
    first.continuity!.transition = "continue";
    assert.ok(readDramaStoryQuality([first]).some(issue => issue.code === "invalid-continuation"));
});

test("16字以上的完整台词包含重复也检查，较短对白保留人工判断", () => {
    const first = shot("a", { dialogueVoiceover: "我们必须在太阳落山以前把所有孩子送回安全的地方" });
    const repeated = shot("b", { shotNumber: 2, dialogueVoiceover: "请听我说，我们必须在太阳落山以前把所有孩子送回安全的地方，然后再回来" });
    assert.ok(readDramaStoryQuality([first, repeated]).some(issue => issue.code === "repeated-dialogue"));
    const short = "今天下午就回家";
    assert.ok(!readDramaStoryQuality([shot("a", { dialogueVoiceover: short }), shot("b", { shotNumber: 2, dialogueVoiceover: short })]).some(issue => issue.code === "repeated-dialogue"));
});

test("未规划的小说心理描写与时间跳转提示优化，正常镜头不误报", () => {
    const imported = shot("old", { continuity: undefined, cameraMovement: "", visualDescription: "他心里回想起从小的经历。第二天，他走到了另一座城市。", videoPrompt: "他心里回想起从小的经历。第二天，他走到了另一座城市。" });
    const issues = readDramaStoryQuality([imported]);
    assert.ok(issues.some(issue => issue.code === "missing-continuity"));
    assert.ok(issues.some(issue => issue.code === "unplanned-prose"));
    assert.deepEqual(readDramaStoryQuality([shot("planned")]), []);
});
