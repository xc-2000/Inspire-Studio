"use client";

import { ArrowUpRight, Check, Download, Film, ImageIcon, LoaderCircle, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Dropdown, Input } from "antd";
import { cn } from "@/shared/lib/utils";
import { useCanvasStore } from "../stores/use-canvas-store";
import { useCanvasUiStore } from "../stores/use-canvas-ui-store";
import type { CanvasProjectSummary } from "../domain/canvas-project-summary";
import { CanvasProjectCover } from "./canvas-project-cover";
import styles from "./canvas-project-card.module.css";

export function CanvasProjectCard({ document }: { document: CanvasProjectSummary }) {
    const { message } = App.useApp();
    const router = useRouter();
    const renameDocument = useCanvasStore(state => state.renameDocument);
    const renameDraft = useCanvasUiStore(state => state.renameDraft);
    const selectedDocumentIds = useCanvasUiStore(state => state.selectedDocumentIds);
    const beginRename = useCanvasUiStore(state => state.beginRename);
    const changeRenameTitle = useCanvasUiStore(state => state.changeRenameTitle);
    const endRename = useCanvasUiStore(state => state.endRename);
    const setDocumentSelected = useCanvasUiStore(state => state.setDocumentSelected);
    const requestDocumentDeletion = useCanvasUiStore(state => state.requestDocumentDeletion);
    const id = document.identity.id;
    const selected = selectedDocumentIds.includes(id);
    const editing = renameDraft?.documentId === id;
    const [isExporting, setIsExporting] = useState(false);
    const media = document.media;
    const open = () => router.push(`/canvas/${id}`);
    const saveRename = async () => {
        if (!editing) return;
        const title = renameDraft.title;
        try { await useCanvasStore.getState().loadDocument(id); renameDocument(id, title); endRename(); }
        catch { message.error("读取画布失败，请重试；原名称已保留"); }
    };
    const exportDocument = async () => {
        if (isExporting) return;
        setIsExporting(true);
        try {
            const fullDocument = await useCanvasStore.getState().loadDocument(id);
            const { exportCanvasDocuments } = await import("../utils/canvas-export");
            await exportCanvasDocuments([fullDocument], document.identity.title || "无限画布");
        }
        catch { message.error("导出失败，请稍后重试"); }
        finally { setIsExporting(false); }
    };

    return (
        <article className={cn(styles.card, selected && styles.selected)} aria-label={document.identity.title}>
            <div className={styles.mediaArea}>
                <button type="button" className={styles.openCover} onClick={open} aria-label={`打开画布 ${document.identity.title}`}>
                    <CanvasProjectCover document={document} />
                    <span className={styles.mediaLabel}>{media.videos || media.label === "已成片" ? <Film size={12} /> : <ImageIcon size={12} />}{media.label}</span>
                    <span className={styles.openHint}>继续创作 <ArrowUpRight size={14} /></span>
                </button>
                <label className={styles.selection} title={`选择 ${document.identity.title}`}>
                    <input type="checkbox" checked={selected} onChange={event => setDocumentSelected(id, event.target.checked)} aria-label={`选择 ${document.identity.title}`} />
                    <span><Check size={13} strokeWidth={2.8} /></span>
                </label>
                <Dropdown trigger={["click"]} placement="bottomRight" menu={{
                    items: [
                        { key: "rename", label: "重命名", icon: <Pencil size={14} /> },
                        { key: "export", label: isExporting ? "正在导出…" : "导出画布", icon: <Download size={14} />, disabled: isExporting },
                        { type: "divider" },
                        { key: "delete", label: "删除画布", icon: <Trash2 size={14} />, danger: true },
                    ],
                    onClick: ({ key }) => {
                        if (key === "rename") beginRename(id, document.identity.title);
                        if (key === "export") void exportDocument();
                        if (key === "delete") requestDocumentDeletion([id]);
                    },
                }}>
                    <button className={styles.menuButton} type="button" title="更多操作" aria-label={`${document.identity.title} 更多操作`}>
                        {isExporting ? <LoaderCircle size={17} className="animate-spin" /> : <MoreHorizontal size={18} />}
                    </button>
                </Dropdown>
            </div>
            <div className={styles.details}>
                {editing ? <div className={styles.rename}>
                    <Input autoFocus value={renameDraft.title} aria-label="画布名称" onChange={event => changeRenameTitle(event.target.value)}
                        onKeyDown={event => { if (event.key === "Enter") saveRename(); if (event.key === "Escape") endRename(); }} />
                    <button type="button" onClick={saveRename} aria-label="保存名称" title="保存名称"><Check size={16} /></button>
                    <button type="button" onClick={endRename} aria-label="取消重命名" title="取消重命名"><X size={16} /></button>
                </div> : <button type="button" className={styles.titleButton} onClick={open}><h2 title={document.identity.title}>{document.identity.title}</h2></button>}
                <div className={styles.meta}>
                    <div className={styles.stats} aria-label={`${document.nodeCount} 个节点，${document.connectionCount} 条连线`}>
                        {media.images > 0 && <span><ImageIcon size={12} />{media.images}</span>}
                        {media.videos > 0 && <span><Film size={12} />{media.videos}</span>}
                        <span className={styles.nodeCount}>{document.nodeCount ? `${document.nodeCount} 个节点` : "从一个灵感开始"}</span>
                    </div>
                    <time dateTime={document.identity.updatedAt} title={formatCanvasDocumentTime(document.identity.updatedAt, true)}>{formatCanvasDocumentTime(document.identity.updatedAt)}</time>
                </div>
            </div>
        </article>
    );
}

function formatCanvasDocumentTime(value: string, full = false): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", ...(full ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(date) + " 更新";
}
