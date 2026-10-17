"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Checkbox, Dropdown, Empty, Input, InputNumber, Modal, Progress, Select, Tabs, Tag } from "antd";
import { ArrowUpRight, BookOpen, Clapperboard, Clock3, FolderOpen, Grid2X2, ImageOff, ImagePlus, Layers3, ListChecks, MoreHorizontal, Play, Search, Sparkles, LayoutGrid } from "lucide-react";
import type { CanvasDocument, CanvasDramaProject, CanvasNode, CanvasStoryboardAsset, CanvasStoryboardNode, CanvasStoryboardShot } from "@/features/canvas/types";
import { collectDramaAssets } from "../drama-workspace";
import { shotImageBatchSummary } from "../shot-image-batch";
import { readDramaShotSelection, updateDramaShotSelection, type DramaShotSelection } from "../drama-shot-selection";
import { readDramaShotVideoFeedback } from "../drama-shot-video-feedback";
import { dramaShotImageTaskLabel, failedDramaShotImageIds, isDramaShotImageActive, missingDramaShotImageIds } from "./drama-shot-image-controls";
import { usePaginatedList } from "@/shared/hooks/use-paginated-list";
import { ListPagination } from "@/shared/components/list-pagination";
import styles from "./drama-workspace.module.css";
import { DramaContinuityPanel } from "./drama-continuity-panel";
import type { DramaAssemblyState } from "../drama-assembly";
import type { DramaStoryOptimizerApplyRequest } from "./drama-story-optimizer";
import { DramaChapterAssembly, type ChapterAssemblyActions } from "./drama-chapter-assembly";

type Props = ChapterAssemblyActions & {
    document: CanvasDocument;
    nodes: CanvasNode[];
    busy: boolean;
    duplicateVideoCount?: number;
    onCleanupDuplicateVideos?: () => void;
    focusShot?: { boardId: string; shotId: string } | null;
    onUpgrade: () => Promise<void>;
    onView: (view: CanvasDramaProject["view"]) => void;
    onChapter: (id: string) => void;
    onStoryboard: (id: string, updater: (value: CanvasStoryboardNode["storyboard"]) => CanvasStoryboardNode["storyboard"]) => void;
    onScript: (id: string, text: string) => void;
    onDetails: (id: string) => void;
    onVideo: (id: string, shotIds?: string[]) => void;
    onRewritePrompt: (boardId: string, shotId: string) => Promise<void>;
    rewritingShotIds: ReadonlySet<string>;
    onImages: (id: string, shotIds: string[]) => void;
    onExpand: (id: string, shotIds: string[]) => void;
    onArrangeCanvas: () => void;
    retiredNodeCount: number;
    cleaningRetiredNodes: boolean;
    onCleanupRetiredNodes: () => Promise<void>;
    onLocateCanvasShot: (boardId: string, shotId: string) => void;
    onAsset: (asset: CanvasStoryboardAsset, scope: "project" | "chapter") => void;
    onAgent: (prompt: string) => void;
    onAssembly: (state: DramaAssemblyState) => Promise<void>;
    onOptimizeApply: (request: DramaStoryOptimizerApplyRequest) => Promise<void>;
    onOptimizeRestore?: (boardId: string, revisionId: string) => Promise<void>;
};

export function DramaWorkspace(props: Props) {
    const { document, nodes } = props;
    const busy = props.busy || nodes.some(node => node.kind === "storyboard" && node.storyboard.shotImageGeneration?.phase === "running");
    const drama = document.preferences.drama;
    const { message } = App.useApp();
    const [upgrading, setUpgrading] = useState(false);
    const [nav, setNav] = useState("chapters");
    const [search, setSearch] = useState("");
    const [kind, setKind] = useState("all");
    const [shotFilter, setShotFilter] = useState("all");
    const [selectedShot, setSelectedShot] = useState<string | null>(null);
    const [batchSelection, setBatchSelection] = useState<DramaShotSelection | null>(null);
    const [editingAsset, setEditingAsset] = useState<CanvasStoryboardAsset | null>(null);
    const [assetScope, setAssetScope] = useState<"project" | "chapter">("project");
    const [previewVideo, setPreviewVideo] = useState<string | null>(null);
    const [scriptOpen, setScriptOpen] = useState(false);
    const [navExpanded, setNavExpanded] = useState(false);
    const [canvasToolsOpen, setCanvasToolsOpen] = useState(false);
    const appliedShotFocusRef = useRef<Props["focusShot"]>(undefined);
    const boards = useMemo(() => new Map(nodes.filter((n): n is CanvasStoryboardNode => n.kind === "storyboard").map(n => [n.id, n])), [nodes]);
    const active = drama?.chapters.find(c => c.id === drama.activeChapterId);
    const board = active ? boards.get(active.storyboardNodeId) : undefined;
    const expandedShotIds = new Set(nodes.filter(node => node.dramaStoryboardId === board?.id).map(node => node.dramaShotId));
    const canvasShots = board?.storyboard.shots.filter(shot => expandedShotIds.has(shot.id)) || [];
    const script = nodes.find(n => n.id === active?.scriptNodeId);
    const pool = useMemo(() => collectDramaAssets(nodes, drama?.assets), [nodes, drama?.assets]);
    const filteredAssets = pool.filter(a => (kind === "all" || a.kind === kind) && [a.name, a.description].join(" ").toLowerCase().includes(search.toLowerCase()));
    const assetPage = usePaginatedList(filteredAssets, 12, search + kind);
    const chapters = (drama?.chapters || []).filter(c => nav !== "chapters" || c.title.includes(search));
    const chapterPage = usePaginatedList(chapters, 12, search);
    const shots = (board?.storyboard.shots || []).filter(s => shotFilter === "image" ? !s.image?.source : shotFilter === "video" ? !s.video?.source : true);
    const shotPage = usePaginatedList(shots, 12, `${board?.id}:${shotFilter}`);
    const shot = board?.storyboard.shots.find(s => s.id === selectedShot);
    const videoFeedback = useMemo(() => new Map((board?.storyboard.shots || []).map(item => [item.id, readDramaShotVideoFeedback(nodes, board!.id, item)])), [board, nodes]);
    const selectedVideoFeedback = shot ? videoFeedback.get(shot.id) : undefined;
    const imageBatch = board?.storyboard.shotImageGeneration;
    const imageBatchSummary = shotImageBatchSummary(imageBatch);
    const missingImageIds = missingDramaShotImageIds(board?.storyboard.shots || [], imageBatch?.tasks);
    const failedImageIds = failedDramaShotImageIds(board?.storyboard.shots || [], imageBatch?.tasks);
    const selectedIds = readDramaShotSelection(board?.id, board?.storyboard.shots || [], batchSelection);
    const selectedIdsSet = new Set(selectedIds);
    const selectedImageIds = selectedIds.filter(id => !isDramaShotImageActive(imageBatch?.tasks[id]));
    const selectedOnPage = shotPage.items.filter(s => selectedIdsSet.has(s.id)).length;
    const allPageSelected = shotPage.items.length > 0 && selectedOnPage === shotPage.items.length;
    const allFilteredSelected = shots.length > 0 && shots.every(s => selectedIdsSet.has(s.id));
    const toggleShots = (ids: string[], checked: boolean) => {
        if (!board) return;
        setBatchSelection(previous => updateDramaShotSelection(board.id, board.storyboard.shots, previous, ids, checked));
    };
    const openChapter = (id: string) => { props.onChapter(id); setNavExpanded(false); };
    useEffect(() => { setSelectedShot(null); setScriptOpen(false); setShotFilter("all"); setBatchSelection(null); }, [document.identity.id, active?.id, board?.id]);
    useEffect(() => {
        const target = props.focusShot;
        if (!target || target === appliedShotFocusRef.current || board?.id !== target.boardId) return;
        if (shotFilter !== "all") { setShotFilter("all"); return; }
        const index = board.storyboard.shots.findIndex(shot => shot.id === target.shotId);
        if (index < 0) return;
        shotPage.onChange(Math.floor(index / shotPage.pageSize) + 1, shotPage.pageSize);
        setSelectedShot(target.shotId);
        setNavExpanded(false);
        appliedShotFocusRef.current = target;
    }, [props.focusShot, board, shotFilter, shotPage.onChange, shotPage.pageSize]);
    const changeShot = (patch: Partial<CanvasStoryboardShot>) => {
        if (!board || !shot) return;
        props.onStoryboard(board.id, value => ({ ...value, shots: value.shots.map(s => s.id === shot.id ? { ...s, ...patch } : s) }));
    };

    if (!drama) return <div className={styles.upgrade} data-canvas-no-zoom>
        <BookOpen size={18} /><div><strong>升级为章节工作台</strong><p>共享素材去重，按章编辑；升级前自动保存完整备份。</p></div>
        <Button type="primary" loading={upgrading} disabled={busy} onClick={async () => {
            setUpgrading(true);
            try { await props.onUpgrade(); message.success("章节工作台已就绪，原工程已备份"); }
            catch (error) { message.error(error instanceof Error ? error.message : "升级失败"); }
            finally { setUpgrading(false); }
        }}>升级布局</Button>
    </div>;

    return <div className={styles.workspace} data-drama-view={drama.view} data-canvas-no-zoom onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
        <aside aria-label="章节与素材导航" className={`${styles.sidebar} ${navExpanded ? styles.sidebarExpanded : styles.sidebarCollapsed}`}>
            <header><span><BookOpen size={16} />短剧工作台</span><Tag>{drama.chapters.length} 章</Tag><button type="button" className={styles.mobileNavToggle} aria-expanded={navExpanded} aria-controls="drama-sidebar-content" onClick={() => setNavExpanded(value => !value)}>{navExpanded ? "收起导航" : "展开导航"}</button></header>
            <div id="drama-sidebar-content" className={styles.sidebarContent}>
            <Tabs activeKey={nav} onChange={value => { setNav(value); setSearch(""); }} items={[
                { key: "chapters", label: "章节" }, { key: "assets", label: `项目素材 ${pool.length}` },
            ]} />
            <Input prefix={<Search size={14} />} allowClear placeholder={nav === "chapters" ? "搜索章节" : "搜索角色、场景、道具"} value={search} onChange={e => setSearch(e.target.value)} />
            {nav === "chapters" ? <>
                <button className={styles.overviewLink} onClick={() => props.onView("overview")}><Grid2X2 size={14} />全剧总览</button>
                <div className={styles.navList}>{chapterPage.items.map(chapter => {
                    const items = boards.get(chapter.storyboardNodeId)?.storyboard.shots || [];
                    return <button key={chapter.id} aria-label={`打开章节 ${chapter.title}`} aria-pressed={chapter.id === active?.id} className={styles.chapter} onClick={() => openChapter(chapter.id)}>
                        <span className={styles.chapterIcon}><Clapperboard size={16} /></span><span><strong>{chapter.title}</strong><small>{items.length} 镜头 · {items.filter(s => s.video?.source).length} 视频</small></span>
                    </button>;
                })}</div>
                <ListPagination compact current={chapterPage.page} pageSize={chapterPage.pageSize} total={chapterPage.total} onChange={chapterPage.onChange} label="章节分页" />
            </> : <>
                <Select aria-label="素材分类" value={kind} onChange={setKind} options={[{ value: "all", label: "全部素材" }, { value: "character", label: "角色" }, { value: "scene", label: "场景" }, { value: "prop", label: "道具" }]} />
                <div className={styles.navList}>{assetPage.items.map(asset => <button key={asset.id} className={styles.asset} onClick={() => { setEditingAsset({ ...asset }); setAssetScope("project"); }}>
                    {asset.image?.source ? <img src={asset.image.source} loading="lazy" alt="" /> : <ImageOff size={22} />}
                    <span><strong>{asset.name}</strong><small>{asset.kind === "character" ? "角色" : asset.kind === "scene" ? "场景" : "道具"} · {drama.chapters.filter(c => boards.get(c.storyboardNodeId)?.storyboard.shots.some(s => s.assetIds.includes(asset.id))).length} 章引用{pool.filter(a => a.name === asset.name && a.kind === asset.kind).length > 1 ? ` · 版本 ${pool.filter(a => a.name === asset.name && a.kind === asset.kind).findIndex(a => a.id === asset.id) + 1}` : ""}</small></span>
                </button>)}</div>
                <ListPagination compact current={assetPage.page} pageSize={assetPage.pageSize} total={assetPage.total} onChange={assetPage.onChange} label="项目素材分页" />
            </>}
            </div>
        </aside>

        <section className={`${styles.main} ${drama.view === "canvas" ? styles.canvasMode : ""}`}>
            <header className={styles.toolbar} data-drama-canvas-toolbar={drama.view === "canvas" || undefined}>
                <div><strong>{drama.view === "overview" ? "全剧总览" : active?.title || "选择章节"}</strong><small>{drama.view === "overview" ? `${pool.length} 个独立素材 · ${[...boards.values()].reduce((sum, n) => sum + n.storyboard.shots.length, 0)} 个镜头` : `${board?.storyboard.shots.length || 0} 个镜头 · 修改自动保存`}</small></div>
                <div className={styles.actions}>
                    {active && <DramaChapterAssembly key={`${document.identity.id}:${active.id}`} document={document} nodes={nodes} chapterId={active.id} onReadChapterPlan={props.onReadChapterPlan} onChapterAssembly={props.onChapterAssembly} onPrepareMedia={props.onPrepareMedia} onLocateAssembly={props.onLocateAssembly} />}
                    {drama.view === "canvas" && <Button size="small" type="text" aria-expanded={canvasToolsOpen} onClick={() => setCanvasToolsOpen(value => !value)}>全剧工具</Button>}
                    <Button size="small" type={drama.view === "shots" ? "primary" : "default"} disabled={!active} onClick={() => props.onView("shots")}>镜头工作台</Button>
                    <Button size="small" type={drama.view === "canvas" ? "primary" : "default"} disabled={!active} onClick={() => props.onView("canvas")}>章节画布</Button>
                </div>
            </header>
            {drama.view === "canvas" && <div className={styles.canvasControls} data-drama-canvas-toolbar>
                <span className={styles.canvasFlow}><span>提示词</span><span aria-hidden="true">→</span><span>图片</span><span aria-hidden="true">→</span><span>视频</span></span>
                <div className={styles.actions}>
                    <Select<string> aria-label="定位画布镜头" placeholder="定位镜头" value={undefined} disabled={!canvasShots.length} popupMatchSelectWidth={160} onChange={shotId => board && props.onLocateCanvasShot(board.id, shotId)} options={canvasShots.map(shot => ({ value: shot.id, label: `镜头 ${String(shot.shotNumber).padStart(2, "0")}` }))} />
                    {props.retiredNodeCount > 0 && <Button size="small" loading={props.cleaningRetiredNodes} disabled={busy} title="先保存历史版本，再移除旧版镜头及其独立合成流程；可从历史版本恢复" onClick={() => void props.onCleanupRetiredNodes()}>清理旧版（{props.retiredNodeCount}）</Button>}
                    <Button size="small" icon={<LayoutGrid size={14} />} disabled={!active} onClick={props.onArrangeCanvas}>整理布局</Button>
                </div>
            </div>}
            {(drama.view !== "canvas" || canvasToolsOpen) && <DramaContinuityPanel key={document.identity.id} document={document} nodes={nodes} onChapter={props.onChapter} onAgent={props.onAgent} onAssembly={props.onAssembly} onPrepareMedia={props.onPrepareMedia} onOptimizeApply={props.onOptimizeApply} onOptimizeRestore={props.onOptimizeRestore} duplicateVideoCount={props.duplicateVideoCount} onCleanupDuplicateVideos={props.onCleanupDuplicateVideos} />}
            {drama.view === "overview" ? <div className={styles.content}>
                <div className={styles.grid}>{chapterPage.items.map(chapter => {
                    const items = boards.get(chapter.storyboardNodeId)?.storyboard.shots || [];
                    const cover = items.find(s => s.image?.source)?.image?.source;
                    return <button key={chapter.id} className={styles.card} onClick={() => openChapter(chapter.id)}>
                        <div className={styles.media}>{cover ? <img src={cover} alt="" loading="lazy" /> : <Clapperboard size={28} />}</div>
                        <div className={styles.cardBody}><strong>{chapter.title}</strong><small>{items.length} 镜头 · 图片 {items.filter(s => s.image?.source).length} · 视频 {items.filter(s => s.video?.source).length}</small></div>
                    </button>;
                })}</div>
                <ListPagination current={chapterPage.page} pageSize={chapterPage.pageSize} total={chapterPage.total} onChange={chapterPage.onChange} label="全剧总览分页" />
            </div> : drama.view === "shots" ? <div className={`${styles.content} ${styles.shotContent}`}>
                {board ? <>
                    <div className={styles.shotWorkspaceTools}>
                    <div className={styles.shotActions}>
                        <Select aria-label="镜头筛选" value={shotFilter} onChange={setShotFilter} options={[{ value: "all", label: "全部镜头" }, { value: "image", label: "缺少图片" }, { value: "video", label: "缺少视频" }]} />
                        <Button size="small" icon={<BookOpen size={14} />} disabled={!script} onClick={() => setScriptOpen(true)}>本章剧本</Button>
                        <Button size="small" disabled={!missingImageIds.length} onClick={() => props.onImages(board.id, missingImageIds)}>补齐本章图片</Button>
                        <Button size="small" type="primary" disabled={busy} onClick={() => props.onVideo(board.id)}>生成本章视频</Button>
                        <Dropdown trigger={["click"]} menu={{ items: [
                            { key: "edit", label: "详细编辑", onClick: () => props.onDetails(board.id) },
                            { key: "expand", label: "展开本页到画布", onClick: () => props.onExpand(board.id, shotPage.items.map(s => s.id)) },
                            { key: "check", label: "助手检查本章", icon: <Sparkles size={14} />, onClick: () => props.onAgent(`请检查当前章节「${active?.title}」的分镜、参考素材与图片视频缺失情况，先给出修改计划及执行范围。`) },
                        ] }}><Button size="small" icon={<MoreHorizontal size={15} />}>更多操作</Button></Dropdown>
                    </div>
                    {imageBatch ? <div className={styles.batchProgress} role="status" aria-live="polite">
                        <span>图片生成：{imageBatchSummary.finished}/{imageBatchSummary.total} 已完成 · 成功 {imageBatchSummary.succeeded} · 失败 {imageBatchSummary.failedIds.length} · 处理中 {imageBatchSummary.running} · 排队 {imageBatchSummary.queued}</span>
                        <Progress percent={imageBatchSummary.progress} status={imageBatch.phase === "running" ? "active" : imageBatchSummary.failedIds.length ? "exception" : "success"} size="small" />
                        {failedImageIds.length ? <Button size="small" onClick={() => props.onImages(board.id, failedImageIds)}>仅重试 {failedImageIds.length} 个失败镜头</Button> : null}
                    </div> : null}
                    <div className={styles.selectionBar} data-has-selection={selectedIds.length > 0} aria-label="镜头批量操作">
                        <div className={styles.selectionTools}>
                            <span className={styles.selectionIcon} aria-hidden="true"><ListChecks size={17} /></span>
                            <Checkbox checked={allPageSelected} indeterminate={selectedOnPage > 0 && !allPageSelected} disabled={!shotPage.items.length} onChange={event => toggleShots(shotPage.items.map(s => s.id), event.target.checked)}>全选本页</Checkbox>
                            <Button size="small" type="text" disabled={!shots.length || allFilteredSelected} onClick={() => toggleShots(shots.map(s => s.id), true)}>{shotFilter === "all" ? "全选本章" : "全选筛选结果"}（{shots.length}）</Button>
                            {selectedIds.length > 0 && <Button size="small" type="text" onClick={() => setBatchSelection(null)}>清空选择</Button>}
                        </div>
                        {selectedIds.length > 0 ? <div className={styles.selectionActions}>
                            <span className={styles.selectionCount} role="status">已选 <strong>{selectedIds.length}</strong> 个镜头{selectedIds.length > selectedOnPage && <small>含其他页或筛选外 {selectedIds.length - selectedOnPage} 个</small>}</span>
                            <Button size="small" icon={<ImagePlus size={14} />} disabled={!selectedImageIds.length} title={selectedImageIds.length < selectedIds.length ? "已自动跳过正在排队或生成图片的镜头" : "生成所选镜头图片，已有图片将重新生成"} onClick={() => props.onImages(board.id, selectedImageIds)}>生成所选图片（{selectedImageIds.length}）</Button>
                            <Button size="small" type="primary" icon={<Clapperboard size={14} />} disabled={busy} onClick={() => props.onVideo(board.id, selectedIds)}>生成所选视频（{selectedIds.length}）</Button>
                        </div> : <span className={styles.selectionHint}><span>{shots.length} 个镜头</span>勾选后批量生成</span>}
                    </div>
                    </div>
                    <div className={styles.shotScroll} role="region" aria-label="章节镜头列表" tabIndex={0}>
                    <div className={styles.shotGrid}>{shotPage.items.map(s => {
                        const videoState = videoFeedback.get(s.id)!;
                        return <article key={s.id} className={`${styles.card} ${styles.shotCard} ${selectedIdsSet.has(s.id) ? styles.cardSelected : ""}`}>
                        <Checkbox className={styles.shotCheckbox} aria-label={`选择镜头 ${s.shotNumber}`} checked={selectedIdsSet.has(s.id)} onChange={event => toggleShots([s.id], event.target.checked)} />
                        <button type="button" aria-label={`编辑镜头 ${s.shotNumber}`} className={styles.cardContent} onClick={() => setSelectedShot(s.id)}>
                        <div className={styles.shotHeader}><strong>镜头 <span>{String(s.shotNumber).padStart(2, "0")}</span></strong><span className={styles.shotDuration}><Clock3 size={12} />{s.durationSeconds}s</span></div>
                        <div className={styles.shotMedia} data-empty={!s.image?.source}>
                            {s.image?.source ? <img src={s.image.source} loading="lazy" alt={`镜头 ${s.shotNumber}`} /> : <div className={styles.shotPlaceholder}>
                                <span className={styles.placeholderFrame} aria-hidden="true"><ImagePlus size={24} strokeWidth={1.4} /></span>
                                <span>{isDramaShotImageActive(imageBatch?.tasks[s.id]) ? "正在准备画面" : "待生成画面"}</span>
                            </div>}
                            {s.shotSize && <span className={styles.shotSizeBadge}>{s.shotSize}</span>}
                            <span className={styles.openShotHint} aria-hidden="true"><ArrowUpRight size={15} /></span>
                        </div>
                        <div className={styles.shotDetails}>
                            <p className={styles.shotDescription}>{s.visualDescription || "待填写画面描述"}</p>
                            <div className={styles.shotFooter}><span className={styles.referenceCount}><Layers3 size={12} />{s.assetIds.length} 个素材</span><span className={styles.shotVideoStatus} data-state={videoState.state}>{videoState.state === "ready" ? <Play size={11} /> : <span className={styles.statusDot} />}{videoState.label}</span></div>
                            {videoState.error ? <div className={`${styles.shotTaskError} ${styles.shotVideoError}`} title={videoState.error}><span>视频未完成：{videoState.error}</span><small>点击查看原因与生成条件</small></div> : null}
                            {isDramaShotImageActive(imageBatch?.tasks[s.id]) ? <div className={styles.shotTaskStatus}><span />{dramaShotImageTaskLabel(imageBatch?.tasks[s.id])}</div> : null}
                            {imageBatch?.tasks[s.id]?.status === "failed" ? <div className={styles.shotTaskError} title={imageBatch.tasks[s.id].error}>生图失败：{imageBatch.tasks[s.id].error}</div> : null}
                        </div>
                    </button>
                        {(s.videoPrompt ?? s.finalPrompt).trim() ? <div className={styles.shotRewriteActions}>
                            <span>改写后可撤销</span>
                            <Button size="small" className={styles.rewritePromptButton} icon={<Sparkles size={12} />} loading={props.rewritingShotIds.has(`${board.id}:${s.id}`)} disabled={videoState.state === "queued" || videoState.state === "running"} title={videoState.state === "queued" || videoState.state === "running" ? "请等待当前视频任务结束后再改写" : "结合当前镜头与失败原因改写视频提示词，不自动生成视频"} aria-label={`一键改写镜头 ${s.shotNumber} 提示词`} onClick={() => void props.onRewritePrompt(board.id, s.id)}>一键改写提示词</Button>
                        </div> : null}
                    </article>;
                    })}</div>
                    {!shots.length ? <Empty description="没有符合条件的镜头" /> : null}
                    <ListPagination current={shotPage.page} pageSize={shotPage.pageSize} total={shotPage.total} onChange={shotPage.onChange} label="镜头分页" />
                    </div>
                </> : <Empty description="当前章节的分镜节点已删除，可在章节画布中继续编辑" />}
            </div> : null}
        </section>

        <Modal open={Boolean(shot)} title={shot ? `${active?.title} · 镜头 ${shot.shotNumber}` : "镜头"} onCancel={() => setSelectedShot(null)} footer={null} width={1020} destroyOnHidden>
            {shot && board ? <div className={styles.inspector}>
                <div className={styles.inspectorPreview}>
                    {shot.image?.source ? <img src={shot.image.source} alt="镜头参考图" /> : <Empty description="该镜头尚无图片" />}
                    <div className={styles.actions}><Button disabled={isDramaShotImageActive(imageBatch?.tasks[shot.id])} onClick={() => props.onImages(board.id, [shot.id])}>{shot.image?.source ? "重新生成图片" : "生成图片"}</Button>{shot.video?.source ? <Button icon={<Play size={14} />} onClick={() => setPreviewVideo(shot.video!.source)}>播放视频</Button> : <Tag color={selectedVideoFeedback?.state === "failed" ? "error" : selectedVideoFeedback?.state === "idle" ? undefined : "processing"}>{selectedVideoFeedback?.label}</Tag>}</div>
                    {selectedVideoFeedback?.error ? <div className={styles.videoFeedback} data-state="failed" role="status">
                        <strong>视频未完成</strong><p>{selectedVideoFeedback.error}</p>
                        <Button size="small" onClick={() => { setSelectedShot(null); props.onVideo(board.id, [shot.id]); }}>检查生成条件</Button>
                    </div> : selectedVideoFeedback?.state === "queued" || selectedVideoFeedback?.state === "running" ? <div className={styles.videoFeedback} role="status" aria-live="polite">
                        <strong>{selectedVideoFeedback.label}</strong><p>{selectedVideoFeedback.state === "queued" ? "正在准备参考图或等待前镜衔接，完成后会继续生成。" : "视频正在生成，可关闭此窗口继续切换镜头和章节。"}</p>
                    </div> : null}
                    {isDramaShotImageActive(imageBatch?.tasks[shot.id]) ? <p role="status" className="text-sm text-slate-500">{dramaShotImageTaskLabel(imageBatch?.tasks[shot.id])}，可关闭此窗口继续切换镜头和章节。</p> : null}
                    {imageBatch?.tasks[shot.id]?.status === "failed" ? <p className={styles.taskError}>生图失败：{imageBatch.tasks[shot.id].error}。原图片已保留。</p> : null}
                    <Button className="mt-3" onClick={() => { props.onExpand(board.id, [shot.id]); setSelectedShot(null); }}>在画布中编辑此镜头</Button>
                </div>
                <div className={styles.fields}>
                    <label>画面描述<Input.TextArea aria-label="镜头画面描述" value={shot.visualDescription} autoSize={{ minRows: 2, maxRows: 5 }} onChange={e => changeShot({ visualDescription: e.target.value })} /></label>
                    <label>图片提示词<Input.TextArea aria-label="镜头图片提示词" value={shot.imagePrompt ?? shot.finalPrompt} autoSize={{ minRows: 3, maxRows: 7 }} onChange={e => changeShot({ imagePrompt: e.target.value })} /></label>
                    <div className={styles.promptField}>
                        <div className={styles.promptFieldHeader}>
                            <label htmlFor="drama-shot-video-prompt">视频提示词</label>
                            {(shot.videoPrompt ?? shot.finalPrompt).trim() ? <Button size="small" className={styles.rewritePromptButton} icon={<Sparkles size={12} />} loading={props.rewritingShotIds.has(`${board.id}:${shot.id}`)} disabled={selectedVideoFeedback?.state === "queued" || selectedVideoFeedback?.state === "running"} title="结合当前镜头与失败原因改写视频提示词，不自动生成视频" onClick={() => void props.onRewritePrompt(board.id, shot.id)}>一键改写提示词</Button> : null}
                        </div>
                        <Input.TextArea id="drama-shot-video-prompt" aria-label="镜头视频提示词" value={shot.videoPrompt ?? shot.finalPrompt} autoSize={{ minRows: 3, maxRows: 7 }} onChange={e => changeShot({ videoPrompt: e.target.value, finalPrompt: e.target.value })} />
                    </div>
                    <label>时长（秒）<InputNumber aria-label="镜头时长" min={1} max={300} value={shot.durationSeconds} onChange={value => value && changeShot({ durationSeconds: value })} /></label>
                    <label>运镜<Input value={shot.cameraMovement} onChange={e => changeShot({ cameraMovement: e.target.value })} /></label>
                    <label>关联项目素材<Select mode="multiple" aria-label="镜头关联素材" value={shot.assetIds} options={pool.map(a => ({ value: a.id, label: a.name }))} onChange={assetIds => props.onStoryboard(board.id, value => ({ ...value, assets: [...new Map([...value.assets, ...pool.filter(a => assetIds.includes(a.id))].map(a => [a.id, a])).values()], shots: value.shots.map(s => s.id === shot.id ? { ...s, assetIds } : s) }))} /></label>
                </div>
            </div> : null}
        </Modal>
        <Modal title="项目素材" open={Boolean(editingAsset)} onCancel={() => setEditingAsset(null)} okText="保存修改" onOk={() => { if (editingAsset) props.onAsset(editingAsset, assetScope); setEditingAsset(null); }} width={680}>
            {editingAsset ? <div className={styles.fields}>
                {editingAsset.image?.source ? <img className={styles.assetLarge} src={editingAsset.image.source} alt={editingAsset.name} /> : <Empty description="暂无图片，可在详细编辑中补充" />}
                <label>名称<Input value={editingAsset.name} onChange={e => setEditingAsset({ ...editingAsset, name: e.target.value })} /></label>
                <label>描述<Input.TextArea value={editingAsset.description} autoSize={{ minRows: 3, maxRows: 7 }} onChange={e => setEditingAsset({ ...editingAsset, description: e.target.value })} /></label>
                <label>修改范围<Select value={assetScope} onChange={setAssetScope} options={[{ value: "project", label: "更新项目素材及所有章节引用" }, { value: "chapter", label: "另存为当前章节版本", disabled: !board }]} /></label>
            </div> : null}
        </Modal>
        <Modal title={`${active?.title || ""} · 剧本`} open={scriptOpen} onCancel={() => setScriptOpen(false)} footer={null} width={800}>
            {script?.kind === "text" ? <Input.TextArea aria-label="本章剧本" value={script.content.text} autoSize={{ minRows: 12, maxRows: 24 }} onChange={e => props.onScript(script.id, e.target.value)} /> : null}
        </Modal>
        <Modal title="镜头视频" open={Boolean(previewVideo)} onCancel={() => setPreviewVideo(null)} footer={null} destroyOnHidden width={900}>
            {previewVideo ? <video className={styles.video} src={previewVideo} controls autoPlay playsInline preload="metadata" /> : null}
        </Modal>
    </div>;
}
