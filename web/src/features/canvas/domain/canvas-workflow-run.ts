import type { CanvasNode, CanvasConnection, CanvasDocument } from "../types";

export type WorkflowStep = {
    nodeId: string;
    title: string;
    kind: string;
    status: "pending" | "running" | "succeeded" | "failed" | "reused" | "skipped";
    startedAt?: string;
    endedAt?: string;
    input?: string;
    output?: string;
    error?: string;
    result?: unknown;
};
export type WorkflowRun = { status: "running" | "succeeded" | "failed" | "stopped"; startedAt: string; endedAt?: string; snapshot: CanvasDocument; steps: WorkflowStep[]; force: boolean; parentRunId?: string };
export type WorkflowCondition = { sourceId: string; operator: "contains" | "notContains" | "hasOutput"; value: string };

export function nodeOutput(node?: CanvasNode): string {
    if (!node) return "";
    if (node.kind === "text") return node.content.text;
    if (node.kind === "image" || node.kind === "video" || node.kind === "audio") return node.content.storageKey || node.content.source;
    if (node.kind === "videoComposition") return node.execution.phase === "succeeded" ? node.composition.resultVideoNodeId || "" : "";
    if (node.kind === "storyboard") return node.storyboard.shots.length ? JSON.stringify(node.storyboard.shots) : "";
    return "";
}

/** Topological order includes prerequisites; never guesses around a broken/cyclic graph. */
export function compileCanvasWorkflow(nodes: CanvasNode[], connections: CanvasConnection[], targets: string[] = []): CanvasNode[] {
    const byId = new Map(nodes.filter((node) => node.kind !== "background").map((node) => [node.id, node]));
    const ids = new Set<string>();
    const visiting = new Set<string>();
    const ordered: CanvasNode[] = [];
    const visit = (id: string) => {
        if (ids.has(id)) return;
        if (visiting.has(id)) throw new Error("工作流包含循环连线，请断开循环后再执行");
        const node = byId.get(id);
        if (!node) throw new Error(`工作流引用了不存在的节点：${id}`);
        visiting.add(id);
        connections.filter((edge) => edge.target.nodeId === id).forEach((edge) => visit(edge.source.nodeId));
        if (node.workflowCondition) visit(node.workflowCondition.sourceId);
        visiting.delete(id);
        ids.add(id);
        ordered.push(node);
    };
    const selected = targets.flatMap((id) => {
        const node = nodes.find((n) => n.id === id);
        return node?.kind === "background" ? node.memberNodeIds : [id];
    });
    (selected.length ? selected : [...byId.keys()]).forEach(visit);
    if (!ordered.length) throw new Error("画布里还没有可运行的节点");
    return ordered;
}

export function workflowInput(node: CanvasNode, nodes: CanvasNode[], connections: CanvasConnection[]): string {
    return JSON.stringify({
        kind: node.kind,
        settings: "generation" in node ? node.generation : node.kind === "videoComposition" ? node.composition : null,
        condition: node.workflowCondition,
        inputs: connections.filter((edge) => edge.target.nodeId === node.id).map((edge) => ({ id: edge.source.nodeId, value: nodeOutput(nodes.find((n) => n.id === edge.source.nodeId)) })),
    });
}

export function workflowConditionPasses(condition: WorkflowCondition | undefined, nodes: CanvasNode[]): boolean {
    if (!condition) return true;
    const value = nodeOutput(nodes.find((node) => node.id === condition.sourceId));
    if (condition.operator === "hasOutput") return Boolean(value);
    if (!condition.value.trim()) throw new Error("条件关键词不能为空");
    return condition.operator === "contains" ? value.includes(condition.value) : !value.includes(condition.value);
}

export async function executeCanvasWorkflow(options: {
    run: WorkflowRun;
    nodes: () => CanvasNode[];
    connections: () => CanvasConnection[];
    signal: AbortSignal;
    execute: (node: CanvasNode, signal: AbortSignal) => Promise<unknown>;
    checkpoint: (run: WorkflowRun) => Promise<void>;
    prior?: WorkflowRun;
}) {
    const { run, signal } = options;
    const blocked = new Set<string>();
    try {
        await options.checkpoint(run);
        for (const step of run.steps) {
            signal.throwIfAborted();
            const nodes = options.nodes(),
                connections = options.connections();
            const node = nodes.find((item) => item.id === step.nodeId);
            if (!node) throw new Error(`节点已删除：${step.title}`);
            const incoming = connections.filter((edge) => edge.target.nodeId === node.id).map((edge) => edge.source.nodeId);
            if (node.workflowCondition) incoming.push(node.workflowCondition.sourceId);
            if (incoming.some((id) => blocked.has(id)) || !workflowConditionPasses(node.workflowCondition, nodes)) {
                step.status = "skipped";
                step.error = "条件不满足或上游分支已跳过";
                blocked.add(node.id);
                await options.checkpoint(run);
                continue;
            }
            step.input = workflowInput(node, nodes, connections);
            const previous = options.prior?.steps.find((item) => item.nodeId === node.id);
            const output = nodeOutput(node);
            const unchanged = previous && ["succeeded", "reused"].includes(previous.status) && previous.input === step.input && previous.output === output && output;
            const source = Boolean(output) && (node.kind === "audio" || node.kind === "text" || (!incoming.length && (node.kind === "image" || node.kind === "video") && !node.generation.prompt.trim()));
            if (source || (!run.force && output && (!options.prior || unchanged))) {
                step.status = "reused";
                step.output = output;
                step.endedAt = new Date().toISOString();
                await options.checkpoint(run);
                continue;
            }
            step.status = "running";
            step.startedAt = new Date().toISOString();
            await options.checkpoint(run);
            try {
                step.result = await options.execute(node, signal);
                signal.throwIfAborted();
                step.output = nodeOutput(options.nodes().find((item) => item.id === node.id));
                const completedNode = options.nodes().find((item) => item.id === node.id);
                if (completedNode) step.input = workflowInput(completedNode, options.nodes(), options.connections());
                step.status = "succeeded";
            } catch (error) {
                step.status = "failed";
                step.error = error instanceof Error ? error.message : "节点执行失败";
                throw error;
            } finally {
                step.endedAt = new Date().toISOString();
            }
            await options.checkpoint(run);
        }
        run.status = "succeeded";
    } catch (error) {
        run.status = signal.aborted ? "stopped" : "failed";
        if (!run.steps.some((step) => step.status === "failed")) {
            const step = run.steps.find((step) => step.status === "running" || step.status === "pending");
            if (step) {
                step.status = "failed";
                step.error = error instanceof Error ? error.message : "工作流中断";
            }
        }
    }
    run.endedAt = new Date().toISOString();
    await options.checkpoint(run);
    return run;
}
