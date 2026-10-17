import { AlertTriangle, ArrowUpRight, Check, Clapperboard, LoaderCircle, Play } from "lucide-react";
import type { CanvasTheme } from "@/shared/lib/canvas-theme";
import type { CanvasConnection, CanvasNode } from "../types";
import { summarizeOneSentenceFilmProgress, type OneSentenceFilmRun, type OneSentenceFilmShotStep } from "../domain/one-sentence-film-progress";

const stepStatusLabels: Record<OneSentenceFilmShotStep["status"], string> = { missing: "待创建", pending: "待执行", running: "生成中", completed: "已完成", failed: "失败" };

export function OneSentenceFilmProgress({ run, nodes, connections = [], busy, theme, onContinue, onLocateNode }: {
    run: OneSentenceFilmRun;
    nodes: CanvasNode[];
    connections?: CanvasConnection[];
    busy: boolean;
    theme: CanvasTheme;
    onContinue: () => void;
    onLocateNode: (id: string) => void;
}) {
    const progress = summarizeOneSentenceFilmProgress(run, nodes, connections);
    const Icon = progress.ready ? Check : progress.failed ? AlertTriangle : busy ? LoaderCircle : Clapperboard;
    return (
        <section className="rounded-xl border p-3" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.itemHover }} aria-label="一句话成片进度">
            <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-xs font-medium" style={{ color: theme.node.text }}><Clapperboard className="size-3.5" />一句话成片</span>
                <span className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: progress.failed ? "#ef4444" : theme.node.muted }} role="status"><Icon className={`size-3 ${busy && !progress.ready && !progress.failed ? "animate-spin motion-reduce:animate-none" : ""}`} />{progress.label}</span>
            </div>
            {progress.fullPipeline ? <p className="mt-2 text-[10px] leading-4" style={{ color: theme.node.muted }}>剧本 → 分镜图 → 镜头视频 → 合成</p> : null}
            <div className="mt-3 grid grid-cols-4 gap-1.5">
                {progress.stages.map((stage) => (
                    <button key={stage.id} type="button" disabled={!stage.nodeId} onClick={() => stage.nodeId && onLocateNode(stage.nodeId)}
                        className="min-w-0 rounded-lg px-1 py-2 text-center focus-visible:outline-2 disabled:cursor-default enabled:hover:opacity-75"
                        style={{ background: theme.node.panel, color: stage.failed ? "#ef4444" : stage.completed ? theme.toolbar.activeText : theme.node.muted }}
                        aria-label={`${stage.label}：${stage.completed}/${stage.total} 完成${stage.failed ? `，${stage.failed} 个失败` : ""}${stage.nodeId ? "，定位节点" : ""}`}>
                        <span className="block text-[10px]">{stage.label}</span>
                        <span className="mt-1 block text-xs font-semibold tabular-nums">{stage.total ? <>{stage.completed}<span className="font-normal opacity-50"> / {stage.total}</span></> : <span className="text-[10px] font-normal">{progress.fullPipeline ? "待规划" : progress.ready ? "未使用" : "待创建"}</span>}</span>
                    </button>
                ))}
            </div>
            {progress.shots.length ? <div className="mt-3" aria-label="每镜制作进度">
                <div className="grid grid-cols-[minmax(0,1fr)_54px_54px_54px] gap-1 px-1 pb-1.5 text-[10px]" style={{ color: theme.node.muted }}><span>共 {progress.shots.length} 镜</span><span className="text-center">文字</span><span className="text-center">分镜图</span><span className="text-center">视频</span></div>
                <ol className="thin-scrollbar max-h-48 space-y-1 overflow-y-auto" aria-label="分镜任务">
                    {progress.shots.map((shot, index) => <li key={`${shot.id}-${index}`} className="grid grid-cols-[minmax(0,1fr)_54px_54px_54px] items-center gap-1 rounded-md px-1 py-1" style={{ background: theme.node.panel }}>
                        <span className="truncate text-[10px]" title={shot.label} style={{ color: theme.node.text }}>{shot.label}</span>
                        {shot.steps.map(step => <button key={step.kind} type="button" disabled={!step.nodeId} onClick={() => step.nodeId && onLocateNode(step.nodeId)}
                            className="h-6 rounded text-[10px] focus-visible:outline-2 enabled:hover:opacity-70 disabled:cursor-default"
                            style={{ color: step.status === "failed" ? "#ef4444" : step.status === "completed" || step.status === "running" ? theme.toolbar.activeText : theme.node.muted }}
                            aria-label={`${shot.label}，${step.label}：${stepStatusLabels[step.status]}${step.nodeId ? "，定位节点" : ""}`}>{stepStatusLabels[step.status]}</button>)}
                    </li>)}
                </ol>
            </div> : null}
            {progress.failed > 0 ? <button type="button" onClick={() => progress.failedNodeId && onLocateNode(progress.failedNodeId)} className="mt-2 block text-left text-[11px] leading-5 focus-visible:outline-2" style={{ color: "#ef4444" }}>{progress.failed} 个任务失败，点击定位检查</button> : null}
            {!progress.ready && progress.missing > 0 ? <p className="mt-2 text-[11px] leading-5" style={{ color: theme.node.muted }}>{progress.missing} 个计划节点尚未就绪，继续时会核对补齐。</p> : null}
            {progress.ready && progress.resultNodeId ? <button type="button" onClick={() => onLocateNode(progress.resultNodeId!)} className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium focus-visible:outline-2" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}><Play className="size-3" />查看成片<ArrowUpRight className="size-3" /></button>
                : !busy ? <button type="button" onClick={onContinue} className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium focus-visible:outline-2" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}><Play className="size-3" />继续成片</button> : null}
        </section>
    );
}
