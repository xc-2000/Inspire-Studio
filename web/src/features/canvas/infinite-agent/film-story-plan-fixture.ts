import type { FilmStoryPlan } from "./film-story-plan";

/** Test-only authored packets; never used as a production story template. */
export function filmStoryFixture(durations = [3, 7, 4, 6]) {
    const actions = ["邮递员发现灯塔熄灭", "邮递员冒雨跨过断桥", "邮递员将电池接入灯塔", "灯光重新亮起，渔船驶回港口"];
    const states = ["灯塔熄灭，邮递员在港口", "邮递员找到备用电池", "邮递员携电池抵达灯塔", "电池已接通，灯光亮起", "渔船安全返港"];
    const plan: FilmStoryPlan = {
        aspectRatio: "16:9", title: "雨夜归航", script: actions.slice(0, durations.length).join("。"), visualStyle: "写实电影，深蓝雨夜与暖色灯光",
        targetDurationSeconds: durations.reduce((a, b) => a + b, 0), durationRationale: "按发现、穿越、接通和结果分配动作时间",
        assets: [{ id: "postman", name: "邮递员", kind: "character", identity: "黑短发、黄色雨衣、棕色邮包", imagePrompt: "邮递员全身角色设定，单人，清晰五官" }],
        beats: durations.map((seconds, index) => ({ id: `beat-${index}`, title: `段落${index + 1}`, description: actions[index], seconds, entryState: states[index], exitState: states[index + 1], assetIds: ["postman"],
            storyEvents: [{ sourceBeatId: `event-${index}`, event: actions[index], entryState: states[index], exitState: states[index + 1], startSeconds: 0, endSeconds: seconds }],
            dialogueScript: index === 0 ? [{ lineId: "line-1", speakerName: "邮递员", text: "我去点亮它。", delivery: "on_screen" as const }] : [],
        })),
    };
    const clips = plan.beats.map(beat => ({ beatId: beat.id, imagePrompt: `${beat.entryState}，邮递员动作开始前的构图`, timeline: { scene: "雨夜港口", shots: [{ action: beat.description, camera: "跟随人物缓慢推进", sound: "雨声", storyEventIds: beat.storyEvents.map(event => event.sourceBeatId), speechEventIds: beat.dialogueScript.map(line => line.lineId) }] } }));
    return { plan, clips };
}
