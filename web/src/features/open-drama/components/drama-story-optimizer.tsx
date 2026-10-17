"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Progress, Select } from "antd";
import { ArrowRight, BookOpen, Check, ChevronDown, Clapperboard, Clock3, Coins, History, Info, MessageSquare, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import type { CanvasDocument, CanvasNode, CanvasStoryboardAsset, CanvasStoryboardShot } from "@/features/canvas/types";
import { resolveStoryboardTextModel } from "@/features/canvas/domain/storyboard";
import { isVideoDurationSupported } from "@/features/generation/lib/video-duration";
import { ModelPicker } from "@/features/settings/components/model-picker";
import { modelOptionLabel, useConfigStore, useEffectiveConfig } from "@/features/settings/stores/use-config-store";
import { generateStoryboard } from "@/services/api/storyboard";
import { ListPagination } from "@/shared/components/list-pagination";
import { usePaginatedList } from "@/shared/hooks/use-paginated-list";
import { buildDramaStoryContext } from "../drama-continuity";
import { buildDramaPlanningContext, readDramaChapterSource, usesDramaChapterContext } from "../drama-story-context";
import { createDramaStorySourceSignature } from "../drama-story-revision";
import { readDramaStoryQuality } from "../drama-story-quality";
import { collectDramaAssets } from "../drama-workspace";
import { dramaPlanningShotSecondsLabel, readDramaPlanningShotSeconds } from "../drama-planning-duration";
import styles from "./drama-story-optimizer.module.css";

export type DramaStoryOptimizerApplyRequest = {
    chapterId: string;
    boardId: string;
    sourceSignature: string;
    sourceAssetIds: string[];
    shots: CanvasStoryboardShot[];
    assets: CanvasStoryboardAsset[];
    model: string;
};

type Props = {
    document: CanvasDocument;
    nodes: CanvasNode[];
    onApply: (request: DramaStoryOptimizerApplyRequest) => Promise<void>;
    onRestore?: (boardId: string, revisionId: string) => Promise<void>;
};
type Draft = DramaStoryOptimizerApplyRequest & {
    title: string;
    status: "pending" | "running" | "ready" | "failed" | "applied";
    previousShotCount: number;
    chargedCredits?: number;
    error?: string;
    appliedSignature?: string;
    appliedAssetIds?: string[];
};
const transitions: Record<string, string> = { establish: "建立场景", continue: "连续动作", cut: "切换场景", "time-jump": "时间推进", flashback: "进入回忆", return: "回到现在" };

export function DramaStoryOptimizer({ document, nodes, onApply, onRestore }: Props) {
    const { message, modal } = App.useApp();
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore(state => state.isAiConfigReady);
    const [open, setOpen] = useState(false);
    const [scope, setScope] = useState("current");
    const [model, setModel] = useState("");
    const [synopsis, setSynopsis] = useState("");
    const [drafts, setDrafts] = useState<Draft[]>([]);
    const [selected, setSelected] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [applying, setApplying] = useState(false);
    const [storageNotice, setStorageNotice] = useState("");
    const [historyOpen, setHistoryOpen] = useState(false);
    const stop = useRef(false);
    const running = useRef(false);
    const mounted = useRef(true);
    const draftRef = useRef<Draft[]>([]);
    const latest = useRef({ document, nodes, onApply, onRestore });
    latest.current = { document, nodes, onApply, onRestore };
    const storageKey = `drama-story-drafts:v1:${document.identity.id}`;
    const chapters = document.preferences.drama?.chapters || [];
    const activeId = document.preferences.drama?.activeChapterId || chapters[0]?.id;
    const current = readDramaChapterSource(document, nodes, activeId || "");
    const selectedDraft = drafts.find(item => item.chapterId === selected) || drafts[0];
    const selectedSource = selectedDraft ? readDramaChapterSource(document, nodes, selectedDraft.chapterId) : undefined;
    const projectAssets = useMemo(() => collectDramaAssets(nodes, document.preferences.drama?.assets || []), [nodes, document.preferences.drama?.assets]);
    const signatureAssets = projectAssets.filter(asset => !selectedDraft?.sourceAssetIds || selectedDraft.sourceAssetIds.includes(asset.id));
    const signature = selectedSource?.board ? createDramaStorySourceSignature(selectedSource.board, selectedSource.scriptContent, signatureAssets) : "";
    const stale = Boolean(selectedDraft && selectedDraft.status !== "applied" && selectedDraft.sourceSignature && selectedDraft.sourceSignature !== signature);
    const appliedSignature = selectedSource?.board && selectedDraft?.appliedAssetIds ? createDramaStorySourceSignature(selectedSource.board, selectedSource.scriptContent, projectAssets.filter(asset => selectedDraft.appliedAssetIds!.includes(asset.id))) : "";
    const changedAfterApply = Boolean(selectedDraft?.status === "applied" && (!selectedDraft.appliedSignature || selectedDraft.appliedSignature !== appliedSignature));
    const issues = useMemo(() => selectedDraft?.status === "ready" ? readDramaStoryQuality(selectedDraft.shots) : [], [selectedDraft]);
    const shotsPage = usePaginatedList(selectedDraft?.shots || [], 6, selectedDraft?.chapterId);
    const chapterPage = usePaginatedList(drafts, 12);
    const historyPage = usePaginatedList([...(current.board?.storyboard.revisions || [])].reverse(), 8, current.board?.id);
    const context = current.board ? buildDramaStoryContext(document, nodes, current.board.id) : undefined;
    const contextMode = usesDramaChapterContext(context, synopsis);
    const readyCount = drafts.filter(item => item.status === "ready" || item.status === "applied").length;
    const modelReady = Boolean(model && config.textModels.includes(model) && isAiConfigReady(config, model) && config.modelCosts.some(item => item.taskType === "text" && item.model === model));
    const charged = drafts.reduce((total, item) => total + (item.chargedCredits || 0), 0);
    const allowedShotSeconds = useMemo(() => readDramaPlanningShotSeconds(config), [config]);
    const unsupportedDraftSeconds = selectedDraft && config.videoModel ? [...new Set(selectedDraft.shots.filter(shot => !isVideoDurationSupported({ ...config, model: config.videoModel }, shot.durationSeconds)).map(shot => shot.durationSeconds))] : [];

    const storeDrafts = (next: Draft[]) => {
        draftRef.current = next;
        if (mounted.current) setDrafts(next);
        try { sessionStorage.setItem(storageKey, JSON.stringify({ drafts: next, synopsis, model })); }
        catch { if (mounted.current) setStorageNotice("浏览器暂存空间不足，草稿仍保留在当前页面；请应用需要的章节后再离开。"); }
    };
    const updateDraft = (chapterId: string, patch: Partial<Draft>) => storeDrafts(draftRef.current.map(item => item.chapterId === chapterId ? { ...item, ...patch } : item));

    useEffect(() => {
        mounted.current = true;
        try {
            const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
            if (saved && Array.isArray(saved.drafts)) {
                const restored = saved.drafts.filter((item: Draft) => typeof item.chapterId === "string" && Array.isArray(item.shots) && Array.isArray(item.assets)).map((item: Draft) => {
                    if (!Array.isArray(item.sourceAssetIds) || item.sourceAssetIds.some(id => typeof id !== "string")) return { ...item, sourceAssetIds: [], status: "failed", error: "此草稿来自旧版，缺少原素材校验信息，请重新优化本章。" } as Draft;
                    return item.status === "running" ? { ...item, status: "failed", error: "上次页面已关闭，可继续未完成章节。" } as Draft : item;
                });
                draftRef.current = restored;
                setDrafts(restored);
                setSynopsis(typeof saved.synopsis === "string" ? saved.synopsis : "");
                setModel(typeof saved.model === "string" ? saved.model : "");
            }
        } catch { setStorageNotice("暂存草稿未能读取，请重新生成。"); }
        return () => { mounted.current = false; stop.current = true; };
    }, [storageKey]);

    const show = () => {
        setOpen(true);
        if (!model || !config.textModels.includes(model)) setModel(resolveStoryboardTextModel(config, current.board?.content.model));
    };

    const generate = async (onlyChapterId?: string) => {
        if (running.current || !modelReady || !allowedShotSeconds.length) return;
        const initial = latest.current;
        const targetChapters = (initial.document.preferences.drama?.chapters || []).filter(chapter => onlyChapterId ? chapter.id === onlyChapterId : scope === "all" || chapter.id === activeId);
        const targetIds = new Set(targetChapters.map(chapter => chapter.id));
        const queue = targetChapters.map(chapter => {
            const source = readDramaChapterSource(initial.document, initial.nodes, chapter.id);
            const old = draftRef.current.find(item => item.chapterId === chapter.id);
            const pool = collectDramaAssets(initial.nodes, initial.document.preferences.drama?.assets || []);
            const sourceSignature = source.board ? createDramaStorySourceSignature(source.board, source.scriptContent, pool) : "";
            const previousSignature = source.board && old ? createDramaStorySourceSignature(source.board, source.scriptContent, pool.filter(asset => !old.sourceAssetIds || old.sourceAssetIds.includes(asset.id))) : "";
            const appliedSourceSignature = source.board && old?.appliedAssetIds ? createDramaStorySourceSignature(source.board, source.scriptContent, pool.filter(asset => old.appliedAssetIds!.includes(asset.id))) : "";
            const unchangedApplied = old?.status === "applied" && old.appliedSignature && old.appliedSignature === appliedSourceSignature;
            const durationCompatible = old?.shots.every(shot => allowedShotSeconds.includes(shot.durationSeconds));
            if (!onlyChapterId && old && durationCompatible && (unchangedApplied || (old.status === "ready" && old.sourceSignature === previousSignature))) return old;
            return { chapterId: chapter.id, boardId: chapter.storyboardNodeId, title: chapter.title, sourceSignature, sourceAssetIds: pool.map(asset => asset.id), shots: [], assets: [], model, status: "pending", previousShotCount: source.board?.storyboard.shots.length || 0 } as Draft;
        });
        storeDrafts([...draftRef.current.filter(item => !targetIds.has(item.chapterId)), ...queue]);
        running.current = true;
        stop.current = false;
        setBusy(true);
        setStopping(false);
        try {
            for (const item of queue) {
                if (stop.current) break;
                if (item.status === "ready" || item.status === "applied") continue;
                const live = latest.current;
                const source = readDramaChapterSource(live.document, live.nodes, item.chapterId);
                try {
                    if (!source.board) throw new Error("分镜节点已缺失，请先恢复本章分镜节点。");
                    if (!source.scriptContent) throw new Error("本章原文为空，请先填写剧本，避免生成无依据的剧情。");
                    if (source.scriptContent.length > 40000) throw new Error("本章超过 40000 字，请拆分章节后继续；原文未被截断。");
                    const storyContext = buildDramaPlanningContext(live.document, live.nodes, item.boardId, synopsis, draftRef.current);
                    const liveProjectAssets = collectDramaAssets(live.nodes, live.document.preferences.drama?.assets || []);
                    const sourceSignature = createDramaStorySourceSignature(source.board, source.scriptContent, liveProjectAssets);
                    updateDraft(item.chapterId, { status: "running", sourceSignature, sourceAssetIds: liveProjectAssets.map(asset => asset.id), error: undefined });
                    setSelected(item.chapterId);
                    const pool = [...new Map([...liveProjectAssets, ...draftRef.current.filter(draft => draft.status === "ready").flatMap(draft => draft.assets)].map(asset => [asset.id, asset])).values()];
                    const chapterAssetIds = new Set([...source.board.storyboard.assets.map(asset => asset.id), ...source.board.storyboard.shots.flatMap(shot => shot.assetIds)]);
                    const chapterText = [source.scriptContent, storyContext?.previousChapter, storyContext?.nextChapter].join("\n").replace(/\s+/g, "");
                    const assets = pool.length <= 300 ? pool : pool.filter(asset => chapterAssetIds.has(asset.id) || (asset.name.trim().length >= 2 && chapterText.includes(asset.name.replace(/\s+/g, ""))));
                    if (assets.length > 300) throw new Error("当前章及相邻章关联素材超过 300 个，请拆分章节后继续，角色参考未被截断。");
                    const result = await generateStoryboard({ scriptContent: source.scriptContent, model, maxShotSeconds: Math.max(...allowedShotSeconds), allowedShotSeconds, visualStyle: source.board.content.visualStyle, storyContext,
                        existingAssets: assets.map(({ id, kind, name, description }) => ({ id, kind, name, description })),
                        instruction: "请将本章原文改编为完整、可拍摄且有因果关系的短剧分镜草稿。覆盖原章开端、冲突、转折与章末结果，不提前编造后文。剔除重复对白和叙述，内心活动转化为表演或适量旁白，每镜只描述能在时长内完成的行动。对白时长按自然语速分镜。使用不同景别，每镜填写 continuity 场景、时序、转场、开场状态、结束状态与剧情节拍；同场景承接前镜动作终态，回忆与回到现在显式标注。人物及道具沿用 existingAssets 的稳定身份，保留原人物关系。按本章完整原文重新规划镜头，不照抄旧的视频提示词。",
                    });
                    if (!result.shots?.length) throw new Error("模型没有返回分镜，请重试本章。");
                    updateDraft(item.chapterId, { status: "ready", shots: result.shots, assets: result.assets || [], chargedCredits: result.chargedCredits, model });
                } catch (error) {
                    updateDraft(item.chapterId, { status: "failed", error: error instanceof Error ? error.message : "本章优化失败，可重试" });
                }
            }
        } finally {
            running.current = false;
            if (mounted.current) { setBusy(false); setStopping(false); }
        }
    };

    const apply = async () => {
        if (!selectedDraft || selectedDraft.status !== "ready" || stale || applying || busy || unsupportedDraftSeconds.length) return;
        setApplying(true);
        try {
            const { chapterId, boardId, sourceSignature, sourceAssetIds, shots, assets, model: draftModel } = selectedDraft;
            if (!Array.isArray(sourceAssetIds) || sourceAssetIds.some(id => typeof id !== "string")) throw new Error("草稿缺少原素材校验信息，请重新优化本章。");
            const beforeSource = readDramaChapterSource(latest.current.document, latest.current.nodes, chapterId);
            const existingRevisionIds = new Set(beforeSource.board?.storyboard.revisions?.map(revision => revision.id) || []);
            await latest.current.onApply({ chapterId, boardId, sourceSignature, sourceAssetIds, shots, assets, model: draftModel });
            const live = latest.current;
            const appliedSource = readDramaChapterSource(live.document, live.nodes, chapterId);
            const appliedPool = collectDramaAssets(live.nodes, live.document.preferences.drama?.assets || []);
            // Only remember a post-apply signature after the saved revision is visible; an old render must not become the baseline.
            const appliedVisible = appliedSource.board?.storyboard.revisions?.some(revision => !existingRevisionIds.has(revision.id));
            updateDraft(chapterId, { status: "applied", appliedAssetIds: appliedVisible ? appliedPool.map(asset => asset.id) : undefined,
                appliedSignature: appliedVisible && appliedSource.board ? createDramaStorySourceSignature(appliedSource.board, appliedSource.scriptContent, appliedPool) : undefined });
            message.success("已应用分镜，旧分镜和素材已存入版本历史；请为新分镜生成图片和视频。");
        } catch (error) { message.error(error instanceof Error ? error.message : "应用失败"); }
        finally { setApplying(false); }
    };

    return <>
        <Button size="small" icon={<Sparkles size={14} />} onClick={show}>优化剧情分镜</Button>
        <Modal className={styles.modal} centered title={<div className={styles.modalHeader}>
            <span className={styles.titleIcon}><Sparkles size={20} /></span>
            <div className={styles.titleCopy}><span className={styles.modalTitle}>剧情与镜头优化</span><p>从完整原章出发，让每个镜头都有因果与承接</p></div>
            {onRestore && <Button className={styles.historyButton} icon={<History size={14} />} disabled={!current.board?.storyboard.revisions?.length || busy || applying} onClick={() => setHistoryOpen(true)}>本章历史</Button>}
        </div>} open={open} onCancel={() => setOpen(false)} footer={null} width={1160}>
            <div className={styles.body}>
                <div className={styles.setup}>
                <div className={styles.controls}>
                    <label className={styles.field}><span>优化范围</span><Select aria-label="优化范围" value={scope} disabled={busy} onChange={setScope} options={[{ value: "current", label: `当前章节 · ${current.chapter?.title || "未选择"}` }, { value: "all", label: `全部 ${chapters.length} 章` }]} /></label>
                    <div aria-label="剧情规划模型" className={styles.field}><span>文本模型</span><div className={busy ? styles.locked : undefined}><ModelPicker className={styles.modelPicker} config={config} value={model} capability="text" fullWidth onChange={setModel} onMissingConfig={() => message.info("请在模型设置中启用文本模型并配置积分价格")} /></div></div>
                    <Button className={styles.primaryButton} type="primary" icon={<Sparkles size={15} />} disabled={!modelReady || !allowedShotSeconds.length || busy || applying || !chapters.length} onClick={() => void generate()}>{drafts.some(item => item.status === "pending" || item.status === "failed") ? "继续未完成章节" : "生成优化草稿"}</Button>
                </div>
                <div className={styles.settingsMeta}>
                    <span title={modelOptionLabel(config, config.videoModel)}><Clock3 size={13} />{allowedShotSeconds.length ? `单镜 ${dramaPlanningShotSecondsLabel(allowedShotSeconds)}` : "请配置默认视频模型"}</span>
                    <span><Coins size={13} />{charged > 0 ? `草稿用量 ${Number(charged.toFixed(2))} 积分` : "按文本实际用量计费"}</span>
                    {contextMode && <span className={styles.contextBadge}><BookOpen size={13} />使用分章上下文</span>}
                    <details className={styles.help}><summary><Info size={13} />生成说明<ChevronDown size={12} /></summary><div>
                        <p>{allowedShotSeconds.length ? `按默认视频模型「${modelOptionLabel(config, config.videoModel)}」支持的短镜头编排：${dramaPlanningShotSecondsLabel(allowedShotSeconds)}。` : "请先配置默认视频模型，以确定可生成的镜头时长。"}按文本模型实际用量计费。全章任务依次生成，可停止后续章节；已完成草稿保留在当前浏览器标签页。</p>
                        {contextMode && <p>每次提交本章与前后章的完整原文，并附全剧目录、已知剧情节拍和梗概。可补充主线、伏笔和结局，帮助对齐尚未整理的章节。</p>}
                    </div></details>
                </div>
                <details className={styles.context}><summary><BookOpen size={14} /><strong>全剧梗概</strong><span>可选 · 补充主线、伏笔与结局</span><ChevronDown size={14} /></summary><div><Input.TextArea aria-label="全剧梗概" value={synopsis} disabled={busy} maxLength={20000} showCount autoSize={{ minRows: 3, maxRows: 5 }} placeholder="保留主角目标、关键因果、重要伏笔、时序和最终结局。原章节正文仍完整提交。" onChange={event => setSynopsis(event.target.value)} /></div></details>
                </div>
                {storageNotice && <Alert type="warning" showIcon title={storageNotice} />}
                {busy && <div className={styles.runProgress} role="status"><div><span>{stopping ? "本章完成后停止" : `正在优化：${drafts.find(item => item.status === "running")?.title || "准备中"}`}</span><Button size="small" disabled={stopping} onClick={() => { stop.current = true; setStopping(true); }}>停止后续章节</Button></div><Progress percent={drafts.length ? Math.round(readyCount / drafts.length * 100) : 0} showInfo={false} size="small" /><small>已完成 {readyCount} / {drafts.length} 章。当前请求完成后将保存结果。</small></div>}
                {drafts.length ? <div className={styles.review}>
                    <aside className={styles.chapterList} aria-label="优化草稿章节">
                        <div className={styles.sidebarHeading}><span>章节草稿</span><span>{drafts.length}</span></div>
                        <div className={styles.chapterItems}>{chapterPage.items.map(item => <button type="button" key={item.chapterId} aria-pressed={selectedDraft?.chapterId === item.chapterId} onClick={() => setSelected(item.chapterId)}><strong><BookOpen size={14} />{item.title}</strong><span className={styles.chapterStatus} data-status={item.status}><i />{({ pending: "等待生成", running: "生成中", ready: "待预览应用", failed: "可重试", applied: "已应用" })[item.status]}{item.status === "ready" ? ` · ${item.shots.length} 镜头` : ""}</span></button>)}</div>
                        <ListPagination className={styles.chapterPagination} compact current={chapterPage.page} pageSize={chapterPage.pageSize} total={chapterPage.total} onChange={chapterPage.onChange} label="优化章节分页" />
                    </aside>
                    <section className={styles.preview} aria-label="分镜草稿预览">
                        {selectedDraft && <><header className={styles.previewHeader}><div className={styles.previewHeading}><h3>{selectedDraft.title}<span>分镜预览</span></h3><p>{selectedDraft.previousShotCount} 个原镜头 <ArrowRight size={12} /><strong>{selectedDraft.shots.length}</strong> 个草稿镜头</p></div><div className={styles.actions}>{!busy && <Button icon={<RotateCcw size={13} />} disabled={!modelReady || !allowedShotSeconds.length || applying} onClick={() => void generate(selectedDraft.chapterId)}>{selectedDraft.status === "applied" ? "再次优化本章" : "重新优化本章"}</Button>}<Button className={styles.primaryButton} type="primary" icon={<Check size={15} />} loading={applying} disabled={busy || stale || unsupportedDraftSeconds.length > 0 || selectedDraft.status !== "ready" || issues.some(issue => issue.severity === "error")} onClick={() => void apply()}>{selectedDraft.status === "applied" ? "已应用" : "应用本章草稿"}</Button></div></header>
                        <div className={styles.previewScroll} key={`${selectedDraft.chapterId}:${shotsPage.page}`}>
                        {selectedDraft.error && <Alert showIcon type="error" title={selectedDraft.error} />}
                        {stale && <Alert showIcon type="warning" title="原章或素材已变化" description="为保护当前编辑，旧草稿不可应用，请重新优化本章。" />}
                        {changedAfterApply && <Alert showIcon type="info" title="本章应用后已有更新" description="再次执行当前章或全章优化时，会重新核对本章；未修改的已应用章节会跳过。" />}
                        {unsupportedDraftSeconds.length > 0 && <Alert showIcon type="warning" title="草稿镜长与默认视频模型不匹配" description={`当前模型不支持 ${unsupportedDraftSeconds.join(" / ")} 秒，请重新优化本章；将按 ${dramaPlanningShotSecondsLabel(allowedShotSeconds)} 编排。`} />}
                        {issues.length > 0 && <div className={styles.quality}><strong>草稿复核 · {issues.length} 项</strong><ul>{issues.slice(0, 5).map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>{issues.length > 5 && <small>其余 {issues.length - 5} 项可应用后在全剧检查中查看。</small>}</div>}
                        {selectedDraft.status === "applied" && <Alert showIcon type="success" title="新分镜已应用" description="旧分镜、图片和视频已存档。新镜头需重新生成媒体后，才能作为当前成片素材。" />}
                        {selectedDraft.shots.length ? <ol className={styles.shotList}>{shotsPage.items.map((shot, index) => <li key={`${shot.id}:${index}`}>
                            <div className={styles.shotMeta}><span className={styles.shotNumber}>{String(shot.shotNumber).padStart(2, "0")}</span><strong>镜头 {shot.shotNumber}</strong><span className={styles.shotSize}>{shot.shotSize}</span><span className={styles.duration}><Clock3 size={12} />{shot.durationSeconds}s</span>{shot.continuity && <span className={styles.transition}>{transitions[shot.continuity.transition] || shot.continuity.transition}</span>}</div>
                            <p className={styles.visualDescription}>{shot.visualDescription}</p>
                            {shot.continuity && <div className={styles.continuity}><dl className={styles.storyFacts}><dt>剧情</dt><dd>{shot.continuity.storyBeat}</dd><dt>场景</dt><dd>{shot.continuity.sceneId} · {shot.continuity.time}</dd></dl><dl className={styles.stateFlow}><dt>起始</dt><dd>{shot.continuity.openingState}</dd><dt>结束</dt><dd>{shot.continuity.closingState}</dd></dl></div>}
                            {shot.dialogueVoiceover && <div className={styles.dialogue}><MessageSquare size={14} /><div><span>对白 / 旁白</span><p>{shot.dialogueVoiceover}</p></div></div>}
                        </li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedDraft.status === "running" ? "正在梳理剧情和分镜…" : "尚无可预览草稿"} />}
                        </div>
                        {selectedDraft.shots.length > 0 && <ListPagination className={styles.shotPagination} compact current={shotsPage.page} pageSize={shotsPage.pageSize} total={shotsPage.total} onChange={shotsPage.onChange} label="优化镜头分页" />}
                        </>}
                    </section>
                </div> : <div className={styles.emptyState}><span className={styles.emptyIcon}><Clapperboard size={28} /></span><h3>让故事连成镜头</h3><p>选择章节与模型，生成后在这里核对剧情、动作与转场。</p><div><span>01 整理原章</span><ArrowRight size={14} /><span>02 预览分镜</span><ArrowRight size={14} /><span>03 应用草稿</span></div></div>}
                <footer className={styles.footer}><ShieldCheck size={14} /><p>应用时保留原章文字，旧分镜与媒体自动存档。图片和视频需在应用后单独生成。</p><span>先预览，再应用</span></footer>
            </div>
        </Modal>
        <Modal title={`${current.chapter?.title || "本章"} · 分镜历史`} open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={660}>
            <div className={styles.history}><p>恢复会把当前分镜再次存档，保留可回退版本。</p>{historyPage.items.map(revision => <div key={revision.id}><span><strong>{new Date(revision.createdAt).toLocaleString()}</strong><small>{revision.shots.length} 镜头 · {revision.shots.filter(shot => shot.video?.source).length} 视频 · {revision.assets.length} 素材</small></span><Button size="small" disabled={applying || busy} onClick={() => modal.confirm({ title: "恢复此版分镜？", content: "当前分镜将自动存档，当前运行中的生成任务需要先结束。", okText: "恢复分镜", cancelText: "取消", onOk: async () => { if (!current.board || !onRestore) return; setApplying(true); try { await onRestore(current.board.id, revision.id); message.success("已恢复历史分镜"); setHistoryOpen(false); } finally { setApplying(false); } } })}>恢复此版</Button></div>)}<ListPagination compact current={historyPage.page} pageSize={historyPage.pageSize} total={historyPage.total} onChange={historyPage.onChange} label="分镜历史分页" /></div>
        </Modal>
    </>;
}
