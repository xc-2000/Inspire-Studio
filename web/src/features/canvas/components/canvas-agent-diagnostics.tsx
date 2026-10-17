"use client";
import { useState } from "react";
import { Button, Collapse, Input, Select, Table, Tag } from "antd";
import type { CanvasDocument } from "../types";
import { canvasNodesBounds } from "../domain/canvas-arrangement";
import { nodeOutput } from "../domain/canvas-workflow-run";

export function CanvasSnapshotGraph({ document, onSelect }: { document: CanvasDocument; onSelect?: (id: string) => void }) {
    const nodes = document.scene.nodes.filter((node) => node.kind !== "background"),
        bounds = canvasNodesBounds(nodes);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const margin = Math.max(bounds.width, bounds.height, 100) * 0.08;
    return (
        <svg
            role="img"
            aria-label="画布节点与连线只读预览"
            className="mb-4 h-52 w-full rounded-xl border border-current/10 bg-current/5"
            viewBox={`${bounds.x - margin} ${bounds.y - margin} ${Math.max(bounds.width, 100) + 2 * margin} ${Math.max(bounds.height, 100) + 2 * margin}`}
        >
            {document.scene.connections.map((edge) => {
                const a = byId.get(edge.source.nodeId),
                    b = byId.get(edge.target.nodeId);
                return a && b ? (
                    <path
                        key={edge.id}
                        d={`M ${a.frame.position.x + a.frame.width} ${a.frame.position.y + a.frame.height / 2} L ${b.frame.position.x} ${b.frame.position.y + b.frame.height / 2}`}
                        stroke="currentColor"
                        strokeOpacity=".3"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                    />
                ) : null;
            })}
            {nodes.map((node) => (
                <g
                    key={node.id}
                    role={onSelect ? "button" : undefined}
                    tabIndex={onSelect ? 0 : undefined}
                    onClick={() => onSelect?.(node.id)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") onSelect?.(node.id);
                    }}
                    style={{ cursor: onSelect ? "pointer" : "default" }}
                    aria-label={node.title}
                >
                    <rect
                        x={node.frame.position.x}
                        y={node.frame.position.y}
                        width={node.frame.width}
                        height={node.frame.height}
                        rx={18}
                        fill={node.execution.phase === "failed" ? "#ef444430" : nodeOutput(node) ? "#14b8a630" : "#64748b30"}
                        stroke="currentColor"
                        strokeOpacity=".25"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                    />
                    <text x={node.frame.position.x + node.frame.width / 2} y={node.frame.position.y + node.frame.height / 2} textAnchor="middle" fill="currentColor" fontSize={Math.max(18, Math.min(node.frame.width / 11, node.frame.height / 5))}>
                        {node.title.slice(0, 16)}
                    </text>
                </g>
            ))}
        </svg>
    );
}

export function CanvasAgentDiagnostics({ document, locate }: { document: CanvasDocument; locate: (id: string) => void }) {
    const [query, setQuery] = useState(""),
        [sessionId, setSessionId] = useState(document.conversation.activeSessionId || document.conversation.sessions[0]?.id);
    const nodes = document.scene.nodes.filter((node) => node.kind !== "background" && `${node.title} ${node.id} ${"generation" in node ? JSON.stringify(node.generation) : ""}`.toLowerCase().includes(query.toLowerCase()));
    const session = document.conversation.sessions.find((item) => item.id === sessionId);
    const events = (session?.messages || []).filter((message) => message.role === "tool" || message.role === "error" || message.references?.length || message.detail);
    return (
        <div className="space-y-4">
            <CanvasSnapshotGraph document={document} onSelect={locate} />
            <Input.Search allowClear aria-label="搜索诊断节点" placeholder="搜索节点、模型或提示词" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Table
                size="small"
                rowKey="id"
                dataSource={nodes}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                columns={[
                    {
                        title: "节点",
                        render: (_, node) => (
                            <Button type="link" onClick={() => locate(node.id)}>
                                {node.title}
                            </Button>
                        ),
                    },
                    {
                        title: "状态",
                        render: (_, node) => (
                            <Tag color={node.execution.phase === "failed" ? "red" : nodeOutput(node) ? "green" : "default"}>
                                {node.execution.phase === "failed" ? "失败" : node.execution.phase === "running" ? "运行中" : nodeOutput(node) ? "已有结果" : "待生成"}
                            </Tag>
                        ),
                    },
                    { title: "模型", render: (_, node) => ("generation" in node ? node.generation.model || "使用当前配置" : "—") },
                    { title: "错误", render: (_, node) => <span className="text-xs text-red-500">{node.execution.errorMessage}</span> },
                ]}
                expandable={{
                    expandedRowRender: (node) => (
                        <div className="space-y-3 text-xs">
                            <p>任务 ID：{node.execution.taskId || "尚未创建"}</p>
                            <p>
                                直接上游：
                                {document.scene.connections
                                    .filter((edge) => edge.target.nodeId === node.id)
                                    .map((edge) => document.scene.nodes.find((n) => n.id === edge.source.nodeId)?.title || edge.source.nodeId)
                                    .join("、") || "无"}
                            </p>
                            <p>节点保存的提示词与参考素材</p>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">
                                {JSON.stringify("generation" in node ? node.generation : node.kind === "videoComposition" ? node.composition : node.kind === "text" ? node.content : null, null, 2)}
                            </pre>
                            <p>当前输出</p>
                            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all">{nodeOutput(node) || "暂无"}</pre>
                        </div>
                    ),
                }}
            />
            <h3 className="text-sm font-semibold">Agent 工具与引用记录</h3>
            <Select className="w-full" aria-label="诊断会话" placeholder="选择会话" value={sessionId} onChange={setSessionId} options={document.conversation.sessions.map((s) => ({ label: s.title, value: s.id }))} />
            <Table
                size="small"
                rowKey="id"
                dataSource={events}
                pagination={{ pageSize: 6, hideOnSinglePage: true }}
                columns={[
                    { title: "类型", dataIndex: "role", render: (role) => (role === "tool" ? "工具" : role === "error" ? "错误" : "引用") },
                    { title: "记录", render: (_, item) => item.title || item.text.slice(0, 100) },
                ]}
                expandable={{
                    expandedRowRender: (item) => (
                        <Collapse
                            items={[
                                {
                                    key: "details",
                                    label: "查看记录内容",
                                    children: <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ text: item.text, detail: item.detail, references: item.references }, null, 2)}</pre>,
                                },
                            ]}
                        />
                    ),
                }}
            />
            <p className="text-xs opacity-60">展示当前画布保存的参数、工具回执与引用记录；渠道内部改写后的提示词以渠道实际返回的信息为准。</p>
        </div>
    );
}
