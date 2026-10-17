"use client";

import { useEffect, useState } from "react";
import { App, Button, Input, Progress } from "antd";
import { AlertCircle, ArrowUpRight, Check, ChevronDown, ChevronUp, Clapperboard, Copy, Download, FileText, FolderPlus, ImageIcon, LoaderCircle, Pencil, RotateCcw, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cancelAiTask, getServerMediaInfo, saveAsset, type ServerAiTask } from "@/services/api/server";
import { downloadMedia } from "@/features/storage/services/media-download";
import { useAssetStore, type Asset } from "@/features/assets/stores/use-asset-store";
import { formatGenerationError } from "@/shared/lib/generation-error";
import { commerceOutputLabel } from "../lib/catalog";
import type { CommerceJob } from "../api/ecommerce";
import "./commerce-result.css";

type ResultMedia = { url: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string };

export function CommerceResult({
    job,
    task,
    draft,
    disabled,
    onDraft,
    onUse,
    onRetry,
    onRefresh,
}: {
    job: CommerceJob;
    task?: ServerAiTask;
    draft?: string;
    disabled?: boolean;
    onDraft: (text: string) => void;
    onUse: (text: string) => void;
    onRetry: () => void;
    onRefresh: () => void;
}) {
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [editing, setEditing] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const result = task?.resultData as { content?: string; item?: ResultMedia; items?: ResultMedia[] } | undefined;
    const text = draft ?? result?.content ?? "";
    const items = result?.items || (result?.item ? [result.item] : []);
    const title = commerceOutputLabel(job.kind, job.variant);
    const running = !task || task.status === "pending" || task.status === "running";
    const statusLabel = !task ? "读取任务" : { pending: "排队中", running: "生成中", success: "已完成", failed: "生成失败", canceled: "已停止" }[task.status];
    const isText = job.kind !== "image" && job.kind !== "video";
    const ResultIcon = job.kind === "video" ? Clapperboard : job.kind === "image" ? ImageIcon : FileText;
    const longText = text.length > 260 || text.split("\n").length > 7;
    const error = task?.status === "failed" ? formatGenerationError(task.errorMessage) : "";
    const longError = error.length > 140 || error.split("\n").length > 2;
    const contentId = `commerce-result-content-${job.id}`;

    async function action(fn: () => Promise<unknown>) {
        if (busy) return;
        setBusy(true);
        try {
            await fn();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        } finally {
            setBusy(false);
        }
    }

    async function addAsset(media?: ResultMedia) {
        const kind = media ? (job.kind === "video" ? "video" : "image") : "text";
        const now = new Date().toISOString();
        const data = kind === "text" ? { content: text } : { ...media, dataUrl: media?.url, width: media?.width || 0, height: media?.height || 0, bytes: media?.bytes || 0, mimeType: media?.mimeType || (kind === "video" ? "video/mp4" : "image/png") };
        const asset = { id: `ecommerce-${job.id}-${kind}-${media ? items.indexOf(media) : 0}`, kind, title, data, coverUrl: kind === "image" ? media?.url : "", tags: ["电商", job.platform], source: "ecommerce", createdAt: now, updatedAt: now } as Asset;
        await saveAsset(asset);
        useAssetStore.setState((state) => ({ assets: [asset, ...state.assets.filter((item) => item.id !== asset.id)] }));
        if (kind === "video") void useAssetStore.getState().ensureVideoCover(asset.id);
        setSaved(true);
        message.success("已保存到我的资产");
    }

    return (
        <article className={`commerce-result commerce-result-card ${isText ? "is-text" : "is-media"}`}>
            <header className="commerce-result-header">
                <span className="commerce-result-icon">
                    <ResultIcon className="size-4" />
                </span>
                <div className="commerce-result-heading">
                    <h3>{title}</h3>
                    <time dateTime={job.createdAt} title={new Date(job.createdAt).toLocaleString("zh-CN")}>
                        {new Date(job.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        {draft !== undefined && " · 已编辑"}
                    </time>
                    {job.skillName && (
                        <p className="commerce-result-skill" title={`本次生成使用：${job.skillName} · v${job.skillRevision}`}>
                            {job.skillName} · v{job.skillRevision}
                        </p>
                    )}
                </div>
                <span className={`commerce-result-state ${task ? `is-${task.status}` : "is-pending"}`} role="status">
                    {running && <LoaderCircle className="size-3 animate-spin" />}
                    {task?.status === "success" && <Check className="size-3" />}
                    {task?.status === "failed" && <AlertCircle className="size-3" />}
                    {statusLabel}
                </span>
            </header>
            <div className="commerce-result-body">
                {running ? (
                    <div className="commerce-result-progress">
                        <div>
                            <strong>{task?.status === "running" ? "正在制作这份内容" : task ? "已加入创作队列" : "正在读取创作记录"}</strong>
                            {Boolean(task?.progress) && <span>{Math.max(0, Math.min(99, task?.progress || 0))}%</span>}
                        </div>
                        <Progress percent={Math.max(0, Math.min(99, task?.progress || 0))} showInfo={false} size="small" strokeColor="var(--studio-action)" />
                        <p>可以继续编辑或切换商品，完成后会保存在这里。</p>
                    </div>
                ) : null}
                {task?.status === "failed" && (
                    <div role="alert" className="commerce-result-error">
                        <strong>这次创作没有完成</strong>
                        <p>{longError ? "可查看失败原因，调整创作要求后重新提交。" : error}</p>
                        {longError && (
                            <details>
                                <summary>查看失败详情</summary>
                                <p>{error}</p>
                            </details>
                        )}
                    </div>
                )}
                {task?.status === "canceled" && <p className="commerce-result-note">任务已停止，可以调整内容后重新创作。</p>}
                {task?.status === "success" && text && (
                    <div className="commerce-result-copy">
                        {editing ? (
                            <Input.TextArea aria-label={`${title}内容`} disabled={disabled} value={text} autoSize={{ minRows: 6, maxRows: 14 }} onChange={(event) => onDraft(event.target.value)} className="commerce-result-editor" />
                        ) : (
                            <div id={contentId} className={`commerce-result-reading ${longText && !expanded ? "is-collapsed" : ""}`}>
                                <ReactMarkdown
                                    skipHtml
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        a: ({ href, children }) => (
                                            <a href={href} target="_blank" rel="noreferrer">
                                                {children}
                                            </a>
                                        ),
                                        table: ({ children }) => (
                                            <div className="commerce-result-table-scroll" role="region" aria-label="文案表格" tabIndex={0}>
                                                <table>{children}</table>
                                            </div>
                                        ),
                                    }}
                                >
                                    {text}
                                </ReactMarkdown>
                            </div>
                        )}
                        <div className="commerce-result-reading-tools">
                            {longText && !editing && (
                                <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
                                    {expanded ? "收起正文" : "展开全文"}
                                    {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                                </button>
                            )}
                            <button type="button" disabled={disabled} onClick={() => setEditing((value) => !value)}>
                                <Pencil className="size-3" />
                                {editing ? "完成编辑" : "编辑内容"}
                            </button>
                        </div>
                    </div>
                )}
                {task?.status === "success" &&
                    items.map((media, index) => (
                        <div key={media.storageKey || index} className="commerce-result-media-item">
                            <CommerceMedia media={media} video={job.kind === "video"} title={title} />
                            <div className="commerce-result-media-actions">
                                <Button size="small" icon={<Download className="size-3.5" />} disabled={busy} onClick={() => void action(() => downloadMedia(media, `${title}-${index + 1}.${job.kind === "video" ? "mp4" : "png"}`))}>
                                    下载
                                </Button>
                                <Button size="small" icon={saved ? <Check className="size-3.5" /> : <FolderPlus className="size-3.5" />} disabled={busy || saved} onClick={() => void action(() => addAsset(media))}>
                                    {saved ? "已存资产" : "保存资产"}
                                </Button>
                            </div>
                        </div>
                    ))}
                {task?.status === "success" && !text && !items.length && <p className="commerce-result-note">任务未返回可展示的内容，请重新生成。</p>}
                <footer className="commerce-result-actions">
                    {running ? (
                        <Button
                            size="small"
                            icon={<Square className="size-3" />}
                            disabled={busy || !task}
                            onClick={() =>
                                void action(async () => {
                                    await cancelAiTask(job.taskId);
                                    onRefresh();
                                })
                            }
                        >
                            停止
                        </Button>
                    ) : (
                        <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} disabled={disabled} onClick={onRetry}>
                            重新创作
                        </Button>
                    )}
                    {task?.status === "success" && text && (
                        <>
                            <Button
                                size="small"
                                type="text"
                                icon={<Copy className="size-3.5" />}
                                onClick={() =>
                                    void action(async () => {
                                        await navigator.clipboard.writeText(text);
                                        message.success("已复制");
                                    })
                                }
                            >
                                复制
                            </Button>
                            <Button size="small" type="text" icon={<ArrowUpRight className="size-3.5" />} disabled={disabled} onClick={() => onUse(text)}>
                                用于后续创作
                            </Button>
                            <Button size="small" type="text" icon={saved ? <Check className="size-3.5" /> : <FolderPlus className="size-3.5" />} disabled={saved || busy} onClick={() => void action(() => addAsset())}>
                                {saved ? "已存资产" : "保存资产"}
                            </Button>
                        </>
                    )}
                </footer>
            </div>
        </article>
    );
}

function CommerceMedia({ media, video, title }: { media: ResultMedia; video: boolean; title: string }) {
    const [url, setUrl] = useState(media.url);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        setUrl(media.url);
        setFailed(false);
        if (media.storageKey)
            void getServerMediaInfo(media.storageKey)
                .then((info) => {
                    if (active && info.url) {
                        setUrl(info.url);
                        setFailed(false);
                    }
                })
                .catch(() => {});
        return () => {
            active = false;
        };
    }, [media.storageKey, media.url]);
    return failed ? (
        <div className="commerce-result-media-unavailable">
            <ImageIcon className="size-5" />
            <span>
                预览暂时无法加载
                <br />
                可以下载文件查看
            </span>
        </div>
    ) : video ? (
        <video src={url} controls playsInline preload="metadata" width={media.width || undefined} height={media.height || undefined} className="commerce-result-media" aria-label={title} onError={() => setFailed(true)} />
    ) : (
        <a href={url} target="_blank" rel="noreferrer" className="commerce-result-media-link" aria-label={`查看${title}原图`}>
            <img src={url} alt={title} width={media.width || undefined} height={media.height || undefined} loading="lazy" decoding="async" className="commerce-result-media" onError={() => setFailed(true)} />
        </a>
    );
}
