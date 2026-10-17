"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Checkbox, Modal, Tag } from "antd";
import { Clapperboard } from "lucide-react";

import { useUserStore } from "@/features/auth/stores/use-user-store";
import { VideoSettingsPanel } from "@/features/generation/components/video-settings-panel";
import { videoGenerationModeLabel, videoModelSupportsMode } from "@/features/generation/lib/video-billing";
import { ModelPicker } from "@/features/settings/components/model-picker";
import { isAgnesVideoConfig } from "@/features/generation/lib/agnes-video";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/features/settings/stores/use-config-store";
import {
    quoteStoryboardVideo,
    readStoryboardShotReferenceImages,
    readStoryboardVideoCost,
    readStoryboardVideoGenerationModes,
    readStoryboardVideoReferenceIssue,
    readStoryboardVideoResolutionOptions,
    readStoryboardVideoShotIssue,
} from "../domain/storyboard";
import type { CanvasStoryboardAsset, CanvasStoryboardNode, CanvasStoryboardShot } from "../types";
import { readStoryboardVideoSelection } from "../domain/storyboard-video-selection";
import { readDramaVideoContinuationSettings, readDramaVideoPreflight } from "@/features/open-drama/drama-video-preflight";
import type { ReferenceVideo } from "@/features/generation/types/media";
import { useCanvasTheme } from "./canvas-theme-provider";

export type StoryboardVideoGenerationSettings = Pick<AiConfig, "size" | "vquality" | "videoSeconds" | "videoWatermark" | "videoGenerationMode">;

type StoryboardVideoGenerationModalProps = {
    open: boolean;
    node: CanvasStoryboardNode | null;
    generating: boolean;
    /** 限定本次可选镜头；省略时保留整章选择，空数组表示不选择任何镜头。 */
    shotIds?: string[];
    /** 画布连入分镜节点的视频参考，批量应用到全部选中镜头。 */
    referenceVideos?: ReferenceVideo[];
    onClose: () => void;
    onGenerate: (nodeId: string, shotIds: string[], model: string, settings: StoryboardVideoGenerationSettings) => void;
    onMissingVideoModelConfig?: () => void;
};

/** 分镜镜头批量视频生成选择弹窗。 */
export function StoryboardVideoGenerationModal({ open, node, generating, shotIds, referenceVideos = [], onClose, onGenerate, onMissingVideoModelConfig }: StoryboardVideoGenerationModalProps) {
    const { message, modal } = App.useApp();
    const theme = useCanvasTheme();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const creditBalance = useUserStore((state) => state.user?.creditBalance);
    const [selectedShotIds, setSelectedShotIds] = useState<string[]>([]);
    const [addedPrerequisiteIds, setAddedPrerequisiteIds] = useState<string[]>([]);
    const [videoModel, setVideoModel] = useState("");
    const [videoSettings, setVideoSettings] = useState<StoryboardVideoGenerationSettings>(() => readVideoSettings(effectiveConfig));
    const selection = useMemo(() => readStoryboardVideoSelection(node?.storyboard.shots || [], shotIds), [node?.storyboard.shots, shotIds]);
    const scopedShots = useMemo(() => addedPrerequisiteIds.length && shotIds !== undefined
        ? readStoryboardVideoSelection(node?.storyboard.shots || [], [...shotIds, ...addedPrerequisiteIds]).shots
        : selection.shots, [addedPrerequisiteIds, node?.storyboard.shots, selection.shots, shotIds]);

    const videoConfig = useMemo(() => ({ ...effectiveConfig, ...videoSettings, model: videoModel, videoModel, count: "1", canvasVideoCount: "1" }), [effectiveConfig, videoModel, videoSettings]);
    const isAgnesVideo = useMemo(() => isAgnesVideoConfig(videoConfig), [videoConfig]);
    const shotStates = useMemo(() => {
        const assets = node?.storyboard.assets || [];
        return scopedShots.map((shot) => {
            const referenceImageCount = readStoryboardShotReferenceImages(shot, assets).length;
            return { shot, referenceImageCount, referenceVideoCount: referenceVideos.length, issue: readShotIssue(shot, assets, videoModel, videoConfig, referenceVideos) };
        });
    }, [node?.storyboard.assets, scopedShots, referenceVideos, videoConfig, videoModel]);
    const selectableShotIds = useMemo(() => shotStates.map((item) => item.shot.id), [shotStates]);
    const selectableShotIdsKey = selectableShotIds.join("|");

    useEffect(() => {
        if (!open || !node) return;
        const continuation = node.dramaChapterId ? readDramaVideoContinuationSettings(node, selection.selectedShotIds) : undefined;
        setVideoModel(continuation?.model && effectiveConfig.videoModels.includes(continuation.model) ? continuation.model : effectiveConfig.videoModel);
        setVideoSettings({ ...readVideoSettings(effectiveConfig), ...(continuation?.size ? { size: continuation.size } : {}) });
        setSelectedShotIds(selection.selectedShotIds);
        setAddedPrerequisiteIds([]);
    }, [effectiveConfig.size, effectiveConfig.videoGenerationMode, effectiveConfig.videoModel, effectiveConfig.videoSeconds, effectiveConfig.videoWatermark, effectiveConfig.vquality, node?.id, open, shotIds]);

    useEffect(() => {
        if (!open) return;
        const selectableShotIdSet = new Set(selectableShotIds);
        setSelectedShotIds((current) => current.filter((shotId) => selectableShotIdSet.has(shotId)));
    }, [open, selectableShotIdsKey]);

    const selectedShots = useMemo(() => {
        const selectedShotIdSet = new Set(selectedShotIds);
        return shotStates.filter((item) => selectedShotIdSet.has(item.shot.id)).map((item) => item.shot);
    }, [selectedShotIds, shotStates]);
    const selectedInputIssue = shotStates.find(item => selectedShotIds.includes(item.shot.id) && item.issue);
    const preflight = useMemo(() => node?.dramaChapterId
        ? readDramaVideoPreflight(node, selectedShots.map(shot => shot.id), { model: videoModel, size: videoSettings.size })
        : { issues: [], prerequisiteShotIds: [] }, [node, selectedShots, videoModel, videoSettings.size]);
    const rowDependencyIssues = useMemo(() => new Map(scopedShots.map(shot => [shot.id,
        node?.dramaChapterId ? readDramaVideoPreflight(node, [...new Set([...selectedShots.map(item => item.id), shot.id])],
            { model: videoModel, size: videoSettings.size }).issues.find(issue => issue.shotId === shot.id)?.message : undefined,
    ])), [node, scopedShots, selectedShots, videoModel, videoSettings.size]);
    const prerequisiteNumbers = node?.storyboard.shots.filter(shot => preflight.prerequisiteShotIds.includes(shot.id))
        .sort((a, b) => a.shotNumber - b.shotNumber).map(shot => shot.shotNumber).join("、");
    const addPrerequisites = () => {
        setAddedPrerequisiteIds(current => [...new Set([...current, ...preflight.prerequisiteShotIds])]);
        setSelectedShotIds(current => [...new Set([...current, ...preflight.prerequisiteShotIds])]);
    };
    const automaticModes = useMemo(() => readStoryboardVideoGenerationModes(scopedShots, node?.storyboard.assets || [], referenceVideos), [node?.storyboard.assets, scopedShots, referenceVideos]);
    const storyboardModelOptions = useMemo(() => effectiveConfig.videoModels.filter((model) => automaticModes.every((mode) => videoModelSupportsMode(effectiveConfig, model, mode))), [automaticModes, effectiveConfig]);
    const storyboardResolutionOptions = useMemo(
        () => readStoryboardVideoResolutionOptions(effectiveConfig, videoModel, selectedShots.length ? selectedShots : scopedShots, node?.storyboard.assets || [], referenceVideos),
        [effectiveConfig, node?.storyboard.assets, scopedShots, referenceVideos, selectedShots, videoModel],
    );
    const modelReady = Boolean(videoModel && storyboardModelOptions.includes(videoModel) && isAiConfigReady(effectiveConfig, videoModel));
    const videoQuote = readStoryboardVideoCost(effectiveConfig, videoModel, videoConfig, selectedShots, node?.storyboard.assets || [], referenceVideos);
    const totalCredits = videoQuote.available ? videoQuote.credits : null;
    const balanceInsufficient = typeof creditBalance === "number" && totalCredits !== null && totalCredits > creditBalance;
    const allSelected = Boolean(selectableShotIds.length) && selectedShots.length === selectableShotIds.length;
    const partiallySelected = selectedShots.length > 0 && !allSelected;
    const creditUnit = effectiveConfig.videoModelBillingConfigurations.find((item) => item.model === videoModel)?.videoBillingConfiguration?.billingUnit;

    const toggleAll = () => setSelectedShotIds(allSelected ? [] : selectableShotIds);
    const toggleShot = (shotId: string, checked: boolean) => {
        setSelectedShotIds((current) => (checked ? [...new Set([...current, shotId])] : current.filter((id) => id !== shotId)));
    };
    const handleVideoSettingsChange = useCallback((key: keyof StoryboardVideoGenerationSettings, value: string) => {
        setVideoSettings((current) => (current[key] === value ? current : { ...current, [key]: value }));
    }, []);
    const confirmGenerate = () => {
        if (!node || generating) return;
        if (!selectedShots.length) {
            message.warning("请至少选择一个可生成视频的镜头");
            return;
        }
        if (preflight.issues.length) {
            message.error(preflight.issues[0].message);
            return;
        }
        if (selectedInputIssue) {
            message.error(`镜号 ${selectedInputIssue.shot.shotNumber}：${selectedInputIssue.issue}`);
            return;
        }
        if (!modelReady) {
            onMissingVideoModelConfig?.();
            message.error("请选择可用的视频模型后再生成");
            return;
        }
        if (!videoQuote.available) {
            message.error(videoQuote.reason);
            return;
        }
        if (balanceInsufficient) {
            message.error(`积分不足，生成 ${selectedShots.length} 个视频需要 ${totalCredits} 积分，当前可用 ${creditBalance} 积分`);
            return;
        }
        modal.confirm({
            title: "确认批量生成分镜视频",
            content: `将使用所选模型、${videoConfig.size || "自动"}比例和${videoConfig.vquality || "默认"}清晰度，为 ${selectedShots.length} 个镜头分别创建视频任务，预计消耗 ${totalCredits} 积分。${node.dramaChapterId ? "连续镜头将按顺序生成并使用前镜尾帧；前镜失败时暂停后续镜头。" : ""}是否继续？`,
            okText: "确认生成",
            cancelText: "取消",
            onOk: () => {
                onGenerate(
                    node.id,
                    selectedShots.map((shot) => shot.id),
                    videoModel,
                    { ...videoSettings },
                );
                onClose();
            },
        });
    };

    return (
        <Modal
            title="批量生成分镜视频"
            open={open && Boolean(node)}
            onCancel={onClose}
            width={1180}
            destroyOnHidden={false}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    取消
                </Button>,
                <Button key="generate" type="primary" icon={<Clapperboard className="size-4" />} loading={generating} disabled={!selectedShots.length || !modelReady || !videoQuote.available || balanceInsufficient || Boolean(preflight.issues.length) || Boolean(selectedInputIssue)} onClick={confirmGenerate}>
                    生成已选镜头（{selectedShots.length} 个，{totalCredits === null ? "不可报价" : `${totalCredits} 积分`}）
                </Button>,
            ]}
        >
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                <section className="min-w-0 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3" style={{ borderColor: theme.node.stroke }}>
                        <Checkbox checked={allSelected} indeterminate={partiallySelected} disabled={!selectableShotIds.length || generating} onChange={toggleAll}>
                            全选镜头（{selectableShotIds.length} 个）
                        </Checkbox>
                        <span className="text-xs text-[var(--studio-muted)]">已选择 {selectedShots.length} 个</span>
                    </div>
                    {preflight.issues.length > 0 && <Alert type="warning" showIcon title="所选镜头尚有生成前置条件" description={<div className="space-y-2">
                        <p>{preflight.issues[0].message}</p>
                        {preflight.issues.length > 1 && <p>另有 {preflight.issues.length - 1} 个镜头需要处理，详情见各镜头提示。</p>}
                        {preflight.prerequisiteShotIds.length > 0 && <>
                            <p>需要补选镜头 {prerequisiteNumbers}，按顺序生成后才能继续。补选后会重新计算数量与积分。</p>
                            <Button size="small" disabled={generating} onClick={addPrerequisites}>补选前置镜头（{preflight.prerequisiteShotIds.length} 个）</Button>
                        </>}
                    </div>} />}
                    {node?.dramaChapterId && !preflight.issues.length && selectedShots.length > 1 && <p className="text-xs text-[var(--studio-muted)]">连续镜头按顺序生成，使用前镜实际尾帧衔接；前镜失败会暂停后续镜头。</p>}
                    <div className="max-h-[58vh] space-y-2 overflow-y-auto pr-1">
                        {shotStates.map(({ shot, referenceImageCount, referenceVideoCount, issue }) => {
                            const dependencyIssue = rowDependencyIssues.get(shot.id);
                            const referenceLabel =
                                [node?.dramaChapterId && shot.continuity?.transition === "continue" ? "前镜视频尾帧" : referenceImageCount === 0 ? "" : isAgnesVideo && referenceImageCount >= 2 && referenceImageCount <= 3 ? `${referenceImageCount} 张关键帧` : `${referenceImageCount} 张参考图`, referenceVideoCount > 0 ? `${referenceVideoCount} 个视频参考` : ""].filter(Boolean).join("，") || "无参考素材";
                            return (
                                <div key={shot.id} className="flex min-w-0 items-start gap-3 rounded-md border px-3 py-2.5" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                                    <Checkbox
                                        className="mt-0.5"
                                        aria-label={`选择镜号 ${shot.shotNumber}`}
                                        checked={selectedShotIds.includes(shot.id)}
                                        disabled={generating}
                                        onChange={(event) => toggleShot(shot.id, event.target.checked)}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                            <span className="font-semibold">镜号 {shot.shotNumber}</span>
                                            <span className="text-[var(--studio-muted)]">{shot.durationSeconds} 秒</span>
                                            <Tag className="m-0">{shot.shotSize}</Tag>
                                            <span className="text-[var(--studio-muted)]">{referenceLabel}</span>
                                            {issue || dependencyIssue ? <span className="text-red-500">{issue || dependencyIssue}</span> : <span className="text-emerald-600">{node?.dramaChapterId && shot.continuity?.transition === "continue" ? "按前镜尾帧衔接" : "可生成"}</span>}
                                        </div>
                                        <p className="mt-1 line-clamp-2 text-sm text-[var(--studio-muted)]">{shot.visualDescription || "未填写画面描述"}</p>
                                        {(shot.videoPrompt ?? shot.finalPrompt).trim() ? <p className="mt-1 line-clamp-2 text-xs text-[var(--studio-muted)]">{shot.videoPrompt ?? shot.finalPrompt}</p> : null}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </section>
                <aside className="max-h-[58vh] space-y-5 overflow-y-auto rounded-md border p-4" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <div>
                        <h3 className="text-sm font-semibold">视频设置</h3>
                        <p className="mt-1 text-xs text-[var(--studio-muted)]">比例和清晰度可单独设置，时长固定使用每个镜头的分镜定义。</p>
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-[var(--studio-muted)]">视频模型</label>
                        <ModelPicker config={effectiveConfig} value={videoModel} capability="video" modelOptions={storyboardModelOptions} fullWidth onChange={setVideoModel} onMissingConfig={onMissingVideoModelConfig} />
                    </div>
                    <VideoSettingsPanel
                        config={videoConfig}
                        onConfigChange={handleVideoSettingsChange}
                        theme={theme}
                        showTitle={false}
                        showGenerationMode={false}
                        showDuration={false}
                        resolutionOptions={storyboardResolutionOptions}
                        className="space-y-4"
                    />
                    <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[var(--studio-muted)]">自动模式</span>
                            <span>{automaticModes.map(videoGenerationModeLabel).join(" / ") || "不可生成"}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-[var(--studio-muted)]">计费方式</span>
                            <span>{creditUnit === "second" ? "按秒计费" : creditUnit === "generation" ? "按次计费" : "不可报价"}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3 font-semibold">
                            <span>预计消耗</span>
                            <span>{totalCredits === null ? "不可报价" : `${totalCredits} 积分`}</span>
                        </div>
                    </div>
                    {!modelReady ? <p className="text-xs text-red-500">请选择已启用且已配置价格的视频模型</p> : null}
                    {!videoQuote.available ? <p className="text-xs text-red-500">{videoQuote.reason}</p> : null}
                    {balanceInsufficient ? <p className="text-xs text-red-500">积分不足，当前可用 {creditBalance ?? 0} 积分</p> : null}
                </aside>
            </div>
        </Modal>
    );
}

function readVideoSettings(config: AiConfig): StoryboardVideoGenerationSettings {
    return {
        videoGenerationMode: config.videoGenerationMode,
        size: config.size,
        vquality: config.vquality,
        videoSeconds: config.videoSeconds,
        videoWatermark: config.videoWatermark,
    };
}

function readShotIssue(shot: CanvasStoryboardShot, assets: CanvasStoryboardAsset[], videoModel: string, videoConfig: AiConfig, referenceVideos: ReferenceVideo[]): string {
    if (!(shot.videoPrompt ?? shot.finalPrompt).trim()) return "请先填写视频提示词";
    if (!Number.isSafeInteger(shot.durationSeconds) || shot.durationSeconds < 1) return "镜头时长无效";
    if (!videoModel) return "";
    const issue = readStoryboardVideoShotIssue(shot, videoConfig) || readStoryboardVideoReferenceIssue(shot, assets, videoConfig);
    if (issue) return issue;
    const quote = quoteStoryboardVideo(videoConfig, videoModel, videoConfig, shot, assets, referenceVideos);
    return quote.available ? "" : quote.reason;
}
