import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode, createTextNode } from "@/features/canvas/constants";
import { createCanvasDocument } from "@/features/canvas/domain/canvas-document";
import type { CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { buildDramaShotVideoPrompt, buildDramaStoryContext, orderDramaItems, readDramaContinuityReport } from "./drama-continuity";
import { captureDramaVideoShot } from "./drama-video-continuity";
import { dramaShotVideoSignature } from "./drama-video-continuity";

const shot = (id: string, shotNumber: number): CanvasStoryboardShot => ({
    id, shotNumber, durationSeconds: 5, visualDescription: `事件-${id}`, shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: `原始提示词-${id}`, assetIds: ["actor"],
    image: { source: `/shot-${id}.png` }, video: { source: `/shot-${id}.mp4`, storageKey: `video:${id}` },
    continuity: { sceneId: id, time: "白天", transition: "cut", openingState: "角色站在门前", closingState: "角色走进门内", storyBeat: `事件-${id}` },
});

test("剧情修改与台词超时阻断成片但保留检查预览", () => {
    const { document, boards } = fixture();
    const first = boards[0].storyboard.shots[0];
    first.video!.sourceSignature = dramaShotVideoSignature(first, boards[0]);
    first.visualDescription = "改写后的动作";
    first.dialogueVoiceover = "主角：" + "这段对白很长说不完".repeat(5);
    const report = readDramaContinuityReport(document);
    assert.equal(report.canPreview, true);
    assert.equal(report.canCompose, false);
    assert.ok(report.issues.some(issue => issue.code === "stale-video"));
    assert.ok(report.issues.some(issue => issue.code === "speech-too-long"));
});
function fixture() {
    const document = createCanvasDocument({ id: "story", title: "归途", now: "2026-09-30" });
    const assets = [{ id: "actor", kind: "character" as const, name: "林夏", description: "短发，蓝色外套，背着棕色挎包" }];
    const boards: CanvasStoryboardNode[] = [];
    const chapters = [0, 1, 2].map(index => {
        const script = createTextNode({ id: `script-${index}`, position: { x: 0, y: 0 }, text: `完整剧本-${index}` });
        const board = createStoryboardNode({ id: `board-${index}`, title: `第 ${index + 1} 章`, position: { x: 0, y: 0 } });
        board.storyboard.assets = assets;
        board.storyboard.shots = [shot(`${index}-2`, 2), shot(`${index}-1`, 1)];
        board.content.instruction = "旧剧本";
        document.scene.nodes.push(script, board);
        boards.push(board);
        return { id: `chapter-${index}`, title: board.title, scriptNodeId: script.id, storyboardNodeId: board.id };
    });
    document.preferences.drama = { version: 1, chapters, assets, activeChapterId: chapters[0].id, view: "shots" };
    return { document, boards };
}

test("全剧检查保留章序，并按镜号生成完整片单，不受节点数组和分页顺序影响", () => {
    const { document } = fixture();
    const snapshot = JSON.stringify(document);
    const report = readDramaContinuityReport(document, [...document.scene.nodes].reverse());
    assert.deepEqual(report.orderedShots.map(item => item.shot.id), ["0-1", "0-2", "1-1", "1-2", "2-1", "2-2"]);
    assert.equal(report.shotCount, 6);
    assert.equal(report.readyCount, 6);
    assert.equal(report.storedCount, 6);
    assert.equal(report.durationSeconds, 30);
    assert.equal(report.canPreview, true);
    assert.equal(report.canCompose, true);
    assert.deepEqual(report.issues, []);
    assert.equal(JSON.stringify(document), snapshot);
});

test("缺失中间章或镜头视频必须阻断全剧成片，不能跳过后假称完整", () => {
    const { document, boards } = fixture();
    boards[0].storyboard.shots[0].video = undefined;
    document.scene.nodes = document.scene.nodes.filter(node => node.id !== "board-1");
    const report = readDramaContinuityReport(document);
    assert.equal(report.shotCount, 4);
    assert.equal(report.readyCount, 3);
    assert.equal(report.canPreview, false);
    assert.equal(report.canCompose, false);
    assert.ok(report.issues.some(issue => issue.code === "missing-board" && issue.chapterId === "chapter-1"));
    assert.ok(report.issues.some(issue => issue.code === "missing-video" && issue.shotId === "0-2"));
});

test("视频可预览但尚未持久化时明确阻止合成；空章节同样阻断", () => {
    const { document, boards } = fixture();
    delete boards[1].storyboard.shots[0].video!.storageKey;
    let report = readDramaContinuityReport(document);
    assert.equal(report.canPreview, true);
    assert.equal(report.canCompose, false);
    assert.equal(report.storedCount, 5);
    assert.ok(report.issues.some(issue => issue.code === "missing-storage" && issue.shotId === "1-2"));
    boards[1].storyboard.shots = [];
    report = readDramaContinuityReport(document);
    assert.equal(report.canPreview, false);
    assert.ok(report.issues.some(issue => issue.code === "empty-chapter"));
});

test("完整文本上下文使用最新全部剧本，保留首尾与跨章关系", () => {
    const { document } = fixture();
    const script = document.scene.nodes.find(node => node.id === "script-1")!;
    assert.equal(script.kind, "text");
    if (script.kind !== "text") return;
    script.content.text = `开端${"情节".repeat(15000)}结局`;
    const context = buildDramaStoryContext(document, document.scene.nodes, "board-1")!;
    assert.equal(context.chapterIndex, 2);
    assert.equal(context.chapterCount, 3);
    assert.ok(context.fullStory.includes(script.content.text));
    assert.ok(context.previousChapter?.includes("完整剧本-0"));
    assert.ok(context.nextChapter?.includes("完整剧本-2"));
    assert.ok(!context.fullStory.includes("旧剧本"));
    script.content.text = "";
    assert.ok(!buildDramaStoryContext(document, document.scene.nodes, "board-1")!.fullStory.includes("旧剧本"));
    assert.ok(readDramaContinuityReport(document).issues.some(issue => issue.code === "missing-script"));
});

test("视频提交包含跨章前后镜和统一角色，原始提示词与编辑数据保持不变", () => {
    const { document } = fixture();
    const snapshot = JSON.stringify(document);
    const prompt = buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", "1-1");
    assert.ok(prompt.startsWith("原始提示词-1-1\n"));
    assert.ok(prompt.includes("事件-0-2"));
    assert.ok(prompt.includes("事件-1-2"));
    assert.ok(prompt.includes("第 2/3 章"));
    assert.ok(prompt.includes("林夏"));
    assert.ok(prompt.includes("蓝色外套"));
    assert.ok(!prompt.includes("完整剧本-"));
    assert.equal(JSON.stringify(document), snapshot);
    assert.ok(buildDramaShotVideoPrompt(document, document.scene.nodes, "board-0", "0-1").includes("这是全剧首镜"));
    assert.ok(buildDramaShotVideoPrompt(document, document.scene.nodes, "board-2", "2-2").includes("这是全剧末镜"));
});

test("连续性附加上下文长度有界，原始长提示词和显式空值保留", () => {
    const { document, boards } = fixture();
    const source = boards[1].storyboard.shots[1];
    source.videoPrompt = "用户提示词".repeat(2000);
    source.visualDescription = "描述".repeat(10000);
    boards[1].content.visualStyle = "风格".repeat(10000);
    boards[1].storyboard.assets = Array.from({ length: 30 }, (_, index) => ({ id: String(index), kind: "character", name: `角色${index}`, description: "人物描述".repeat(1000) }));
    source.assetIds = boards[1].storyboard.assets.map(asset => asset.id);
    const prompt = buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", source.id);
    assert.ok(prompt.startsWith(source.videoPrompt));
    assert.ok(prompt.length - source.videoPrompt.length < 3500);
    source.videoPrompt = "";
    assert.equal(buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", source.id), "");
});

test("展开节点的提示词覆盖生效，重试只替换旧连续性块且保留后续用户编辑", () => {
    const { document, boards } = fixture();
    const first = buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", "1-1", "展开节点修改后的内容");
    assert.ok(first.startsWith("展开节点修改后的内容\n"));
    assert.ok(!first.includes("原始提示词-1-1"));
    assert.equal(buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", "1-1", first), first);
    boards[0].storyboard.shots[0].visualDescription = "上一镜更新了人物位置";
    const retry = buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", "1-1", `${first}\n用户新增动作：回头`);
    assert.ok(retry.includes("上一镜更新了人物位置"));
    assert.ok(retry.startsWith("展开节点修改后的内容\n用户新增动作：回头\n"));
    assert.equal(retry.match(/【短剧连续性上下文：开始】/g)?.length, 1);
    assert.equal(buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", "1-1", ""), "");
});

test("完整改写提示词只补充事实标识，不重新附加原画面、人物描述或相邻镜头事件", () => {
    const { document, boards } = fixture();
    const board = boards[1];
    const source = board.storyboard.shots.find(item => item.id === "1-1")!;
    source.videoPrompt = "林夏从门前平静走入屋内，保持人物造型和空间关系，镜头缓慢推进。";
    source.videoPromptContextMode = "self-contained";
    source.visualDescription = "旧画面描述必须不再附加";
    source.cameraMovement = "旧运镜必须不再附加";
    source.dialogueVoiceover = "旧对白必须不再附加";
    source.continuity = { ...source.continuity!, sceneId: "room-1", time: "白天", transition: "continue",
        openingState: "旧起始状态必须不再附加", closingState: "旧结束状态必须不再附加", storyBeat: "旧剧情节拍必须不再附加" };
    board.content.visualStyle = "旧视觉风格必须不再附加";
    boards[0].storyboard.shots.find(item => item.id === "0-2")!.dialogueVoiceover = "旧前镜对白必须不再附加";
    board.storyboard.shots.find(item => item.id === "1-2")!.dialogueVoiceover = "旧后镜对白必须不再附加";
    const before = JSON.stringify(document);
    const prompt = buildDramaShotVideoPrompt(document, document.scene.nodes, board.id, source.id);
    assert.ok(prompt.startsWith(source.videoPrompt));
    for (const original of ["旧画面描述", "旧运镜", "旧对白", "旧起始状态", "旧结束状态", "旧剧情节拍", "旧视觉风格", "旧前镜对白", "旧后镜对白", "事件-0-2", "事件-1-2", "蓝色外套", "棕色挎包"]) {
        assert.ok(!prompt.includes(original), original);
    }
    for (const fact of ["林夏", "ID：actor", "room-1", "白天", "continue", "时长 5 秒", "上一镜真实尾帧"]) assert.ok(prompt.includes(fact), fact);
    assert.equal(JSON.stringify(document), before, "文本构建不应改变结构化衔接、身份、时长或参考图");
    assert.equal(buildDramaShotVideoPrompt(document, document.scene.nodes, board.id, source.id, prompt), prompt);
    const override = buildDramaShotVideoPrompt(document, document.scene.nodes, board.id, source.id, "后续手动修订的完整提示词");
    assert.ok(override.startsWith("后续手动修订的完整提示词\n"));
    assert.ok(!override.includes(source.videoPrompt));
    assert.ok(!override.includes(source.visualDescription));
    assert.equal(buildDramaShotVideoPrompt(document, document.scene.nodes, board.id, source.id, ""), "");
});

test("完整改写的明确转场保留素材ID并使用改写内起始状态", () => {
    const { document, boards } = fixture();
    const source = boards[1].storyboard.shots[0];
    source.videoPrompt = "人物在另一房间开始新的动作。";
    source.videoPromptContextMode = "self-contained";
    source.assetIds.push("unknown-reference");
    const prompt = buildDramaShotVideoPrompt(document, document.scene.nodes, "board-1", source.id);
    assert.ok(prompt.includes("转场类型：cut"));
    assert.ok(prompt.includes("按提示词中的起始状态"));
    assert.ok(prompt.includes("ID：unknown-reference"));
    assert.ok(!prompt.includes("上一镜真实尾帧"));
    assert.ok(!prompt.includes(source.continuity!.openingState));
});

test("重复节点和重复镜头标识阻断，稳定排序不修改原数组", () => {
    const input = [{ id: "b", n: 2 }, { id: "c", n: 0 }, { id: "a", n: 1 }, { id: "d", n: 2 }];
    assert.deepEqual(orderDramaItems(input, item => item.n).map(item => item.id), ["a", "b", "d", "c"]);
    assert.deepEqual(input.map(item => item.id), ["b", "c", "a", "d"]);
    const { document, boards } = fixture();
    boards[0].storyboard.shots[1].id = boards[0].storyboard.shots[0].id;
    assert.equal(readDramaContinuityReport(document).canCompose, false);
    assert.ok(readDramaContinuityReport(document).issues.some(issue => issue.code === "duplicate-shot"));
    document.preferences.drama!.chapters[2].storyboardNodeId = boards[0].id;
    assert.ok(readDramaContinuityReport(document).issues.some(issue => issue.code === "duplicate-board"));
});

test("前镜换片后即使后镜剧情未改，全剧检查也阻止沿用旧尾帧生成的成片", () => {
    const { document, boards } = fixture();
    const board = boards[0];
    const ordered = [...board.storyboard.shots].sort((a, b) => a.shotNumber - b.shotNumber);
    const [first, next] = ordered;
    first.continuity = { sceneId: "屋内", time: "清晨", transition: "establish", openingState: "站在门旁", closingState: "走到桌前", storyBeat: "发现信件" };
    next.continuity = { ...first.continuity, transition: "continue", openingState: "站在桌前", closingState: "拿起信件", storyBeat: "读取信件" };
    const snapshot = captureDramaVideoShot(board, next.id);
    next.video = { ...next.video!, sourceSignature: snapshot.signature, previousVideoStorageKey: snapshot.previousVideoStorageKey };
    assert.equal(readDramaContinuityReport(document).canCompose, true);
    first.video = { ...first.video!, source: "/new-first.mp4", storageKey: "new-first" };
    const report = readDramaContinuityReport(document);
    assert.equal(report.canCompose, false);
    assert.equal(report.canPreview, true, "仍可顺序预览核对问题");
    assert.ok(report.issues.some(issue => issue.code === "stale-video" && issue.shotId === next.id && /前镜视频已替换/.test(issue.message)));
});
