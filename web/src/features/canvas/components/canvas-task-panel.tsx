"use client";

import { useMemo, useState } from "react";
import { App, Button, Input, Pagination, Progress, Select, Tag, Tooltip } from "antd";
import { ListTodo, LocateFixed, RotateCw } from "lucide-react";
import type { CanvasNode } from "../types";
import { canvasTaskRows, type CanvasTaskRow } from "../domain/canvas-task-list";
import { CanvasToolDialog } from "./canvas-tool-dialog";
import { useCanvasTheme } from "./canvas-theme-provider";

export function CanvasTaskPanel({ nodes, onLocate, onRetry }: {
    nodes: CanvasNode[]; onLocate: (row: CanvasTaskRow) => void; onRetry: (row: CanvasTaskRow) => Promise<void>;
}) {
    const theme = useCanvasTheme();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [retrying, setRetrying] = useState<Set<string>>(new Set());
    const rows = useMemo(() => canvasTaskRows(nodes), [nodes]);
    const running = rows.filter(row => row.phase === "running").length;
    const failed = rows.filter(row => row.phase === "failed").length;
    const results = rows.filter(row => (filter === "all" || row.phase === filter) && `${row.title} ${row.error || ""} ${row.taskId || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
    const currentPage = Math.min(page, Math.max(1, Math.ceil(results.length / 8)));

    return <>
        <Tooltip title={`生成任务${running ? ` · ${running} 个进行中` : ""}${failed ? ` · ${failed} 个失败` : ""}`}>
            <Button type="text" aria-label="打开生成任务" className="!h-9 !px-2" style={{ color: theme.node.text }} onClick={() => setOpen(true)} icon={<ListTodo className="size-4" />}>
                {running || failed ? <span className="text-[11px] tabular-nums">{running ? `${running}` : `${failed}`}</span> : null}
            </Button>
        </Tooltip>
        {open ? <CanvasToolDialog title="生成任务" subtitle={`${running} 个进行中 · ${failed} 个失败 · 记录覆盖所有章节`} icon={<ListTodo />} width={760} onClose={() => setOpen(false)}>
            <div className="flex flex-col gap-4 p-4 sm:p-5">
                <div className="flex flex-wrap gap-2">
                    <Input.Search allowClear className="min-w-40 flex-1" aria-label="搜索生成任务" placeholder="搜索节点、错误或任务号" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
                    <Select aria-label="筛选任务状态" value={filter} onChange={value => { setFilter(value); setPage(1); }} style={{ width: 120 }} options={[{ value: "all", label: "全部状态" }, { value: "running", label: "进行中" }, { value: "failed", label: "失败" }, { value: "succeeded", label: "已完成" }]} />
                </div>
                <div className="max-h-[55dvh] overflow-auto space-y-2">
                    {results.slice((currentPage - 1) * 8, currentPage * 8).map(row => <section key={row.id} className="rounded-xl border p-3" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                        <div className="flex items-center gap-2">
                            <h3 className="min-w-0 flex-1 truncate text-xs font-medium" title={row.title}>{row.title}</h3>
                            <Tag className="!mr-0" color={row.phase === "failed" ? "error" : row.phase === "succeeded" ? "success" : "processing"}>{row.stage}</Tag>
                            <Tooltip title="定位到所在节点或镜头"><Button size="small" type="text" aria-label={`定位 ${row.title}`} icon={<LocateFixed className="size-3.5" />} onClick={() => { setOpen(false); onLocate(row); }} /></Tooltip>
                            {row.phase === "failed" ? <Button size="small" icon={<RotateCw className="size-3" />} loading={retrying.has(row.id)} onClick={async () => {
                                if (retrying.has(row.id)) return;
                                setRetrying(current => new Set(current).add(row.id));
                                try { await onRetry(row); }
                                catch (error) { message.error(error instanceof Error ? error.message : "重试失败"); }
                                finally { setRetrying(current => { const next = new Set(current); next.delete(row.id); return next; }); }
                            }}>重试</Button> : null}
                        </div>
                        {row.phase === "running" && typeof row.progress === "number" ? <Progress percent={Math.max(0, Math.min(99, Math.round(row.progress)))} size="small" className="!mb-0 !mt-1" /> : null}
                        {row.error ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-red-500" role="alert">{row.error}</p> : null}
                        {row.taskId ? <p className="mt-1 truncate font-mono text-[10px]" style={{ color: theme.node.muted }} title={row.taskId}>任务号：{row.taskId}</p> : null}
                    </section>)}
                    {!results.length ? <p className="py-10 text-center text-xs" style={{ color: theme.node.muted }}>{rows.length ? "没有符合条件的任务" : "暂无生成任务"}</p> : null}
                </div>
                {results.length > 8 ? <Pagination size="small" current={currentPage} pageSize={8} total={results.length} showSizeChanger={false} onChange={setPage} /> : null}
            </div>
        </CanvasToolDialog> : null}
    </>;
}
