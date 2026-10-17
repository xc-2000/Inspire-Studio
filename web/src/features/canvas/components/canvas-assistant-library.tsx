"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Select, Tooltip } from "antd";
import { Check, Crosshair, FileText, MessageSquare, Pencil, Plus, Search, X } from "lucide-react";
import { ListPagination } from "@/shared/components/list-pagination";
import type { CanvasTheme } from "@/shared/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasNode, CanvasNodeKind } from "../types";
import { ASSISTANT_NODE_LABELS, exportAssistantSession, findAssistantNodes, findAssistantSessions } from "../domain/canvas-assistant-workspace";

const iconButton = "grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 focus-visible:outline-2 disabled:opacity-30";

export function CanvasAssistantExport({ session, onClose, onCopy, theme }: {
    session: CanvasAssistantSession;
    onClose: () => void;
    onCopy: (text: string) => void;
    theme: CanvasTheme;
}) {
    const exported = useMemo(() => exportAssistantSession(session), [session]);
    const [url, setUrl] = useState("");
    useEffect(() => {
        const objectUrl = URL.createObjectURL(new Blob(["\uFEFF", exported.text], { type: "text/markdown;charset=utf-8" }));
        setUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [exported]);
    return <Modal open title="导出对话" width={560} onCancel={onClose} styles={{ container: { background: theme.node.panel, color: theme.node.text } }} footer={<div className="flex justify-end gap-2"><Button onClick={() => onCopy(exported.text)}>复制 Markdown</Button><Button type="primary" href={url || undefined} download={exported.filename} disabled={!url}>下载 Markdown</Button></div>}>
        <p className="mb-3 truncate text-xs" style={{ color: theme.node.muted }} title={exported.filename}>{exported.filename} · {session.messages.length} 条消息</p>
        <Input.TextArea aria-label="导出的 Markdown 内容" readOnly value={exported.text} autoSize={{ minRows: 8, maxRows: 16 }} className="text-xs" />
    </Modal>;
}

export function CanvasAssistantHistory({ sessions, activeId, busy, onSelect, onRename, onClose, theme }: {
    sessions: CanvasAssistantSession[];
    activeId: string | null;
    busy: boolean;
    onSelect: (id: string) => boolean;
    onRename: (id: string, title: string) => void;
    onClose: () => void;
    theme: CanvasTheme;
}) {
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [title, setTitle] = useState("");
    const filtered = useMemo(() => findAssistantSessions(sessions, query), [sessions, query]);
    const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
    const saveTitle = () => {
        if (!editingId || !title.trim()) return;
        onRename(editingId, title.trim().slice(0, 80));
        setEditingId(null);
    };
    return (
        <Modal open title="历史对话" width={480} footer={null} onCancel={onClose} styles={{ container: { background: theme.node.panel, color: theme.node.text } }}>
            <Input autoFocus allowClear prefix={<Search className="size-4" />} placeholder="搜索标题或对话内容" aria-label="搜索历史对话" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
            {busy ? <p className="mt-3 text-xs" style={{ color: theme.node.muted }}>当前任务结束后可切换对话。</p> : null}
            <div className="thin-scrollbar mt-3 max-h-[min(55dvh,420px)] space-y-1 overflow-y-auto" aria-label="历史对话列表">
                {filtered.slice((current - 1) * pageSize, current * pageSize).map((session) => (
                    <div key={session.id} className="flex items-center gap-1 rounded-xl border p-2" style={{ borderColor: session.id === activeId ? theme.node.activeStroke : "transparent", background: session.id === activeId ? theme.toolbar.activeBg : theme.toolbar.itemHover }}>
                        {editingId === session.id ? (
                            <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(event) => { event.preventDefault(); saveTitle(); }}>
                                <Input autoFocus aria-label="对话名称" maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditingId(null); } }} />
                                <button type="submit" className={iconButton} aria-label="保存对话名称" disabled={!title.trim()}><Check className="size-4" /></button>
                                <button type="button" className={iconButton} aria-label="取消重命名" onClick={() => setEditingId(null)}><X className="size-4" /></button>
                            </form>
                        ) : <>
                            <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1.5 text-left focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy && session.id !== activeId} onClick={() => { if (onSelect(session.id)) onClose(); }} aria-current={session.id === activeId ? "true" : undefined}>
                                <MessageSquare className="size-4 shrink-0" style={{ color: theme.node.muted }} />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13px] font-medium">{session.title || "新对话"}</span>
                                    <span className="mt-1 block text-[11px]" style={{ color: theme.node.muted }}>{session.messages.length} 条消息 · {new Date(session.updatedAt).toLocaleDateString("zh-CN")}{session.id === activeId ? " · 当前对话" : ""}</span>
                                </span>
                            </button>
                            <Tooltip title="重命名"><button type="button" className={iconButton} aria-label={`重命名 ${session.title}`} onClick={() => { setEditingId(session.id); setTitle(session.title); }}><Pencil className="size-3.5" /></button></Tooltip>
                        </>}
                    </div>
                ))}
                {!filtered.length ? <p className="py-10 text-center text-xs" style={{ color: theme.node.muted }}>{query ? "没有找到相关对话" : "开始对话后，历史记录会保存在这里"}</p> : null}
            </div>
            <ListPagination compact current={current} pageSize={pageSize} total={filtered.length} onChange={(next, size) => { setPage(next); setPageSize(size); }} label="历史对话分页" />
        </Modal>
    );
}

export function CanvasAssistantNodePicker({ nodes, referencedIds, onToggle, onLocate, onClose, theme }: {
    nodes: CanvasNode[];
    referencedIds: ReadonlySet<string>;
    onToggle: (nodeId: string) => void;
    onLocate: (nodeId: string) => void;
    onClose: () => void;
    theme: CanvasTheme;
}) {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<CanvasNodeKind | undefined>();
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const filtered = useMemo(() => findAssistantNodes(nodes, query, kind), [nodes, query, kind]);
    const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
    return (
        <Modal open title="引用画布节点" width={480} onCancel={onClose} footer={<Button type="primary" onClick={onClose}>完成{referencedIds.size ? `（已引用 ${referencedIds.size} 个）` : ""}</Button>} styles={{ container: { background: theme.node.panel, color: theme.node.text } }}>
            <div className="flex gap-2">
                <Input autoFocus allowClear prefix={<Search className="size-4" />} placeholder="搜索名称、ID 或文本" aria-label="搜索画布节点" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
                <Select className="w-28 shrink-0" aria-label="节点类型" value={kind || "all"} onChange={(value) => { setKind(value === "all" ? undefined : value as CanvasNodeKind); setPage(1); }} options={[{ value: "all", label: "全部类型" }, ...Object.entries(ASSISTANT_NODE_LABELS).map(([value, label]) => ({ value, label }))]} />
            </div>
            <div className="thin-scrollbar mt-3 max-h-[min(55dvh,420px)] space-y-1 overflow-y-auto" aria-label="可引用节点列表">
                {filtered.slice((current - 1) * pageSize, current * pageSize).map((node) => {
                    const selected = referencedIds.has(node.id);
                    return (
                        <div key={node.id} className="flex items-center gap-1 rounded-xl border p-2" style={{ borderColor: selected ? theme.node.activeStroke : "transparent", background: selected ? theme.toolbar.activeBg : theme.toolbar.itemHover }}>
                            <button type="button" aria-pressed={selected} aria-label={`${selected ? "取消引用" : "引用"} ${node.title}`} onClick={() => onToggle(node.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 text-left focus-visible:outline-2">
                                {node.kind === "image" && node.content.source ? <img src={node.content.source} alt="" loading="lazy" className="size-10 shrink-0 rounded-lg object-cover" /> : <span className="grid size-10 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.panel }}><FileText className="size-4" /></span>}
                                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{node.title}</span><span className="mt-0.5 block truncate text-[11px]" style={{ color: theme.node.muted }}>{ASSISTANT_NODE_LABELS[node.kind]} · {node.id}</span></span>
                                {selected ? <Check className="size-4 shrink-0" /> : <Plus className="size-4 shrink-0" />}
                            </button>
                            <Tooltip title="在画布中定位"><button type="button" className={iconButton} aria-label={`定位 ${node.title}`} onClick={() => { onLocate(node.id); onClose(); }}><Crosshair className="size-4" /></button></Tooltip>
                        </div>
                    );
                })}
                {!filtered.length ? <p className="py-10 text-center text-xs" style={{ color: theme.node.muted }}>{nodes.length ? "没有找到匹配的节点" : "画布还没有节点"}</p> : null}
            </div>
            <ListPagination compact current={current} pageSize={pageSize} total={filtered.length} onChange={(next, size) => { setPage(next); setPageSize(size); }} label="节点搜索分页" />
        </Modal>
    );
}
