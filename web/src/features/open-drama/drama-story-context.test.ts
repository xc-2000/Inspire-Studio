import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardNode, createTextNode } from "@/features/canvas/constants";
import { createCanvasDocument } from "@/features/canvas/domain/canvas-document";
import type { CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { buildDramaStoryContext } from "./drama-continuity";
import { buildDramaPlanningContext, DRAMA_FULL_STORY_CONTEXT_LIMIT, readDramaChapterSource, usesDramaChapterContext } from "./drama-story-context";

function fixture(texts: string[]) {
    const document = createCanvasDocument({ id: "context-qa", title: "完整叙事", now: "2026-10-06" });
    const boards: CanvasStoryboardNode[] = [];
    const chapters = texts.map((text, index) => {
        const script = createTextNode({ id: `script-${index}`, position: { x: 0, y: 0 }, text });
        const board = createStoryboardNode({ id: `board-${index}`, title: `第${index + 1}章`, position: { x: 0, y: 0 } });
        board.content.instruction = "旧剧本不得恢复";
        boards.push(board);
        document.scene.nodes.push(script, board);
        return { id: `chapter-${index}`, title: board.title, scriptNodeId: script.id, storyboardNodeId: board.id };
    });
    document.preferences.drama = { version: 1, chapters, assets: [], activeChapterId: chapters[0].id, view: "shots" };
    return { document, boards };
}

const beatShot = (storyBeat: string): CanvasStoryboardShot => ({
    id: "shot", shotNumber: 1, durationSeconds: 10, visualDescription: "开门", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "开门", assetIds: [],
    continuity: { sceneId: "room", time: "白天", transition: "establish", openingState: "站在门前", closingState: "门已打开", storyBeat },
});

test("58 章长篇发送全章目录与已知节拍，远章正文不再重复装入请求", () => {
    const texts = Array.from({ length: 58 }, (_, index) => `章节独有正文-${index}：${"完整剧情".repeat(300)}原章结果-${index}`);
    const { document, boards } = fixture(texts);
    boards[57].storyboard.shots = [beatShot("主角最终平安归乡")];
    const before = JSON.stringify(document);
    const full = buildDramaStoryContext(document, document.scene.nodes, "board-0")!;
    assert.ok(full.fullStory.length > DRAMA_FULL_STORY_CONTEXT_LIMIT);
    assert.equal(usesDramaChapterContext(full), true);
    const context = buildDramaPlanningContext(document, document.scene.nodes, "board-0")!;
    assert.equal(context.chapterCount, 58);
    assert.ok(context.fullStory.includes("58. 第58章：主角最终平安归乡"));
    assert.ok(context.fullStory.includes("并非完整小说正文"));
    assert.ok(context.fullStory.includes("完整原文见 scriptContent"));
    assert.ok(!context.fullStory.includes("章节独有正文-57"));
    assert.ok(context.fullStory.length < full.fullStory.length / 10);
    assert.equal(context.nextChapter, `【第2章】\n${texts[1]}`);
    assert.equal(readDramaChapterSource(document, document.scene.nodes, "chapter-0").scriptContent, texts[0]);
    assert.equal(JSON.stringify(document), before);
});

test("短篇无梗概保留整本正文，前后章节仍完整", () => {
    const { document } = fixture(["首章完整原文", "本章完整原文", "末章完整原文"]);
    const full = buildDramaStoryContext(document, document.scene.nodes, "board-1")!;
    assert.equal(usesDramaChapterContext(full), false);
    assert.deepEqual(buildDramaPlanningContext(document, document.scene.nodes, "board-1"), full);
    assert.equal(full.previousChapter, "【第1章】\n首章完整原文");
    assert.equal(full.nextChapter, "【第3章】\n末章完整原文");
});

test("长篇当前章超过上下文阈值时仍完整作为 scriptContent 提交", () => {
    const source = `原章开端${"未省略剧情".repeat(7000)}原章最终结局`;
    const { document } = fixture(["前章完整原文", source, "后章完整原文"]);
    const chapter = readDramaChapterSource(document, document.scene.nodes, "chapter-1");
    const request = { scriptContent: chapter.scriptContent, storyContext: buildDramaPlanningContext(document, document.scene.nodes, chapter.board!.id) };
    assert.ok(source.length > DRAMA_FULL_STORY_CONTEXT_LIMIT);
    assert.ok(source.length < 40000);
    assert.equal(request.scriptContent, source);
    assert.ok(request.scriptContent.endsWith("原章最终结局"));
    assert.equal(request.storyContext?.previousChapter, "【第1章】\n前章完整原文");
    assert.equal(request.storyContext?.nextChapter, "【第3章】\n后章完整原文");
    assert.ok(!request.storyContext?.fullStory.includes(source));
});

test("用户梗概完整保留并切换分章模式，空白梗概不改变短篇模式", () => {
    const { document } = fixture(["小说第一章", "小说第二章"]);
    const full = buildDramaStoryContext(document, document.scene.nodes, "board-0")!;
    const synopsis = "主角寻找失散家人。\n伏笔：蓝色信封。\n结局：一家人在老屋重逢。";
    assert.equal(usesDramaChapterContext(full, synopsis), true);
    assert.ok(buildDramaPlanningContext(document, document.scene.nodes, "board-0", synopsis)?.fullStory.includes(`【全剧梗概】\n${synopsis}`));
    assert.equal(usesDramaChapterContext(full, " \n "), false);
    assert.deepEqual(buildDramaPlanningContext(document, document.scene.nodes, "board-0", " \n "), full);
});

test("前章或后章超过上限时明确报错，绝不截断", () => {
    for (const texts of [["长".repeat(12001), "本章"], ["本章", "长".repeat(12001)]]) {
        const { document } = fixture(texts);
        const boardId = texts[0] === "本章" ? "board-0" : "board-1";
        const before = JSON.stringify(document);
        assert.throws(() => buildDramaPlanningContext(document, document.scene.nodes, boardId), /相邻章节超过 12000 字.*避免衔接信息被截断/);
        assert.equal(JSON.stringify(document), before);
    }
});

test("已完成草稿的最新剧情节拍优先于旧镜头，失败草稿不覆盖旧节拍", () => {
    const { document, boards } = fixture(["第一章", "第二章", "第三章"]);
    boards[1].storyboard.shots = [beatShot("第二章旧节拍")];
    boards[2].storyboard.shots = [beatShot("第三章有效节拍")];
    const context = buildDramaPlanningContext(document, document.scene.nodes, "board-0", "全剧梗概", [
        { chapterId: "chapter-1", status: "ready", shots: [beatShot("第二章新节拍"), beatShot("第二章新节拍")] },
        { chapterId: "chapter-2", status: "failed", shots: [beatShot("失败草稿节拍")] },
    ])!;
    assert.ok(context.fullStory.includes("第二章新节拍"));
    assert.ok(!context.fullStory.includes("第二章旧节拍"));
    assert.equal(context.fullStory.split("第二章新节拍").length, 2);
    assert.ok(context.fullStory.includes("第三章有效节拍"));
    assert.ok(!context.fullStory.includes("失败草稿节拍"));
});

test("阈值边界统一用于 UI 提示和请求模式，不随组件产生漂移", () => {
    const context = { storyTitle: "小说", fullStory: "字".repeat(DRAMA_FULL_STORY_CONTEXT_LIMIT), chapterTitle: "第一章", chapterIndex: 1, chapterCount: 1 };
    assert.equal(usesDramaChapterContext(context), false);
    assert.equal(usesDramaChapterContext({ ...context, fullStory: `${context.fullStory}字` }), true);
    assert.equal(usesDramaChapterContext(undefined, "梗概"), false);
});

test("清空原文不恢复旧指令，目录超出后端上限时明确拒绝", () => {
    const { document } = fixture([""]);
    assert.equal(readDramaChapterSource(document, document.scene.nodes, "chapter-0").scriptContent, "");
    assert.throws(() => buildDramaPlanningContext(document, document.scene.nodes, "board-0", "梗概".repeat(61000)), /全剧目录和剧情摘要超过上下文上限/);
});
