import type { CanvasDocument, CanvasDramaChapter, CanvasNode, CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { readDramaStoryQuality, type DramaStoryQualityIssue } from "./drama-story-quality";
import { dramaShotVideoSignature, readDramaVideoDependencyIssue } from "./drama-video-continuity";

export interface DramaStoryContext {
    storyTitle: string;
    fullStory: string;
    chapterTitle: string;
    chapterIndex: number;
    chapterCount: number;
    previousChapter?: string;
    nextChapter?: string;
}

export interface DramaOrderedShot {
    chapter: CanvasDramaChapter;
    chapterIndex: number;
    board: CanvasStoryboardNode;
    shot: CanvasStoryboardShot;
}

export interface DramaContinuityIssue {
    severity: "error" | "warning";
    code: DramaStoryQualityIssue["code"] | "stale-video" | "mixed-video-settings" | "missing-chapters" | "missing-board" | "duplicate-board" | "missing-script" | "empty-chapter" | "duplicate-shot" | "duplicate-shot-number" | "missing-video" | "missing-storage" | "missing-asset" | "invalid-duration";
    message: string;
    chapterId?: string;
    shotId?: string;
}

/** Stable order for imported source arrays; ties and unknown positions retain their input order. */
export function orderDramaItems<T>(items: readonly T[], position: (item: T) => number): T[] {
    return items.map((item, index) => ({ item, index, order: position(item) }))
        .sort((a, b) => {
            const left = Number.isFinite(a.order) && a.order > 0 ? a.order : Number.POSITIVE_INFINITY;
            const right = Number.isFinite(b.order) && b.order > 0 ? b.order : Number.POSITIVE_INFINITY;
            return left === right ? a.index - b.index : left - right;
        }).map(({ item }) => item);
}

function chapterScript(chapter: CanvasDramaChapter, nodesById: Map<string, CanvasNode>): string {
    const script = chapter.scriptNodeId ? nodesById.get(chapter.scriptNodeId) : undefined;
    // An explicitly cleared script is a user edit and must not resurrect old text.
    if (script?.kind === "text") return script.content.text.trim();
    const board = nodesById.get(chapter.storyboardNodeId);
    return board?.kind === "storyboard" ? board.content.instruction.trim() : "";
}

/** Full source text is sent to the text planning API, never silently cut to a chapter excerpt. */
export function buildDramaStoryContext(document: CanvasDocument, nodes: CanvasNode[], boardId: string): DramaStoryContext | undefined {
    const chapters = document.preferences.drama?.chapters || [];
    const chapterIndex = chapters.findIndex(chapter => chapter.storyboardNodeId === boardId);
    if (chapterIndex < 0) return undefined;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const texts = chapters.map(chapter => `【${chapter.title}】\n${chapterScript(chapter, byId)}`);
    return {
        storyTitle: document.identity.title,
        fullStory: texts.join("\n\n"),
        chapterTitle: chapters[chapterIndex].title,
        chapterIndex: chapterIndex + 1,
        chapterCount: chapters.length,
        ...(chapterIndex > 0 ? { previousChapter: texts[chapterIndex - 1] } : {}),
        ...(chapterIndex + 1 < chapters.length ? { nextChapter: texts[chapterIndex + 1] } : {}),
    };
}

/** Every expected chapter and shot is inspected; missing media is never filtered out. */
export function readDramaContinuityReport(document: CanvasDocument, nodes: CanvasNode[] = document.scene.nodes) {
    const chapters = document.preferences.drama?.chapters || [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const orderedShots: DramaOrderedShot[] = [];
    const issues: DramaContinuityIssue[] = [];
    const seenBoards = new Set<string>();
    let readyCount = 0;
    let storedCount = 0;
    let durationSeconds = 0;
    if (!chapters.length) issues.push({ severity: "error", code: "missing-chapters", message: "短剧尚无章节" });
    chapters.forEach((chapter, index) => {
        const board = byId.get(chapter.storyboardNodeId);
        const issue = (severity: DramaContinuityIssue["severity"], code: DramaContinuityIssue["code"], message: string, shotId?: string) =>
            issues.push({ severity, code, message: `${chapter.title}：${message}`, chapterId: chapter.id, ...(shotId ? { shotId } : {}) });
        if (!board || board.kind !== "storyboard") { issue("error", "missing-board", "分镜节点缺失"); return; }
        if (seenBoards.has(board.id)) { issue("error", "duplicate-board", "多个章节关联了同一分镜节点"); return; }
        seenBoards.add(board.id);
        for (const quality of readDramaStoryQuality(board.storyboard.shots)) issue(quality.severity, quality.code, quality.message, quality.shotId);
        const settings = new Set(board.storyboard.shots.filter(shot => shot.video?.model && shot.video?.size).map(shot => `${shot.video!.model}:${shot.video!.size}`));
        if (settings.size > 1) issue("warning", "mixed-video-settings", "视频混用了不同模型或画幅，请顺序预览确认画风和构图衔接");
        if (!chapterScript(chapter, byId)) issue("warning", "missing-script", "本章剧本为空，无法核对剧情覆盖");
        if (!board.storyboard.shots.length) issue("error", "empty-chapter", "尚无镜头，成片会缺少本章");
        const seenShots = new Set<string>();
        const seenNumbers = new Set<number>();
        const assetIds = new Set([...board.storyboard.assets, ...(document.preferences.drama?.assets || [])].map(asset => asset.id));
        for (const shot of orderDramaItems(board.storyboard.shots, shot => shot.shotNumber)) {
            orderedShots.push({ chapter, chapterIndex: index + 1, board, shot });
            if (seenShots.has(shot.id)) issue("error", "duplicate-shot", `镜头 ${shot.shotNumber} 的标识重复`, shot.id);
            seenShots.add(shot.id);
            if (seenNumbers.has(shot.shotNumber)) issue("warning", "duplicate-shot-number", `镜号 ${shot.shotNumber} 重复，按现有排列顺序播放`, shot.id);
            seenNumbers.add(shot.shotNumber);
            if (Number.isFinite(shot.durationSeconds) && shot.durationSeconds > 0) durationSeconds += shot.durationSeconds;
            else issue("warning", "invalid-duration", `镜头 ${shot.shotNumber} 的时长无效`, shot.id);
            if (shot.assetIds.some(id => !assetIds.has(id))) issue("warning", "missing-asset", `镜头 ${shot.shotNumber} 的关联素材已缺失`, shot.id);
            if (!shot.video?.source.trim()) issue("error", "missing-video", `镜头 ${shot.shotNumber} 缺少视频`, shot.id);
            else {
                readyCount++;
                if (shot.video.sourceSignature && shot.video.sourceSignature !== dramaShotVideoSignature(shot, board)) issue("error", "stale-video", `镜头 ${shot.shotNumber} 已修改剧情或参考素材，旧视频需要重新生成`, shot.id);
                const dependencyIssue = readDramaVideoDependencyIssue(board, shot);
                if (dependencyIssue) issue("error", "stale-video", dependencyIssue, shot.id);
                if (shot.video.storageKey?.trim()) storedCount++;
                else issue("warning", "missing-storage", `镜头 ${shot.shotNumber} 尚未保存为可合成的视频素材`, shot.id);
            }
        }
    });
    const complete = orderedShots.length > 0 && !issues.some(issue => issue.severity === "error" && ["missing-chapters", "missing-board", "duplicate-board", "empty-chapter", "duplicate-shot", "missing-video"].includes(issue.code));
    return {
        issues, orderedShots, chapterCount: chapters.length, shotCount: orderedShots.length, readyCount, storedCount, durationSeconds,
        canPreview: complete,
        canCompose: complete && storedCount === orderedShots.length && !issues.some(issue => issue.severity === "error"),
    };
}

const bounded = (text: string | undefined, maximum: number) => {
    const value = (text || "").replace(/\s+/g, " ").trim();
    return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
};

function neighborDescription(item: DramaOrderedShot): string {
    const shot = item.shot;
    return `${bounded(item.chapter.title, 64)} / 镜头 ${shot.shotNumber}：${bounded(shot.visualDescription || shot.videoPrompt || shot.finalPrompt, 360)}${shot.dialogueVoiceover ? `；对白：${bounded(shot.dialogueVoiceover, 100)}` : ""}`;
}

/** Submission-only continuity context; the editable source prompt remains unchanged. */
export function buildDramaShotVideoPrompt(document: CanvasDocument, nodes: CanvasNode[], boardId: string, shotId: string, promptOverride?: string): string {
    const board = nodes.find((node): node is CanvasStoryboardNode => node.id === boardId && node.kind === "storyboard");
    const shot = board?.storyboard.shots.find(shot => shot.id === shotId);
    if (!board || !shot) return "";
    const prompt = (promptOverride ?? shot.videoPrompt ?? shot.finalPrompt)
        .replace(/(?:\n\n)?【短剧连续性上下文：开始】[\s\S]*?【短剧连续性上下文：结束】/g, "").trim();
    if (!prompt || !document.preferences.drama) return prompt;
    const report = readDramaContinuityReport(document, nodes);
    const index = report.orderedShots.findIndex(item => item.board.id === boardId && item.shot.id === shotId);
    if (index < 0) return prompt;
    const current = report.orderedShots[index];
    const previous = report.orderedShots[index - 1];
    const next = report.orderedShots[index + 1];
    const assets = new Map([...(document.preferences.drama.assets || []), ...board.storyboard.assets].map(asset => [asset.id, asset]));
    if (shot.videoPromptContextMode === "self-contained") {
        const identities = [...new Set(shot.assetIds)].map(id => {
            const asset = assets.get(id);
            const kind = asset?.kind === "character" ? "角色" : asset?.kind === "scene" ? "场景" : asset?.kind === "prop" ? "道具" : "素材";
            return `${kind}${asset?.name ? ` ${bounded(asset.name, 48)}` : ""}（ID：${bounded(id, 120)}）`;
        });
        const context = [
            "【短剧连续性上下文：开始】",
            `镜头 ${shot.shotNumber}，时长 ${shot.durationSeconds} 秒。`,
            identities.length ? `素材身份：${identities.join("；")}。` : "保持参考图中的人物身份与道具一致。",
            ...(shot.continuity ? [
                `场景标识：${bounded(shot.continuity.sceneId, 120)}；时间：${bounded(shot.continuity.time, 120)}；转场类型：${shot.continuity.transition}。`,
                shot.continuity.transition === "continue"
                    ? "第一张参考图是上一镜真实尾帧，从该画面继续当前动作，保持脸型、衣服、光线、人物位置与运动方向；不要重复上一镜动作。"
                    : "这是明确的镜头切换，按提示词中的起始状态建立本镜空间与时间。",
            ] : []),
            "只拍摄上述提示词的当前镜头内容与指定时长。",
            "【短剧连续性上下文：结束】",
        ].join("\n");
        return `${prompt}\n\n${context}`;
    }
    const identities = [...new Set(shot.assetIds)].map(id => assets.get(id)).filter(asset => Boolean(asset))
        .map(asset => `${asset!.kind === "character" ? "角色" : asset!.kind === "scene" ? "场景" : "道具"} ${bounded(asset!.name, 48)}：${bounded(asset!.description, 180)}`).join("\n");
    const context = [
        "【短剧连续性上下文：开始】",
        `【短剧连续性】《${bounded(document.identity.title, 80)}》第 ${current.chapterIndex}/${report.chapterCount} 章「${bounded(current.chapter.title, 80)}」，镜头 ${shot.shotNumber}，时长 ${shot.durationSeconds} 秒。`,
        `统一视觉：${bounded(board.content.visualStyle, 260) || "延续参考图及相邻镜头的画面风格、人物造型和场景光线"}。`,
        identities ? `连续性设定：\n${bounded(identities, 1000)}` : "延续参考图中人物的面貌、服饰、道具与空间关系。",
        previous ? `上镜承接：${neighborDescription(previous)}。保持已建立的动作进度、角色位置与运动方向；若剧情切换时空，使用清晰的建立镜头。` : "这是全剧首镜：清楚建立人物、地点与初始动作。",
        `当前镜头：${bounded(shot.visualDescription, 320)}${shot.cameraMovement ? `；运镜：${bounded(shot.cameraMovement, 100)}` : ""}${shot.dialogueVoiceover ? `；对白/旁白：${bounded(shot.dialogueVoiceover, 160)}` : ""}`,
        ...(shot.continuity ? [
            `场景标识：${shot.continuity.sceneId}；时间：${shot.continuity.time}；转场类型：${shot.continuity.transition}。`,
            `必须从此状态开始：${shot.continuity.openingState}。必须在此状态结束：${shot.continuity.closingState}。`,
            shot.continuity.transition === "continue" ? "第一张参考图是上一镜真实尾帧，从该画面继续当前动作，保持脸型、衣服、光线、人物位置与运动方向；不要把上一镜的动作重新演一遍。" : "这是明确的镜头切换，用本镜起始状态建立空间与时间；不要误把相邻镜头当作同一连续动作。",
        ] : []),
        next ? `下镜衔接：${neighborDescription(next)}。以可自然接入下镜的动作、视线或构图结束，不提前演出下镜事件。` : "这是全剧末镜：完成本镜动作，保留自然收尾，不另起情节。",
        "只拍摄当前镜头的内容与指定时长；保持人物身份和道具状态一致。除剧本明确要求外，不增加片头、片尾、黑场、转场字幕或重复上一镜的完整动作。",
        "【短剧连续性上下文：结束】",
    ].join("\n");
    return `${prompt}\n\n${context}`;
}
