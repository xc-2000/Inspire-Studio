import type { CanvasDocument, CanvasNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { createVideoNode } from "@/features/canvas/constants";
import type { DramaAssemblyState } from "./drama-assembly";
import { orderDramaItems } from "./drama-continuity";

export type ChapterAssemblyCheckpoint = { sourceSignature: string; state: DramaAssemblyState };
export type DramaVideoSelection = { chapterId: string; shotIds: string[] };
export const chapterAssemblyResultNodeId = (chapterId: string) => `chapter-assembly:${chapterId}:result`;

/** The storyboard owns the selected take. Expanded canvas nodes must not duplicate a shot. */
export function readChapterAssemblyPlan(document: CanvasDocument, nodes: CanvasNode[], chapterId: string) {
    const chapter = document.preferences.drama?.chapters.find(item => item.id === chapterId);
    const board = nodes.find(item => item.id === chapter?.storyboardNodeId && item.kind === "storyboard");
    const shots = board?.kind === "storyboard" ? orderDramaItems(board.storyboard.shots, shot => shot.shotNumber) : [];
    const ready = shots.filter(shot => Boolean(shot.video?.source.trim()));
    const missing = shots.filter(shot => !shot.video?.source.trim());
    const error = !chapter || !board ? "章节或分镜已删除" : new Set(shots.map(shot => shot.id)).size !== shots.length ? "分镜标识重复，请先修复分镜" : "";
    const structureSignature = JSON.stringify([document.identity.id, chapterId, board?.id, shots.map(shot => [shot.id, shot.shotNumber])]);
    const sourceSignature = JSON.stringify([structureSignature, ready.map(shot => [shot.id, shot.video?.storageKey?.trim() || shot.video?.source.trim()])]);
    return { chapter, shots, ready, missing, error, structureSignature, sourceSignature,
        sourceKeys: ready.map(shot => shot.video?.storageKey?.trim() || ""),
        durationSeconds: ready.reduce((sum, shot) => sum + (Number.isFinite(shot.durationSeconds) ? Math.max(0, shot.durationSeconds) : 0), 0),
    };
}
export type ChapterAssemblyPlan = ReturnType<typeof readChapterAssemblyPlan>;

export function assertPreparedChapterPlan(before: ChapterAssemblyPlan, after: ChapterAssemblyPlan) {
    if (after.error || before.structureSignature !== after.structureSignature || before.ready.length !== after.ready.length) throw new Error("章节或镜头已变化，请重新合成");
    before.ready.forEach((shot, index) => {
        const prepared = after.ready[index];
        if (shot.id !== prepared?.id || (shot.video?.storageKey && shot.video.storageKey !== prepared.video?.storageKey)) throw new Error("镜头视频已变化，请重新合成");
    });
    if (after.sourceKeys.some(key => !key)) throw new Error("部分镜头尚未保存，请重试");
}

/** Upsert a single result without moving or changing any source nodes. */
export function materializeChapterAssembly(nodes: CanvasNode[], plan: ChapterAssemblyPlan, state: DramaAssemblyState): CanvasNode[] {
    if (!plan.chapter || state.phase !== "succeeded" || !state.result?.storageKey || !state.result.url) return nodes;
    const id = chapterAssemblyResultNodeId(plan.chapter.id);
    const existing = nodes.find(node => node.id === id);
    const scoped = nodes.filter(node => node.dramaChapterId === plan.chapter!.id);
    const base = existing?.kind === "video" ? existing : createVideoNode({ id,
        position: { x: Math.max(0, ...scoped.map(node => node.frame.position.x + node.frame.width)) + 160,
            y: Math.min(0, ...scoped.map(node => node.frame.position.y)) },
    });
    const result: CanvasNode = { ...base, dramaChapterId: plan.chapter.id,
        title: `${plan.chapter.title} · ${plan.missing.length ? "片段合成" : "章节成片"}（${plan.ready.length} 镜）`,
        execution: { ...base.execution, phase: "succeeded", errorMessage: "" },
        content: { ...base.content, source: state.result.url, storageKey: state.result.storageKey, durationMilliseconds: state.result.durationMilliseconds, mimeType: "video/mp4" },
        frame: { ...base.frame, height: state.result.width && state.result.height ? base.frame.width * state.result.height / state.result.width : base.frame.height },
    };
    return existing ? nodes.map(node => node.id === id ? result : node) : [...nodes, result];
}

export const shotNumbersLabel = (shots: CanvasStoryboardShot[]) => shots.map(shot => String(shot.shotNumber).padStart(2, "0")).join("、");
