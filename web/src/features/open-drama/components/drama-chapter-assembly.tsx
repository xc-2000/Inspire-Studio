"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal, Progress, Tag } from "antd";
import { Clapperboard, Download, LoaderCircle, LocateFixed, Play } from "lucide-react";
import { saveAs } from "file-saver";
import type { CanvasDocument, CanvasNode } from "@/features/canvas/types";
import { composeVideo, waitVideoCompositionTask } from "@/services/api/video-composition";
import { downloadServerMedia, getServerMediaInfo } from "@/services/api/server";
import { DramaAssemblyTaskFailedError, runDramaAssembly, type DramaAssemblyState } from "../drama-assembly";
import { assertPreparedChapterPlan, readChapterAssemblyPlan, shotNumbersLabel, type ChapterAssemblyPlan, type DramaVideoSelection } from "../drama-chapter-assembly";
import styles from "./drama-chapter-assembly.module.css";

export type ChapterAssemblyActions = {
    onReadChapterPlan: (chapterId: string) => ChapterAssemblyPlan;
    onChapterAssembly: (chapterId: string, signature: string, state: DramaAssemblyState) => Promise<void>;
    onPrepareMedia: (selection?: DramaVideoSelection) => Promise<CanvasNode[]>;
    onLocateAssembly: (chapterId: string) => void;
};
type Props = ChapterAssemblyActions & { document: CanvasDocument; nodes: CanvasNode[]; chapterId: string };

export function DramaChapterAssembly(props: Props) {
    const { message } = App.useApp();
    const plan = readChapterAssemblyPlan(props.document, props.nodes, props.chapterId);
    const saved = plan.chapter?.assembly;
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);
    const [stage, setStage] = useState("");
    const [error, setError] = useState("");
    const [playError, setPlayError] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const run = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const resumeBlocked = useRef(false);
    const latest = useRef(props);
    latest.current = props;
    const current = saved?.sourceSignature === plan.sourceSignature;
    const result = current && saved?.state.phase === "succeeded" ? saved.state.result : undefined;
    const completed = saved?.state.batches.filter(batch => batch.phase === "succeeded").length || 0;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; run.current?.abort(); };
    }, []);

    const begin = useCallback(async () => {
        if (run.current) return;
        const actions = latest.current;
        const initial = actions.onReadChapterPlan(actions.chapterId);
        if (initial.error || initial.ready.length < 2) { setError(initial.error || "至少需要 2 个已生成的视频"); return; }
        const controller = new AbortController();
        run.current = controller;
        resumeBlocked.current = false;
        setBusy(true); setError(""); setProgress(0); setPlayError(false);
        setStage("准备视频素材");
        try {
            if (initial.sourceKeys.some(key => !key)) await actions.onPrepareMedia({ chapterId: actions.chapterId, shotIds: initial.ready.map(shot => shot.id) });
            controller.signal.throwIfAborted();
            const prepared = actions.onReadChapterPlan(actions.chapterId);
            assertPreparedChapterPlan(initial, prepared);
            const assertCurrent = () => {
                const live = actions.onReadChapterPlan(actions.chapterId);
                if (live.error || live.sourceSignature !== prepared.sourceSignature) throw new Error("镜头或视频已变化，请按当前内容重新合成");
            };
            const checkpoint = prepared.chapter?.assembly;
            let rejectedBeforeSubmit = false;
            const persist = async (state: DramaAssemblyState) => {
                if (state.phase === "succeeded") assertCurrent();
                const next = rejectedBeforeSubmit ? { ...state, batches: state.batches.map(batch => batch.phase === "submitting" && !batch.taskId ? { ...batch, phase: "pending" as const } : batch) } : state;
                await actions.onChapterAssembly(actions.chapterId, prepared.sourceSignature, next);
            };
            const finished = await runDramaAssembly(prepared.sourceKeys, {
                checkpoint: checkpoint?.sourceSignature === prepared.sourceSignature ? checkpoint.state : undefined,
                signal: controller.signal,
                onState: persist,
                submit: keys => {
                    try { assertCurrent(); } catch (error) { rejectedBeforeSubmit = true; throw error; }
                    if (mounted.current) { setStage(`合成视频 · ${keys.length} 段`); setProgress(0); }
                    return composeVideo(keys);
                },
                wait: async taskId => {
                    assertCurrent();
                    const task = await waitVideoCompositionTask(taskId, { signal: controller.signal, onProgress: task => {
                        if (mounted.current) { setProgress(task.progress); setStage(task.status === "pending" ? "等待合成" : "正在合成视频"); }
                    } });
                    if (task.status === "failed" || task.status === "canceled") throw new DramaAssemblyTaskFailedError(task.errorMessage || "合成任务未完成，请重试");
                    if (!task.resultData.storageKey) throw new Error("合成结果缺少存储信息");
                    const media = task.resultData.url ? task.resultData : await getServerMediaInfo(task.resultData.storageKey);
                    if (!media.url) throw new Error("成片地址暂时不可用，请重试查询");
                    return { ...media, storageKey: task.resultData.storageKey, durationMilliseconds: media.durationMs };
                },
            });
            // Also restore the result node when resuming an already completed checkpoint.
            await persist(finished);
            if (mounted.current) { setProgress(100); setStage("合成完成"); }
        } catch (cause) {
            if (!controller.signal.aborted && mounted.current) {
                resumeBlocked.current = true;
                setError(cause instanceof Error ? cause.message : "视频合成失败");
            }
        } finally {
            if (run.current === controller) run.current = null;
            if (mounted.current) setBusy(false);
        }
    }, []);

    useEffect(() => {
        if (!busy && !resumeBlocked.current && current && saved?.state.phase === "running") void begin();
    }, [current, saved, busy, begin]);

    const download = async () => {
        if (!result) return;
        setDownloading(true);
        try {
            const blob = await downloadServerMedia(result.storageKey);
            if (!blob) throw new Error("成片不存在");
            saveAs(blob, `${plan.chapter?.title || "章节"}-${plan.missing.length ? "片段合成" : "成片"}.mp4`);
        }
        catch { message.error("下载失败，请稍后重试"); }
        finally { setDownloading(false); }
    };

    return <>
        <Button size="small" type="primary" icon={busy ? <LoaderCircle size={14} className={styles.spinning} /> : <Clapperboard size={14} />} disabled={!plan.shots.length} onClick={() => setOpen(true)}>{busy ? "合成中" : result ? "查看成片" : "一键合成"}</Button>
        <Modal title={<span className={styles.title}><Clapperboard size={18} />章节视频合成{result ? ` · ${plan.chapter?.title}` : ""}</span>} open={open} onCancel={() => setOpen(false)} footer={null} width={650} centered>
            <div className={styles.panel}>
                {!result && <div className={styles.heading}><div><strong>{plan.chapter?.title}</strong><p>按镜号顺序连接视频，保留原片段声音</p></div><Tag color={plan.missing.length ? "gold" : "green"}>{plan.missing.length ? "部分片段" : "完整章节"}</Tag></div>}
                <div className={styles.stats}><div><strong>{plan.ready.length}<small> / {plan.shots.length}</small></strong><span>可合成镜头</span></div><div><strong>{Math.round(plan.durationSeconds)}<small> 秒</small></strong><span>分镜预计时长 · 以成片为准</span></div><div><strong>{plan.missing.length}</strong><span>尚未生成</span></div></div>
                {plan.missing.length > 0 && <Alert type="warning" showIcon title={`本次合成已生成的 ${plan.ready.length} 段，缺少 ${plan.missing.length} 镜。`} description={<details className={styles.missing}><summary>查看缺少的镜头 · 补齐后可重新合成</summary><p>{shotNumbersLabel(plan.missing)}</p></details>} />}
                <details className={styles.sequence} open={!result}><summary>合成顺序 · {plan.ready.length} 镜</summary><div>{plan.ready.map(shot => <Tag key={shot.id}>镜头 {String(shot.shotNumber).padStart(2, "0")}</Tag>)}{!plan.ready.length && <p>先生成镜头视频，再回来合成</p>}</div></details>
                {!current && saved && <Alert type="info" showIcon title="镜头已更新，下次合成将使用当前视频。" />}
                {(error || plan.error) && <Alert type="error" showIcon title={error || plan.error} />}
                {busy && <div className={styles.progress}><span>{stage}{completed > 0 ? ` · 已完成 ${completed} 批` : ""}</span><Progress percent={progress} size="small" /><small>可以关闭此窗口，任务会继续执行；刷新后会恢复查询。</small></div>}
                {result?.url && <div className={styles.result}><video key={result.storageKey} aria-label="章节合成视频" src={result.url} controls playsInline preload="metadata" onError={() => setPlayError(true)} />{playError && <Alert type="error" title="成片播放失败，请尝试下载视频。" />}</div>}
                <div className={styles.footer}><small>{result ? "成片已保存到当前章节画布" : "自动保存合成进度"}</small><div>{result ? <><Button icon={<LocateFixed size={15} />} onClick={() => { setOpen(false); props.onLocateAssembly(props.chapterId); }}>定位成片</Button><Button type="primary" icon={<Download size={15} />} loading={downloading} onClick={() => void download()}>下载视频</Button></> : <Button type="primary" icon={<Play size={14} />} disabled={Boolean(plan.error) || plan.ready.length < 2} loading={busy} onClick={() => void begin()}>{busy ? "正在合成" : current && saved ? "继续合成" : `合成已生成的 ${plan.ready.length} 段`}</Button>}</div></div>
            </div>
        </Modal>
    </>;
}
