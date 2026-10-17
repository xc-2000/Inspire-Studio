"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Progress, Segmented, Select, Spin } from "antd";
import { ArrowDownToLine, Copy, FilePlus2, ImageIcon, ScanEye, Sparkles, Square, RotateCcw } from "lucide-react";
import copy from "copy-to-clipboard";
import type { ServerAiTaskMediaReference } from "@/services/api/server";
import { reverseImagePrompt, type ImagePromptReverseResult } from "../api/image-prompt-reverse";
import { CanvasToolDialog } from "./canvas-tool-dialog";
import { useCanvasTheme } from "./canvas-theme-provider";

export type CanvasImagePromptReverseDialogProps = {
    open: boolean;
    sourceId: string;
    nodePreview?: string;
    title?: string;
    imageReference: ServerAiTaskMediaReference | null;
    textModelOptions: Array<{ value: string; label: string }>;
    defaultModel?: string;
    preparing?: boolean;
    preparationError?: string;
    onRetryPreparation?: () => void;
    onClose: () => void;
    onApply: (prompt: string) => void;
    onCreateText: (result: ImagePromptReverseResult) => void;
};

type ReversePhase = "idle" | "running" | "success" | "canceled" | "error";
type PromptLanguage = "zh" | "en";

/** Keeps task state local; consumers own document updates and undo history. */
export function CanvasImagePromptReverseDialog(props: CanvasImagePromptReverseDialogProps) {
    const sourceKey = JSON.stringify([props.sourceId, props.nodePreview, props.imageReference?.url, props.imageReference?.storageKey]);
    return props.open ? <ImagePromptReverseSession key={sourceKey} {...props} /> : null;
}

function ImagePromptReverseSession({ nodePreview, title, imageReference, textModelOptions, defaultModel, preparing = false, preparationError, onRetryPreparation, onClose, onApply, onCreateText }: CanvasImagePromptReverseDialogProps) {
    const theme = useCanvasTheme();
    const { message } = App.useApp();
    const [model, setModel] = useState("");
    const [language, setLanguage] = useState<PromptLanguage>("zh");
    const [phase, setPhase] = useState<ReversePhase>("idle");
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState("");
    const [result, setResult] = useState<ImagePromptReverseResult | null>(null);
    const [previewFailed, setPreviewFailed] = useState(false);
    const requestRef = useRef<AbortController | null>(null);
    const resultActionRef = useRef(false);
    const initialModel = textModelOptions.some((option) => option.value === defaultModel) ? defaultModel! : textModelOptions[0]?.value || "";
    const validModel = textModelOptions.some((option) => option.value === model);
    const hasImage = Boolean(imageReference?.storageKey?.trim());
    const running = phase === "running";
    const promptKey = language === "zh" ? "promptZh" : "promptEn";
    const activePrompt = result?.[promptKey] || "";
    const canUseResult = Boolean(result && !running && !preparing && (result.promptZh.trim() || result.promptEn.trim()));
    const canRun = hasImage && validModel && !preparing && !preparationError && !running;

    useEffect(() => {
        return () => {
            requestRef.current?.abort();
            requestRef.current = null;
        };
    }, []);

    useEffect(() => {
        setModel((current) => textModelOptions.some((option) => option.value === current) ? current : initialModel);
    }, [initialModel, textModelOptions]);

    const stop = () => {
        requestRef.current?.abort();
        requestRef.current = null;
        setPhase("canceled");
        setProgress(0);
    };

    const close = () => {
        requestRef.current?.abort();
        requestRef.current = null;
        onClose();
    };

    const start = async () => {
        // The ref is set before React renders again, so rapid clicks cannot create duplicate tasks.
        if (!canRun || !imageReference || requestRef.current) return;
        const controller = new AbortController();
        requestRef.current = controller;
        resultActionRef.current = false;
        setPhase("running");
        setResult(null);
        setError("");
        setProgress(0);
        try {
            const next = await reverseImagePrompt({ image: imageReference, model, language: "bilingual" }, {
                signal: controller.signal,
                onProgress: (task) => {
                    if (requestRef.current === controller && !controller.signal.aborted) setProgress(Math.max(0, Math.min(99, task.progress || 0)));
                },
            });
            if (requestRef.current !== controller || controller.signal.aborted) return;
            setResult(next);
            setLanguage(next.promptZh ? "zh" : "en");
            setPhase("success");
        } catch (reason) {
            if (requestRef.current !== controller || controller.signal.aborted) return;
            setError(reason instanceof Error ? reason.message : "图片反推失败，请重试");
            setPhase("error");
        } finally {
            if (requestRef.current === controller) requestRef.current = null;
        }
    };

    const copyPrompt = async (text: string) => {
        if (!text.trim()) return;
        try {
            if (await copy(text.trim())) void message.success("提示词已复制");
            else void message.error("复制失败，请选中文字后复制");
        } catch {
            void message.error("复制失败，请选中文字后复制");
        }
    };

    const useResult = (action: "apply" | "create") => {
        if (!canUseResult || !result || resultActionRef.current || (action === "apply" && !activePrompt.trim())) return;
        resultActionRef.current = true;
        try {
            if (action === "apply") onApply(activePrompt.trim());
            else onCreateText({ ...result, promptZh: result.promptZh.trim(), promptEn: result.promptEn.trim(), negativePrompt: result.negativePrompt.trim() });
            close();
        } catch (reason) {
            resultActionRef.current = false;
            void message.error(reason instanceof Error ? reason.message : "保存提示词失败，请重试");
        }
    };

    return <CanvasToolDialog title="图片反推" subtitle="读懂画面，提取可复用的生成提示词" icon={<ScanEye />} width={900} onClose={close}>
        <div className="flex max-h-[75dvh] flex-col overflow-hidden" style={{ color: theme.node.text }}>
            <div className="grid min-h-0 gap-5 overflow-y-auto p-5 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-6 sm:p-7">
                <aside className="min-w-0 space-y-4">
                    <div className="overflow-hidden rounded-xl border" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.itemHover }}>
                        <div className="flex h-40 items-center justify-center sm:h-48">
                            {nodePreview && !previewFailed ? <img src={nodePreview} alt={title || "待反推图片"} className="h-full w-full object-contain" onError={() => setPreviewFailed(true)} /> : <div className="flex flex-col items-center gap-2 text-xs" style={{ color: theme.node.muted }}><ImageIcon className="size-8 opacity-50" />{previewFailed ? "图片预览不可用" : "暂无图片预览"}</div>}
                        </div>
                        <div className="flex items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: theme.toolbar.border, background: theme.node.panel }}>
                            <ImageIcon className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                            <span className="truncate text-xs" title={title}>{title || "画布图片"}</span>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <label htmlFor="image-reverse-model" className="block text-xs font-medium">识图模型</label>
                        <Select id="image-reverse-model" className="w-full" aria-label="识图模型" value={validModel ? model : undefined} options={textModelOptions} onChange={setModel} disabled={running || preparing || !textModelOptions.length} placeholder={preparing ? "正在加载模型…" : "暂无可用模型"} showSearch={{ optionFilterProp: "label" }} />
                        <p className="m-0 text-[11px] leading-relaxed" style={{ color: theme.node.muted }}>分析主体、构图、光线和材质，生成中英文及负面提示词。</p>
                    </div>
                    {running ? <Button block icon={<Square className="size-3.5" />} onClick={stop}>停止反推</Button> : <Button type="primary" block icon={phase === "idle" ? <Sparkles className="size-4" /> : <RotateCcw className="size-3.5" />} disabled={!canRun} onClick={() => void start()}>{phase === "idle" ? "开始反推" : "重新反推"}</Button>}
                    {preparing ? <div role="status" className="flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}><Spin size="small" />正在准备图片和模型…</div> : preparationError ? <Alert type="error" title="图片准备失败" description={<div className="space-y-2"><p className="m-0 break-words">{preparationError}</p>{onRetryPreparation ? <Button size="small" onClick={onRetryPreparation}>重新准备</Button> : null}</div>} /> : !hasImage ? <Alert type="warning" title="此节点没有可读取的图片" description="请先上传或生成一张图片。" /> : !textModelOptions.length ? <Alert type="warning" title="暂无可用的识图模型" description="请在模型设置中启用支持图片理解的文本模型。" /> : null}
                </aside>
                <section className="min-w-0" aria-label="反推结果" aria-busy={running}>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <Segmented<PromptLanguage> aria-label="提示词语言" value={language} onChange={setLanguage} options={[{ value: "zh", label: "中文提示词" }, { value: "en", label: "English" }]} disabled={!result} />
                        <Button size="small" type="text" icon={<Copy className="size-3.5" />} disabled={!activePrompt.trim() || running} onClick={() => copyPrompt(activePrompt)}>复制</Button>
                    </div>
                    {result ? <div className="space-y-4">
                        <div>
                            <Input.TextArea aria-label={language === "zh" ? "中文提示词" : "英文提示词"} value={activePrompt} onChange={(event) => setResult((current) => current ? { ...current, [promptKey]: event.target.value } : current)} autoSize={{ minRows: 10, maxRows: 15 }} placeholder="模型未返回此语言的提示词，可在此补充" className="!text-[13px] !leading-7" />
                            <div className="mt-1.5 flex justify-between gap-2 text-[10px]" style={{ color: theme.node.muted }}><span>可编辑后复制或保存到画布</span><span>{activePrompt.length} 字符</span></div>
                        </div>
                        {result.style ? <div className="flex gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}><Sparkles className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">{result.style}</span></div> : null}
                        <div>
                            <div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-medium">负面提示词 <span className="ml-1 font-normal" style={{ color: theme.node.muted }}>Negative prompt</span></span><Button size="small" type="text" aria-label="复制负面提示词" icon={<Copy className="size-3.5" />} disabled={!result.negativePrompt.trim()} onClick={() => copyPrompt(result.negativePrompt)} /></div>
                            <Input.TextArea aria-label="负面提示词" value={result.negativePrompt} onChange={(event) => setResult((current) => current ? { ...current, negativePrompt: event.target.value } : current)} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="模型未返回负面提示词，可自行补充" className="!text-xs !leading-6" />
                        </div>
                    </div> : <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border px-5 py-9 text-center sm:min-h-[354px]" style={{ background: theme.toolbar.itemHover, borderColor: theme.toolbar.border }}>
                        {running ? <><Spin size="large" /><p className="mb-1 mt-5 text-sm font-medium" role="status">正在理解图片…</p><p className="mb-4 mt-1 text-xs" style={{ color: theme.node.muted }}>提取视觉细节并整理为中英文提示词</p>{progress > 0 ? <Progress percent={Math.round(progress)} size="small" className="!w-48" strokeColor={theme.node.activeStroke} /> : null}</> : <><div className="mb-4 rounded-2xl p-4" style={{ background: theme.node.panel, color: theme.node.activeStroke }}><ScanEye className="size-7" /></div><p className="m-0 text-sm font-medium">{phase === "canceled" ? "已停止反推" : phase === "error" ? "此次反推未完成" : "从一张图片开始"}</p><p className="mb-0 mt-2 max-w-64 text-xs leading-6" style={{ color: theme.node.muted }}>{phase === "canceled" ? "可以切换模型，再次提取画面提示词。" : phase === "error" ? "检查错误信息，或切换其他识图模型重试。" : "选择识图模型并开始反推，结果将显示在这里。"}</p></>}
                    </div>}
                    {error ? <Alert className="mt-3" type="error" showIcon title="反推失败" description={<><p className="m-0 break-words">{error}</p><p className="mb-0 mt-2">{textModelOptions.length > 1 ? "可在左侧切换其他识图模型后重新反推。" : "可在模型设置中配置其他支持图片理解的文本模型后重试。"}</p></>} /> : null}
                </section>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-4 sm:px-7" style={{ borderColor: theme.toolbar.border }}>
                <span className="text-[11px]" style={{ color: theme.node.muted }}>回填使用当前语言；文本节点保留完整结果。</span>
                <div className="flex flex-wrap gap-2">
                    <Button icon={<ArrowDownToLine className="size-3.5" />} disabled={!canUseResult || !activePrompt.trim()} onClick={() => useResult("apply")}>回填图片提示词</Button>
                    <Button type="primary" icon={<FilePlus2 className="size-3.5" />} disabled={!canUseResult} onClick={() => useResult("create")}>生成文本节点</Button>
                </div>
            </div>
        </div>
    </CanvasToolDialog>;
}
