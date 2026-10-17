import { createImageNode, createTextNode, createVideoNode, createVideoCompositionNode } from "../constants";
import type { CanvasConnection, CanvasNode, CanvasPoint } from "../types";
import { canvasNodesBounds, expandCanvasSelection } from "./canvas-arrangement";

export interface CanvasSubgraph { nodes: CanvasNode[]; connections: CanvasConnection[] }
export interface CanvasWorkflowTemplate extends CanvasSubgraph { id: string; name: string; description: string; createdAt: string; builtin?: boolean; revision?: number; visibility?: "private" | "public"; owned?: boolean }

export function captureCanvasSubgraph(nodes: CanvasNode[], connections: CanvasConnection[], selected: ReadonlySet<string>): CanvasSubgraph {
    const ids = expandCanvasSelection(nodes, selected);
    return {
        nodes: nodes.filter((node) => ids.has(node.id)).map((node) => structuredClone(node)),
        connections: connections.filter((edge) => ids.has(edge.source.nodeId) && ids.has(edge.target.nodeId)).map((edge) => structuredClone(edge)),
    };
}

/** A copy receives fresh identities and never inherits another node's running task. */
export function instantiateCanvasSubgraph(graph: CanvasSubgraph, position: CanvasPoint, createId: () => string, suffix = ""): CanvasSubgraph {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const idMap = new Map(graph.nodes.map((node) => [node.id, createId()]));
    const bounds = canvasNodesBounds(graph.nodes);
    const remapList = (ids: string[]) => ids.flatMap((id) => idMap.has(id) ? [idMap.get(id)!] : []);
    const remapPrompt = (text: string) => text.split(/(\s+)/).map((part) => idMap.get(part) || part).join("");
    const nodes = graph.nodes.map((original): CanvasNode => {
        const node = structuredClone(original);
        node.id = idMap.get(original.id)!;
        if (node.workflowCondition) {
            const sourceId = idMap.get(node.workflowCondition.sourceId);
            if (sourceId) node.workflowCondition = { ...node.workflowCondition, sourceId };
            else delete node.workflowCondition;
        }
        node.title = `${node.title}${suffix}`;
        node.frame.position = { x: original.frame.position.x - bounds.x + position.x, y: original.frame.position.y - bounds.y + position.y };
        const hasResult = node.kind === "text" ? Boolean(node.content.text) : node.kind === "image" || node.kind === "video" || node.kind === "audio" ? Boolean(node.content.source) : false;
        node.execution = { phase: hasResult ? "succeeded" : "idle" };
        if (node.kind === "image") {
            node.grouping = { ...node.grouping, childIds: remapList(node.grouping.childIds), rootId: node.grouping.rootId ? idMap.get(node.grouping.rootId) : undefined, primaryImageId: node.grouping.primaryImageId ? idMap.get(node.grouping.primaryImageId) : undefined };
            node.grouping.isRoot = node.grouping.isRoot && node.grouping.childIds.length > 0;
            node.generation.prompt = remapPrompt(node.generation.prompt);
        }
        if (node.kind === "video") node.generation.prompt = remapPrompt(node.generation.prompt);
        if (node.kind === "background") node.memberNodeIds = remapList(node.memberNodeIds);
        if (node.kind === "videoComposition") node.composition = { ...node.composition, resultVideoNodeId: undefined, inputVideoNodeIds: remapList(node.composition.inputVideoNodeIds), editingSourceNodeIds: node.composition.editingSourceNodeIds ? remapList(node.composition.editingSourceNodeIds) : undefined };
        if (node.kind === "storyboard") delete node.storyboard.assetGeneration;
        return node;
    });
    const connections = graph.connections.flatMap((edge) => {
        const source = idMap.get(edge.source.nodeId), target = idMap.get(edge.target.nodeId);
        // Composition output edges belong to the original execution, not the copied workflow.
        if (!source || !target || byId.get(edge.source.nodeId)?.kind === "videoComposition") return [];
        return [{ ...structuredClone(edge), id: createId(), source: { ...edge.source, nodeId: source }, target: { ...edge.target, nodeId: target } }];
    });
    return { nodes, connections };
}

export function createCanvasWorkflowTemplate(graph: CanvasSubgraph, id: string, name: string, description: string, keepMedia: boolean): CanvasWorkflowTemplate {
    let nextId = 0;
    const clean = instantiateCanvasSubgraph(graph, { x: 0, y: 0 }, () => `template-node-${++nextId}`);
    if (!keepMedia) clean.nodes.forEach((node) => {
        if (node.kind === "image" || node.kind === "video" || node.kind === "audio") {
            node.content = node.kind === "audio" ? { source: "", waveformPeaks: [] } : { source: "" };
            node.execution = { phase: "idle" };
        }
        if (node.kind === "image" || node.kind === "video") {
            if (node.kind === "image") delete node.generation.editMask;
            node.generation.references = [];
            node.generation.referenceObjectStorages = [];
            if (node.kind === "video") { node.generation.videoReferences = []; node.generation.audioReferences = []; node.generation.videoReferenceObjectStorages = []; }
        }
        if (node.kind === "storyboard") {
            node.storyboard.assets.forEach((asset) => { delete asset.image; });
            node.storyboard.shots.forEach((shot) => { delete shot.image; delete shot.video; });
        }
    });
    return { ...clean, id, name: name.trim().slice(0, 60), description: description.trim().slice(0, 300), createdAt: new Date().toISOString() };
}

export function builtInCanvasWorkflows(): CanvasWorkflowTemplate[] {
    const text = (id: string, title: string, content: string, y = 0) => createTextNode({ id, title, text: content, position: { x: 0, y } });
    const image = (id: string, y = 0) => createImageNode({ id, title: "关键画面", position: { x: 720, y } });
    const video = (id: string, y = 0, fromImage = false) => {
        const node = createVideoNode({ id, title: "视频镜头", position: { x: 1350, y } });
        node.generation.videoGenerationMode = fromImage ? "image-to-video" : "text-to-video";
        return node;
    };
    const edge = (source: string, target: string): CanvasConnection => ({ id: `${source}-${target}`, source: { nodeId: source, portId: "right" }, target: { nodeId: target, portId: "left" } });
    const make = (id: string, name: string, description: string, graph: CanvasSubgraph): CanvasWorkflowTemplate => ({ id, name, description, ...graph, createdAt: "2026-09-26", builtin: true });
    return [
        make("builtin-image", "文字 → 图片", "修改文本描述，再从图片节点生成画面。", { nodes: [text("brief", "画面描述", "在这里写下主体、场景、构图与光线。"), image("image")], connections: [edge("brief", "image")] }),
        make("builtin-video", "关键帧 → 视频", "先生成或上传关键画面，再由视频节点读取参考图。", { nodes: [text("brief", "创作描述", "描述主体、画面风格，以及视频中的动作和运镜。"), image("image"), video("video", 0, true)], connections: [edge("brief", "image"), edge("image", "video"), edge("brief", "video")] }),
        make("builtin-composition", "双镜头 → 合成", "分别生成两个镜头，再在合成节点中设置顺序并合成。", { nodes: [text("brief1", "镜头一", "远景交代环境，镜头缓慢推进。"), video("video1"), text("brief2", "镜头二", "主体特写，延续前一镜头的光线和色彩。", 720), video("video2", 720), createVideoCompositionNode({ id: "composition", title: "镜头合成", position: { x: 2100, y: 200 } })], connections: [edge("brief1", "video1"), edge("brief2", "video2"), edge("video1", "composition"), edge("video2", "composition")] }),
    ];
}
