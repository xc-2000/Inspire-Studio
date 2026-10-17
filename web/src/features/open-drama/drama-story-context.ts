import type { CanvasDocument, CanvasNode, CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { buildDramaStoryContext, type DramaStoryContext } from "./drama-continuity";

/** Long books use chapter context instead of repeating the whole novel on every request. */
export const DRAMA_FULL_STORY_CONTEXT_LIMIT = 24000;
const ADJACENT_CHAPTER_CONTEXT_LIMIT = 12000;
const PLANNING_SUMMARY_CONTEXT_LIMIT = 120000;

type PlanningDraft = {
    chapterId: string;
    status: string;
    shots: readonly CanvasStoryboardShot[];
};

/** An intentionally emptied script must not fall back to an old instruction. */
export function readDramaChapterSource(document: CanvasDocument, nodes: CanvasNode[], chapterId: string) {
    const chapter = document.preferences.drama?.chapters.find(item => item.id === chapterId);
    const board = nodes.find((node): node is CanvasStoryboardNode => node.id === chapter?.storyboardNodeId && node.kind === "storyboard");
    const script = nodes.find(node => node.id === chapter?.scriptNodeId);
    const scriptContent = script?.kind === "text" ? script.content.text.trim() : board?.content.instruction.trim() || "";
    return { chapter, board, scriptContent };
}

/** The UI and request builder share the same switch, including a supplied synopsis. */
export function usesDramaChapterContext(context: DramaStoryContext | undefined, synopsis = ""): boolean {
    return Boolean(context && (context.fullStory.length > DRAMA_FULL_STORY_CONTEXT_LIMIT || synopsis.trim()));
}

/** Source chapter and neighboring chapters are complete; only whole-book context changes form. */
export function buildDramaPlanningContext(
    document: CanvasDocument,
    nodes: CanvasNode[],
    boardId: string,
    synopsis = "",
    drafts: readonly PlanningDraft[] = [],
): DramaStoryContext | undefined {
    const context = buildDramaStoryContext(document, nodes, boardId);
    if (!context) return undefined;
    if ((context.previousChapter?.length || 0) > ADJACENT_CHAPTER_CONTEXT_LIMIT || (context.nextChapter?.length || 0) > ADJACENT_CHAPTER_CONTEXT_LIMIT) {
        throw new Error("相邻章节超过 12000 字，请先拆分长章节，再生成草稿，避免衔接信息被截断。");
    }
    if (!usesDramaChapterContext(context, synopsis)) return context;
    const directory = (document.preferences.drama?.chapters || []).map((chapter, index) => {
        const draft = drafts.find(item => item.chapterId === chapter.id && item.status === "ready");
        const source = readDramaChapterSource(document, nodes, chapter.id);
        const beats = [...new Set((draft?.shots || source.board?.storyboard.shots || []).map(shot => shot.continuity?.storyBeat?.trim()).filter(Boolean))];
        return `${index + 1}. ${chapter.title}${beats.length ? `：${beats.join("；")}` : "（尚无结构化剧情摘要）"}`;
    }).join("\n");
    const fullStory = [
        "【分章上下文：以下是全剧目录与已知剧情节拍，并非完整小说正文；本次完整原文见 scriptContent，前后章另附。不得据缺失摘要虚构人物结局。】",
        synopsis.trim() ? `【全剧梗概】\n${synopsis.trim()}` : "【全剧梗概尚未提供；仅依据原章及相邻章优化，不宣称全剧主线已核验】",
        directory,
    ].join("\n\n");
    if (fullStory.length > PLANNING_SUMMARY_CONTEXT_LIMIT) throw new Error("全剧目录和剧情摘要超过上下文上限，请按卷拆分项目后继续。");
    return { ...context, fullStory };
}
