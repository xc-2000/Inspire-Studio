"use client";

import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Input, Popconfirm, Spin, Select } from "antd";
import { ArrowRight, GitBranch, Save, Search, Trash2, FolderOpen, Monitor, Blocks, FileText, Image as ImageIcon, Video, AudioLines } from "lucide-react";
import { nanoid } from "nanoid";
import { ListPagination } from "@/shared/components/list-pagination";
import { usePaginatedList } from "@/shared/hooks/use-paginated-list";
import { builtInCanvasWorkflows, createCanvasWorkflowTemplate, type CanvasSubgraph, type CanvasWorkflowTemplate } from "../domain/canvas-workflow-template";
import { listCanvasWorkflowTemplates, saveCanvasWorkflowTemplate, deleteCanvasWorkflowTemplate } from "../services/canvas-workflow-templates";
import { useCanvasTheme } from "./canvas-theme-provider";
import { CanvasToolDialog } from "./canvas-tool-dialog";
import { canvasNodesBounds } from "../domain/canvas-arrangement";
import styles from "./canvas-editor.module.css";

export function CanvasWorkflowLibrary({ userId, selection, onInsert, onClose }: {
    userId: string; selection: CanvasSubgraph; onInsert: (template: CanvasWorkflowTemplate) => void; onClose: () => void;
}) {
    const { message } = App.useApp();
    const [tab, setTab] = useState("builtin");
    const [query, setQuery] = useState("");
    const [templates, setTemplates] = useState<CanvasWorkflowTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [keepMedia, setKeepMedia] = useState(false);
    const [visibility, setVisibility] = useState<"private" | "public">("private");
    const [updateId, setUpdateId] = useState<string>();
    const [publicTemplates, setPublicTemplates] = useState<CanvasWorkflowTemplate[]>([]);
    const builtins = useMemo(builtInCanvasWorkflows, []);
    useEffect(() => {
        let active = true;
        setLoading(true); setError("");
        listCanvasWorkflowTemplates(userId, tab === "public" ? "public" : "mine").then((items) => { if (active) (tab === "public" ? setPublicTemplates : setTemplates)(items); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : "云端模板读取失败，请重试。"); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [userId, tab]);
    const items = useMemo(() => (tab === "builtin" ? builtins : tab === "public" ? publicTemplates : templates).filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())), [builtins, query, tab, templates, publicTemplates]);
    const pagination = usePaginatedList(items, 6, `${tab}:${query}`);
    const saveSelection = async () => {
        if (!name.trim() || !selection.nodes.length || saving) return;
        setSaving(true);
        try {
            const previous = templates.find(item => item.id === updateId);
            const template = createCanvasWorkflowTemplate(selection, previous?.id || nanoid(), name, description, keepMedia);
            const saved = await saveCanvasWorkflowTemplate(userId, { ...template, revision: previous?.revision, visibility });
            setTemplates((current) => [saved, ...current.filter(item => item.id !== saved.id)]);
            setUpdateId(undefined);
            setEditing(false); setTab("mine"); setQuery(""); setName(""); setDescription("");
            message.success("已保存到我的模板");
        } catch (e) { message.error(e instanceof Error ? e.message : "模板保存失败，请重试"); }
        finally { setSaving(false); }
    };
    return <CanvasToolDialog title="工作流模板" subtitle="把创作步骤连接起来，从一个好用的流程开始。" icon={<GitBranch />} onClose={onClose}>
        <div className={styles.libraryBody}>
            <div className={styles.libraryTools}>
                <div className={styles.tabs} role="group" aria-label="模板分类">
                    <button type="button" aria-pressed={tab === "builtin"} onClick={() => setTab("builtin")}>推荐流程</button>
                    <button type="button" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>我的模板{templates.length ? ` · ${templates.length}` : ""}</button>
                    <button type="button" aria-pressed={tab === "public"} onClick={() => setTab("public")}>公开模板</button>
                </div>
                <Button icon={<Save className="size-3.5" />} disabled={!selection.nodes.length || loading || Boolean(error)} onClick={() => setEditing(!editing)}>{editing ? "收起保存" : `保存选区${selection.nodes.length ? `（${selection.nodes.length}）` : ""}`}</Button>
            </div>
            {editing ? <form className={styles.saveForm} onSubmit={(event) => { event.preventDefault(); void saveSelection(); }}>
                <div className={styles.formTitle}><span>保存为我的模板</span><span className="text-[11px] font-normal opacity-60">{selection.nodes.length} 个节点</span></div>
                <Select allowClear placeholder="创建新模板，或选择已有模板进行更新" aria-label="更新已有模板" value={updateId} onChange={id => { setUpdateId(id); const template = templates.find(item => item.id === id); if (template) { setName(template.name); setDescription(template.description); setVisibility(template.visibility || "private"); } }} options={templates.map(item => ({ label: item.name, value: item.id }))} />
                <Input autoFocus placeholder="为这个流程起个名字" aria-label="模板名称" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
                <Checkbox checked={visibility === "public"} onChange={event => setVisibility(event.target.checked ? "public" : "private")}>公开模板，其他用户可查看并插入其中的节点和素材</Checkbox>
                <Input.TextArea placeholder="描述用途和使用步骤（可选）" aria-label="模板描述" maxLength={300} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
                <div className={styles.formFooter}><Checkbox checked={keepMedia} onChange={(event) => setKeepMedia(event.target.checked)}>保留图片、视频和音频素材</Checkbox><Button htmlType="submit" type="primary" loading={saving} disabled={!name.trim()}>保存模板</Button></div>
            </form> : null}
            <Input allowClear className={styles.search} prefix={<Search className="size-4" />} placeholder="搜索工作流名称或用途" aria-label="搜索工作流模板" value={query} onChange={(event) => setQuery(event.target.value)} />
            {tab !== "builtin" && error ? <p role="alert" className="mb-3 text-xs text-red-500">{error}</p> : null}
            {tab !== "builtin" && loading ? <div className="py-8 text-center"><Spin /></div> : <div className={`${styles.cards} thin-scrollbar`}>
                {pagination.items.map((item) => <article key={item.id} className={styles.card}>
                    <WorkflowPreview template={item} />
                    <div className={styles.cardContent}>
                        <div className={styles.cardTitle}><h3 title={item.name}>{item.name}</h3>{!item.builtin && item.owned !== false ? <Popconfirm title="删除这个模板？" description="已插入画布的节点会继续保留。" okText="删除" cancelText="取消" onConfirm={async () => { try { await deleteCanvasWorkflowTemplate(userId, item.id); setTemplates((current) => current.filter((value) => value.id !== item.id)); setPublicTemplates((current) => current.filter(value => value.id !== item.id)); } catch { message.error("删除失败，请重试"); } }}><button type="button" className={styles.delete} aria-label={`删除模板 ${item.name}`}><Trash2 className="size-3.5" /></button></Popconfirm> : null}</div>
                        <p className={styles.cardDescription}>{item.description || "复用保存的节点、参数和内部连线。"}</p>
                        <div className={styles.cardMeta}><Blocks /><span>{item.nodes.length} 个节点</span><span className="mx-1">·</span><span>{item.connections.length} 条连线</span></div>
                        <Button className={styles.cardInsert} icon={<ArrowRight className="size-3.5" />} onClick={() => { onInsert(item); onClose(); }}>插入画布</Button>
                    </div>
                </article>)}
                {!items.length ? <div className={styles.empty}><FolderOpen /><span>{query ? "没有找到匹配的模板" : "还没有保存的工作流"}</span><span className="text-[11px] opacity-70">{query ? "换个名称或用途试试" : "选中画布节点，保存你的第一个模板"}</span></div> : null}
            </div>}
        </div>
        <div className={styles.libraryFooter}>
            <ListPagination compact current={pagination.page} pageSize={pagination.pageSize} total={items.length} onChange={pagination.onChange} pageSizeOptions={[6, 12, 24]} label="工作流模板分页" />
            <p className={styles.storageNote}><Monitor className="size-3" />模板已保存到云端；当前浏览器旧模板将在读取时迁移。</p>
        </div>
    </CanvasToolDialog>;
}

function WorkflowPreview({ template }: { template: CanvasWorkflowTemplate }) {
    const theme = useCanvasTheme();
    const nodes = template.nodes.slice(0, 24);
    const bounds = canvasNodesBounds(nodes);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const margin = Math.max(bounds.width, bounds.height, 1) * .08;
    return <div className={styles.preview} aria-hidden="true">
        <svg viewBox={`${bounds.x - margin} ${bounds.y - margin} ${Math.max(1, bounds.width + margin * 2)} ${Math.max(1, bounds.height + margin * 2)}`}>
            {template.connections.slice(0, 60).map((edge) => {
                const a = byId.get(edge.source.nodeId)?.frame, b = byId.get(edge.target.nodeId)?.frame;
                if (!a || !b) return null;
                const x1 = a.position.x + a.width, y1 = a.position.y + a.height / 2, x2 = b.position.x, y2 = b.position.y + b.height / 2;
                return <path key={edge.id} d={`M${x1},${y1} C${(x1+x2)/2},${y1} ${(x1+x2)/2},${y2} ${x2},${y2}`} fill="none" stroke={theme.node.activeStroke} strokeWidth={1.2} vectorEffect="non-scaling-stroke" opacity={.5} />;
            })}
            {nodes.map((node) => {
                const { position, width, height } = node.frame;
                const size = Math.min(width, height) * .28;
                const Icon = node.kind === "text" ? FileText : node.kind === "image" ? ImageIcon : node.kind === "video" ? Video : node.kind === "audio" ? AudioLines : Blocks;
                return <g key={node.id}><rect x={position.x} y={position.y} width={width} height={height} rx={Math.min(width, height) * .12} fill={theme.node.panel} stroke={theme.node.stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" /><Icon x={position.x + (width-size)/2} y={position.y + (height-size)/2} width={size} height={size} color={theme.node.activeStroke} strokeWidth={1.5} /></g>;
            })}
        </svg>
        <span className={styles.previewBadge}>{template.builtin ? "推荐流程" : "我的工作流"}</span>
    </div>;
}
