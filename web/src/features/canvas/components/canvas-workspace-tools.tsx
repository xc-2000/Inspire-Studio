"use client";
import { useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Collapse, Input, Pagination, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, Tooltip } from "antd";
import { History, Play, Square, Workflow } from "lucide-react";
import { nanoid } from "nanoid";
import { useCanvasStore } from "../stores/use-canvas-store";
const saveCanvasProject = (document: CanvasDocument) => useCanvasStore.getState().saveSnapshot(document);
import type { CanvasDocument, CanvasNode } from "../types";
import { compileCanvasWorkflow, executeCanvasWorkflow, type WorkflowRun, type WorkflowCondition } from "../domain/canvas-workflow-run";
import { listWorkspaceRecords, saveWorkspaceRecord, type WorkspaceRecord } from "../services/canvas-workspace";
import { CanvasToolDialog } from "./canvas-tool-dialog";
import { CanvasAgentDiagnostics, CanvasSnapshotGraph } from "./canvas-agent-diagnostics";
import styles from "./canvas-editor.module.css";

type Props = {
    projectId: string;
    snapshot: () => CanvasDocument;
    selectedIds: () => string[];
    execute: (node: CanvasNode, signal: AbortSignal) => Promise<unknown>;
    restore: (document: CanvasDocument) => Promise<void>;
    configure: (nodeId: string, condition?: WorkflowCondition) => void;
    locate: (id: string) => void;
};
const labels: Record<string, string> = { pending: "待执行", running: "执行中", succeeded: "成功", failed: "失败", reused: "复用结果", skipped: "条件跳过", stopped: "已停止" };

export function CanvasWorkspaceTools(props: Props) {
    const { message } = App.useApp();
    const current = useRef(props);
    current.current = props;
    const controller = useRef<AbortController | null>(null);
    const [open, setOpen] = useState(false),
        [tab, setTab] = useState("run"),
        [force, setForce] = useState(false);
    const [busy, setBusy] = useState(false),
        [loading, setLoading] = useState(false);
    const [run, setRun] = useState<WorkflowRun | null>(null);
    const [rows, setRows] = useState<WorkspaceRecord<CanvasDocument | WorkflowRun>[]>([]);
    const [page, setPage] = useState(1),
        [total, setTotal] = useState(0),
        [query, setQuery] = useState("");
    const [versionName, setVersionName] = useState("");
    const [conditionNode, setConditionNode] = useState<string>(),
        [conditionSource, setConditionSource] = useState<string>();
    const [operator, setOperator] = useState<WorkflowCondition["operator"]>("contains"),
        [keyword, setKeyword] = useState("");
    const [error, setError] = useState("");
    const [snapshotPreview, setSnapshotPreview] = useState<CanvasDocument | null>(null);
    const mounted = useRef(true);
    const requestSequence = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            controller.current?.abort();
            requestSequence.current++;
        };
    }, [props.projectId]);
    const refresh = async () => {
        if (tab === "run" || tab === "agent") return;
        const sequence = ++requestSequence.current;
        setLoading(true);
        setError("");
        try {
            const result = await listWorkspaceRecords<CanvasDocument | WorkflowRun>(tab === "versions" ? "version" : "run", { projectId: props.projectId, page, pageSize: 10, search: query });
            if (sequence === requestSequence.current) {
                setRows(result.items);
                setTotal(result.total);
            }
        } catch (error) {
            if (sequence === requestSequence.current) setError(error instanceof Error ? error.message : "读取失败");
        } finally {
            if (sequence === requestSequence.current) setLoading(false);
        }
    };
    useEffect(() => {
        if (open) void refresh();
    }, [open, tab, page, query, props.projectId]);
    const checkpointVersion = async (title: string) => {
        const data = current.current.snapshot();
        await saveCanvasProject(data);
        return saveWorkspaceRecord({ id: nanoid(), kind: "version", projectId: props.projectId, title, data });
    };
    const start = async (targets: string[], previous?: WorkspaceRecord<WorkflowRun>) => {
        if (controller.current) return;
        const control = new AbortController();
        controller.current = control;
        setBusy(true);
        setError("");
        setTab("run");
        let record: WorkspaceRecord<WorkflowRun> | undefined;
        let journalQueue = Promise.resolve();
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
            const snapshot = current.current.snapshot();
            const projectId = props.projectId;
            let lastSnapshot = snapshot;
            const readSnapshot = () => {
                if (mounted.current && current.current.projectId === projectId) lastSnapshot = current.current.snapshot();
                return lastSnapshot;
            };
            const ordered = compileCanvasWorkflow(snapshot.scene.nodes, snapshot.scene.connections, targets);
            if (snapshot.scene.nodes.some((node) => node.execution.phase === "running")) throw new Error("画布仍有生成中的节点，请等待任务完成再运行工作流");
            await saveCanvasProject(snapshot);
            const data: WorkflowRun = {
                status: "running",
                startedAt: new Date().toISOString(),
                snapshot,
                force: previous ? false : force,
                parentRunId: previous?.id,
                steps: ordered.map((node) => ({ nodeId: node.id, title: node.title, kind: node.kind, status: "pending" })),
            };
            const id = nanoid();
            const checkpoint = (value: WorkflowRun) => {
                if (mounted.current) setRun(structuredClone(value));
                const copy = structuredClone(value);
                const document = structuredClone(readSnapshot());
                journalQueue = journalQueue.then(async () => {
                    record = await saveWorkspaceRecord({ id, kind: "run", projectId, title: `${snapshot.identity.title} · ${new Date(data.startedAt).toLocaleString()}`, revision: record?.revision, data: copy });
                    if (mounted.current && current.current.projectId === projectId) await saveCanvasProject(document);
                });
                return journalQueue;
            };
            heartbeat = setInterval(() => {
                if (data.status === "running") void checkpoint(data).catch(() => control.abort());
            }, 20_000);
            await executeCanvasWorkflow({
                run: data,
                nodes: () => readSnapshot().scene.nodes,
                connections: () => readSnapshot().scene.connections,
                signal: control.signal,
                execute: (node, signal) => {
                    signal.throwIfAborted();
                    return current.current.execute(node, signal);
                },
                checkpoint,
                prior: previous?.data,
            });
            message[data.status === "succeeded" ? "success" : "warning"](data.status === "succeeded" ? "工作流已完成" : "工作流已停止，可查看记录后续跑");
        } catch (error) {
            setError(error instanceof Error ? error.message : "工作流启动失败");
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            controller.current = null;
            setBusy(false);
        }
    };
    const nodes = open ? props.snapshot().scene.nodes.filter((node) => node.kind !== "background") : [];
    return (
        <>
            <Tooltip title="工作流、执行记录与历史版本">
                <Button type="text" className={styles.labelAction} aria-label="工作流运行与历史" onClick={() => setOpen(true)} icon={<Workflow className="size-4" />}>
                    {busy ? "运行中" : "工作流"}
                </Button>
            </Tooltip>
            {open && (
                <CanvasToolDialog title="创作工作流" subtitle="连接创作步骤，保留每次执行与修改的记录。" icon={<Workflow />} width={1000} onClose={() => setOpen(false)}>
                    <div className="max-h-[72vh] overflow-auto p-5">
                        <Tabs
                            activeKey={tab}
                            onChange={(value) => {
                                setTab(value);
                                setPage(1);
                                setQuery("");
                            }}
                            items={[
                                { key: "run", label: "运行与诊断" },
                                { key: "agent", label: "Agent 诊断" },
                                { key: "history", label: "执行记录" },
                                { key: "versions", label: "历史版本" },
                            ]}
                        />
                        {error && (
                            <p className="mb-3 text-sm text-red-500" role="alert">
                                {error}
                            </p>
                        )}
                        {tab === "agent" ? (
                            <CanvasAgentDiagnostics document={props.snapshot()} locate={props.locate} />
                        ) : tab === "run" ? (
                            <>
                                <Space wrap className="mb-4">
                                    <Button type="primary" icon={<Play size={14} />} disabled={busy} onClick={() => void start([])}>
                                        运行整个画布
                                    </Button>
                                    <Button disabled={busy || !props.selectedIds().length} onClick={() => void start(props.selectedIds())}>
                                        执行到选中节点
                                    </Button>
                                    <Button disabled={!busy} icon={<Square size={14} />} onClick={() => controller.current?.abort()}>
                                        停止运行
                                    </Button>
                                    <Checkbox disabled={busy} checked={force} onChange={(event) => setForce(event.target.checked)}>
                                        重新生成已有结果
                                    </Checkbox>
                                </Space>
                                <p className="mb-4 text-xs opacity-65">文本与音频作为输入；默认复用已有素材。关闭面板后继续运行，关闭画布会中断后续步骤，可从执行记录恢复。</p>
                                <Collapse
                                    items={[
                                        {
                                            key: "condition",
                                            label: "设置节点运行条件",
                                            children: (
                                                <Space direction="vertical" className="w-full">
                                                    <Select
                                                        className="w-full"
                                                        placeholder="选择需要设置条件的节点"
                                                        value={conditionNode}
                                                        onChange={(id) => {
                                                            setConditionNode(id);
                                                            const rule = nodes.find((node) => node.id === id)?.workflowCondition;
                                                            setConditionSource(rule?.sourceId);
                                                            setOperator(rule?.operator || "contains");
                                                            setKeyword(rule?.value || "");
                                                        }}
                                                        options={nodes.map((node) => ({ label: node.title, value: node.id }))}
                                                    />
                                                    <Space wrap>
                                                        <Select
                                                            style={{ width: 180 }}
                                                            placeholder="条件来源节点"
                                                            value={conditionSource}
                                                            onChange={setConditionSource}
                                                            options={nodes.filter((node) => node.id !== conditionNode).map((node) => ({ label: node.title, value: node.id }))}
                                                        />
                                                        <Select
                                                            value={operator}
                                                            onChange={setOperator}
                                                            options={[
                                                                { value: "contains", label: "包含文本" },
                                                                { value: "notContains", label: "不包含文本" },
                                                                { value: "hasOutput", label: "已有输出" },
                                                            ]}
                                                        />
                                                        {operator !== "hasOutput" && <Input aria-label="条件关键词" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="关键词" />}
                                                    </Space>
                                                    <Space>
                                                        <Button
                                                            disabled={busy || !conditionNode || !conditionSource || (operator !== "hasOutput" && !keyword.trim())}
                                                            onClick={() => {
                                                                props.configure(conditionNode!, { sourceId: conditionSource!, operator, value: keyword });
                                                                message.success("运行条件已保存到画布");
                                                            }}
                                                        >
                                                            保存条件
                                                        </Button>
                                                        <Button
                                                            disabled={busy || !conditionNode}
                                                            onClick={() => {
                                                                props.configure(conditionNode!, undefined);
                                                                message.success("已移除条件");
                                                            }}
                                                        >
                                                            移除条件
                                                        </Button>
                                                    </Space>
                                                </Space>
                                            ),
                                        },
                                    ]}
                                />
                                {run ? (
                                    <>
                                        <div className="my-4">
                                            <Tag color={run.status === "succeeded" ? "green" : run.status === "failed" ? "red" : "blue"}>{labels[run.status]}</Tag>
                                            <span className="text-xs opacity-60">{new Date(run.startedAt).toLocaleString()}</span>
                                        </div>
                                        <Table
                                            size="small"
                                            rowKey="nodeId"
                                            dataSource={run.steps}
                                            pagination={{ pageSize: 8, hideOnSinglePage: true }}
                                            columns={[
                                                {
                                                    title: "节点",
                                                    dataIndex: "title",
                                                    render: (title, step) => (
                                                        <Button type="link" onClick={() => props.locate(step.nodeId)}>
                                                            {title}
                                                        </Button>
                                                    ),
                                                },
                                                { title: "状态", dataIndex: "status", render: (status) => <Tag color={status === "failed" ? "red" : status === "succeeded" ? "green" : "default"}>{labels[status]}</Tag> },
                                                { title: "耗时", render: (_, step) => (step.startedAt ? `${Math.max(0, Math.round(((step.endedAt ? Date.parse(step.endedAt) : Date.now()) - Date.parse(step.startedAt)) / 1000))} 秒` : "—") },
                                                { title: "说明", dataIndex: "error" },
                                            ]}
                                            expandable={{
                                                expandedRowRender: (step) => (
                                                    <div className="space-y-3 text-xs">
                                                        <p>输入参数与上游引用</p>
                                                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{step.input || "尚未执行"}</pre>
                                                        <p>执行结果</p>
                                                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(step.result ?? step.output ?? null, null, 2)}</pre>
                                                    </div>
                                                ),
                                            }}
                                        />
                                    </>
                                ) : (
                                    <div className="py-12 text-center text-sm opacity-60">从整个画布开始，或选中一个节点执行到这里。</div>
                                )}
                            </>
                        ) : (
                            <>
                                <Space wrap className="mb-4">
                                    <Input.Search
                                        allowClear
                                        aria-label="搜索记录"
                                        placeholder="搜索记录名称"
                                        value={query}
                                        onChange={(event) => {
                                            setPage(1);
                                            setQuery(event.target.value);
                                        }}
                                    />
                                    {tab === "versions" && (
                                        <>
                                            <Input aria-label="版本名称" placeholder="版本名称（可选）" value={versionName} maxLength={120} onChange={(event) => setVersionName(event.target.value)} />
                                            <Button
                                                disabled={busy || loading}
                                                icon={<History size={14} />}
                                                onClick={async () => {
                                                    setLoading(true);
                                                    try {
                                                        await checkpointVersion(versionName.trim() || `手动版本 ${new Date().toLocaleString()}`);
                                                        setVersionName("");
                                                        await refresh();
                                                        message.success("版本已保存");
                                                    } catch (e) {
                                                        setError(e instanceof Error ? e.message : "保存失败");
                                                    } finally {
                                                        setLoading(false);
                                                    }
                                                }}
                                            >
                                                保存当前版本
                                            </Button>
                                        </>
                                    )}
                                </Space>
                                <Spin spinning={loading}>
                                    <div className="space-y-2">
                                        {rows.map((item) => (
                                            <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-current/10 p-4">
                                                <div>
                                                    <p className="text-sm font-medium">{item.title}</p>
                                                    <p className="mt-1 text-xs opacity-60">
                                                        {new Date(item.createdAt).toLocaleString()}
                                                        {item.kind === "run" ? ` · ${labels[(item.data as WorkflowRun).status] || "已中断"}` : ""}
                                                    </p>
                                                </div>
                                                <Space>
                                                    {item.kind === "run" ? (
                                                        <>
                                                            <Button
                                                                onClick={() => {
                                                                    setRun(item.data as WorkflowRun);
                                                                    setTab("run");
                                                                }}
                                                            >
                                                                查看诊断
                                                            </Button>
                                                            <Button
                                                                disabled={busy}
                                                                onClick={() =>
                                                                    void start(
                                                                        (item.data as WorkflowRun).steps.map((step) => step.nodeId),
                                                                        item as WorkspaceRecord<WorkflowRun>,
                                                                    )
                                                                }
                                                            >
                                                                续跑
                                                            </Button>
                                                            <Button onClick={() => setSnapshotPreview((item.data as WorkflowRun).snapshot)}>执行快照</Button>
                                                        </>
                                                    ) : (
                                                        <Popconfirm
                                                            title="恢复这个版本？"
                                                            description="会先保存当前画布为一个新版本。"
                                                            disabled={busy}
                                                            onConfirm={async () => {
                                                                try {
                                                                    await checkpointVersion(`恢复前备份 ${new Date().toLocaleString()}`);
                                                                    await props.restore(item.data as CanvasDocument);
                                                                    message.success("版本已恢复");
                                                                    setOpen(false);
                                                                } catch (e) {
                                                                    setError(e instanceof Error ? e.message : "恢复失败");
                                                                }
                                                            }}
                                                        >
                                                            <Button disabled={busy}>恢复版本</Button>
                                                        </Popconfirm>
                                                    )}
                                                </Space>
                                            </div>
                                        ))}
                                        {!rows.length && !loading && <p className="py-10 text-center text-sm opacity-60">暂无记录</p>}
                                    </div>
                                </Spin>
                                <Pagination className="mt-5" current={page} total={total} pageSize={10} showSizeChanger={false} onChange={setPage} />
                            </>
                        )}
                    </div>
                </CanvasToolDialog>
            )}
            {snapshotPreview && (
                <CanvasToolDialog title="执行时画布快照" subtitle="只读查看本次执行开始时的节点、参数和连线。" icon={<History />} onClose={() => setSnapshotPreview(null)}>
                    <div className="max-h-[65vh] overflow-auto p-5">
                        <CanvasSnapshotGraph document={snapshotPreview} />
                        <p className="mb-4 text-sm">
                            {snapshotPreview.identity.title} · {snapshotPreview.scene.nodes.length} 个节点 · {snapshotPreview.scene.connections.length} 条连线
                        </p>
                        <Collapse items={snapshotPreview.scene.nodes.map((node) => ({ key: node.id, label: `${node.title} · ${node.kind}`, children: <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(node, null, 2)}</pre> }))} />
                        <details className="mt-4">
                            <summary>连线关系</summary>
                            <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(snapshotPreview.scene.connections, null, 2)}</pre>
                        </details>
                    </div>
                </CanvasToolDialog>
            )}
        </>
    );
}
