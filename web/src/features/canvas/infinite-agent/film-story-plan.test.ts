import assert from "node:assert/strict";
import test from "node:test";
import { compileFilmStoryPlan, normalizeFilmStoryPlan, sameContinuityState, planVoiceover, silenceSpokenLines } from "./film-story-plan";
import { filmStoryFixture } from "./film-story-plan-fixture";

test("saved plans without an aspect ratio remain readable for workflow resumption", () => {
    const { plan, clips } = filmStoryFixture();
    const { aspectRatio: _ratio, ...legacyPlan } = plan;
    const restored = normalizeFilmStoryPlan(legacyPlan);
    assert.deepEqual(restored, legacyPlan);
    assert.deepEqual(compileFilmStoryPlan(restored, clips).shots.map(shot => shot.seconds), [3, 7, 4, 6]);
});

test("TapCanvas compilation preserves AI-authored timing, state, shared identity and exact dialogue", () => {
    const { plan, clips } = filmStoryFixture();
    const result = compileFilmStoryPlan(plan, clips);
    assert.deepEqual(result.shots.map(shot => shot.seconds), [3, 7, 4, 6]);
    assert.equal(result.targetDurationSeconds, 20);
    assert.equal(result.productionVersion, "tapcanvas-adapted/v1");
    assert.equal(result.assets?.length, 1);
    for (const shot of result.shots) assert.match(shot.videoPrompt, /黑短发、黄色雨衣、棕色邮包/);
    assert.equal(result.shots[0].videoPrompt.split("我去点亮它。").length - 1, 1);
    assert.match(result.shots[1].videoPrompt, /进入状态：邮递员找到备用电池/);
    assert.equal(result.script, plan.script);
});

test("every media prompt ends with a style and identity lock so shot details cannot override them", () => {
    const { plan, clips } = filmStoryFixture();
    const result = compileFilmStoryPlan(plan, clips);
    for (const shot of result.shots) {
        const lock = shot.videoPrompt.slice(shot.videoPrompt.lastIndexOf("一致性锁定"));
        assert.ok(shot.videoPrompt.includes("一致性锁定") && !/\n镜头\d/.test(lock), "lock must be the final block");
        assert.match(lock, /画风：写实电影，深蓝雨夜与暖色灯光/);
        assert.match(lock, /邮递员（黑短发、黄色雨衣、棕色邮包）/);
        assert.match(lock, /只出现一次/);
        assert.match(lock, /切镜后再次出现时按首帧外观还原/);
        assert.match(shot.imagePrompt, /一致性锁定[\s\S]*与参考图一致/);
    }
});

test("missing/repeated dialogue, omitted story events and invented beat IDs cannot reach media submission", () => {
    for (const mutation of [
        (clips: ReturnType<typeof filmStoryFixture>["clips"]) => { clips[0].timeline.shots[0].speechEventIds = []; },
        (clips: ReturnType<typeof filmStoryFixture>["clips"]) => { clips[0].timeline.shots = [...clips[0].timeline.shots, ...clips[0].timeline.shots]; },
        (clips: ReturnType<typeof filmStoryFixture>["clips"]) => { clips[0].timeline.shots[0].storyEventIds = []; },
        (clips: ReturnType<typeof filmStoryFixture>["clips"]) => { clips[0].beatId = "invented"; },
    ]) {
        const { plan, clips } = filmStoryFixture();
        mutation(clips);
        assert.throws(() => compileFilmStoryPlan(plan, clips));
    }
});

test("broken state handoffs, duplicate assets, time overflow and inconsistent totals fail before freezing", () => {
    for (const mutation of [
        (plan: ReturnType<typeof filmStoryFixture>["plan"]) => { plan.beats[1].entryState = "另一个人突然出现在山顶"; plan.beats[1].storyEvents[0].entryState = plan.beats[1].entryState; },
        (plan: ReturnType<typeof filmStoryFixture>["plan"]) => { plan.assets.push(plan.assets[0]); },
        (plan: ReturnType<typeof filmStoryFixture>["plan"]) => { plan.beats[0].storyEvents[0].endSeconds = 50; },
        (plan: ReturnType<typeof filmStoryFixture>["plan"]) => { plan.targetDurationSeconds = 30; },
        (plan: ReturnType<typeof filmStoryFixture>["plan"]) => { plan.beats[0].assetIds = ["unknown"]; },
    ]) {
        const { plan } = filmStoryFixture(); mutation(plan);
        assert.throws(() => normalizeFilmStoryPlan(plan), /成片编排校验/);
    }
});

test("voiceover timing follows the bound story event, offsets by earlier beats and never overlaps within a beat", () => {
    const { plan, clips } = filmStoryFixture([3, 7]);
    plan.narratorVoice = "orion";
    plan.assets[0].voice = "rex";
    plan.beats[1].storyEvents = [
        { sourceBeatId: "e-a", event: "跨上断桥", entryState: plan.beats[1].entryState, exitState: "站在桥中", startSeconds: 0, endSeconds: 2 },
        { sourceBeatId: "e-b", event: "看见灯塔", entryState: "站在桥中", exitState: plan.beats[1].exitState, startSeconds: 2, endSeconds: 7 },
    ];
    plan.beats[1].dialogueScript = [
        { lineId: "n1", speakerName: "旁白", text: "那一夜，港口所有的灯都熄了。", delivery: "voice_over" },
        { lineId: "n2", speakerName: "邮递员", text: "就差一点。", delivery: "off_screen" },
    ];
    clips[1].timeline.shots = [
        { action: "跨桥", camera: "", sound: "", storyEventIds: ["e-a"], speechEventIds: ["n1"] },
        { action: "望向灯塔", camera: "", sound: "", storyEventIds: ["e-b"], speechEventIds: ["n2"] },
    ];
    const lines = planVoiceover(normalizeFilmStoryPlan(plan), clips);
    assert.deepEqual(lines.map(line => [line.lineId, line.voice, line.startMs]), [
        ["beat-0:line-1", "rex", 0],
        ["beat-1:n1", "orion", 3000],
        // "那一夜…" 14 字 ≈ 3.1 秒，第二句不能早于它结束，即使绑定事件在第 2 秒开始。
        ["beat-1:n2", "rex", 6311],
    ]);
    assert.ok(lines[1].maxDurationMs > 3000 && lines[2].maxDurationMs >= 500);
    assert.equal(compileFilmStoryPlan(plan, clips).voiceover?.length, 3);
});

test("dubbed prompts replace every spoken line with a silent cue but keep the original prompt for undubbed films", () => {
    const events = [
        { speaker: "小夏", text: "那……一起放手。", delivery: "", voice: "onscreen" as const },
        { speaker: "小夏", text: "这个夏天过完，我就要搬走了。", delivery: "", voice: "narration" as const },
        { speaker: "阿春", text: "慢点跑。", delivery: "", voice: "offscreen" as const },
    ];
    const prompt = "镜头1：小夏说：“那……一起放手。”；小夏旁白：“这个夏天过完，我就要搬走了。”\n镜头2：阿春画外音：“慢点跑。”";
    const dubbed = silenceSpokenLines(prompt, events);
    for (const event of events) assert.equal(dubbed.includes(event.text), false, event.text);
    assert.match(dubbed, /小夏开口说了一句话（不发声/);
    assert.match(dubbed, /旁白，后期配音/);
    assert.match(dubbed, /阿春的画外音，后期配音/);
    const { plan, clips } = filmStoryFixture();
    const shot = compileFilmStoryPlan(plan, clips).shots[0];
    assert.ok(shot.videoPrompt.includes("我去点亮它。"));
    assert.ok(shot.dubbedVideoPrompt && !shot.dubbedVideoPrompt.includes("我去点亮它。"));
});

test("continuity copies with cosmetic drift are snapped, real jumps still fail", () => {
    const { plan } = filmStoryFixture();
    const exit = plan.beats[0].exitState;
    plan.beats[0].exitState = exit + "。";
    plan.beats[1].entryState = " " + exit;
    plan.beats[1].storyEvents[0].entryState = exit + "！";
    const frozen = normalizeFilmStoryPlan(plan);
    assert.equal(frozen.beats[0].exitState, frozen.beats[0].storyEvents.at(-1)!.exitState);
    assert.equal(frozen.beats[1].entryState, frozen.beats[0].exitState);
    assert.equal(sameContinuityState("另一个人突然出现在山顶", exit), false);
});
