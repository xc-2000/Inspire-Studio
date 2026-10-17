import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundNode, createImageNode, createStoryboardNode, createVideoNode, createVideoCompositionNode } from "../constants";
import { builtInCanvasWorkflows, captureCanvasSubgraph, createCanvasWorkflowTemplate, instantiateCanvasSubgraph } from "./canvas-workflow-template";
import type { CanvasConnection } from "../types";

const edge = (source: string, target: string): CanvasConnection => ({ id: `${source}-${target}`, source: { nodeId: source, portId: "right" }, target: { nodeId: target, portId: "left" } });

test("选区复制保留内部连线和图片批次，隔离旧 ID 与运行任务", () => {
    const root = createImageNode({ id: "root", position: { x: 20, y: 30 } });
    const child = createImageNode({ id: "child", position: { x: 80, y: 100 } });
    root.grouping = { ...root.grouping, isRoot: true, childIds: [child.id], primaryImageId: child.id };
    child.grouping.rootId = root.id;
    child.execution = { phase: "running", taskId: "do-not-resume" };
    const video = createVideoNode({ id: "video", position: { x: 500, y: 0 } });
    video.generation.prompt = "使用 child 保持构图";
    const selected = captureCanvasSubgraph([root, child, video], [edge("child", "video"), edge("outside", "root")], new Set([root.id, video.id]));
    assert.equal(selected.nodes.length, 3);
    assert.equal(selected.connections.length, 1);
    let counter = 0;
    const result = instantiateCanvasSubgraph(selected, { x: 1000, y: 2000 }, () => `copy-${++counter}`);
    const [newRoot, newChild, newVideo] = result.nodes;
    assert.equal(newChild.execution.phase, "idle");
    assert.equal(newChild.execution.taskId, undefined);
    assert.equal(newRoot.kind === "image" && newRoot.grouping.childIds[0], newChild.id);
    assert.equal(newChild.kind === "image" && newChild.grouping.rootId, newRoot.id);
    assert.equal(newVideo.kind === "video" && newVideo.generation.prompt, `使用 ${newChild.id} 保持构图`);
    assert.equal(result.connections[0].source.nodeId, newChild.id);
    assert.equal(result.connections[0].target.nodeId, newVideo.id);
    assert.equal(child.execution.taskId, "do-not-resume");
    assert.equal(newChild.frame.position.x - newRoot.frame.position.x, 60);
});

test("背景板模板闭包包含成员，重复插入身份独立且不带历史结果关联", () => {
    const a = createVideoNode({ id: "a", position: { x: 40, y: 40 } });
    const composition = createVideoCompositionNode({ id: "mix", position: { x: 400, y: 40 } });
    composition.composition = { inputVideoNodeIds: [a.id], resultVideoNodeId: "result" };
    const board = createBackgroundNode({ id: "board", position: { x: 0, y: 0 }, memberNodeIds: [a.id, composition.id] });
    const graph = captureCanvasSubgraph([board, a, composition], [edge("a", "mix"), edge("mix", "result")], new Set([board.id]));
    let counter = 0;
    const first = instantiateCanvasSubgraph(graph, { x: 0, y: 0 }, () => `copy-${++counter}`);
    const second = instantiateCanvasSubgraph(graph, { x: 2000, y: 0 }, () => `copy-${++counter}`);
    assert.equal(first.nodes.length, 3);
    assert.equal(first.nodes[0].kind === "background" && first.nodes[0].memberNodeIds[0], first.nodes[1].id);
    assert.equal(first.nodes[2].kind === "videoComposition" && first.nodes[2].composition.resultVideoNodeId, undefined);
    assert.equal(first.nodes[2].kind === "videoComposition" && first.nodes[2].composition.inputVideoNodeIds[0], first.nodes[1].id);
    assert.equal(new Set([...first.nodes, ...second.nodes].map((node) => node.id)).size, 6);
});

test("仅保存结构时清理素材、任务与分镜临时状态，保留提示词和设置", () => {
    const image = createImageNode({ id: "img", position: { x: 0, y: 0 } });
    image.content = { source: "https://test.invalid/result.png", storageKey: "secret-media-key" };
    image.generation.prompt = "纸船";
    image.generation.references = ["https://test.invalid/reference.png"];
    const storyboard = createStoryboardNode({ id: "story", position: { x: 400, y: 0 } });
    const graph = { nodes: [image, storyboard], connections: [] };
    const template = createCanvasWorkflowTemplate(graph, "template", "  纸船流程  ", "步骤说明", false);
    assert.equal(template.name, "纸船流程");
    assert.equal(template.nodes[0].kind === "image" && template.nodes[0].content.source, "");
    assert.equal(template.nodes[0].kind === "image" && template.nodes[0].generation.prompt, "纸船");
    assert.doesNotMatch(JSON.stringify(template), /test\.invalid|secret-media-key/);
    assert.equal(image.content.source, "https://test.invalid/result.png");
    const withMedia = createCanvasWorkflowTemplate(graph, "template2", "有素材", "", true);
    assert.equal(withMedia.nodes[0].kind === "image" && withMedia.nodes[0].content.source, image.content.source);
});

test("推荐模板节点与连线完整、图生视频模式明确，不携带模型和任务", () => {
    const templates = builtInCanvasWorkflows();
    assert.equal(templates.length, 3);
    for (const template of templates) {
        const ids = new Set(template.nodes.map((node) => node.id));
        assert.ok(template.connections.every((connection) => ids.has(connection.source.nodeId) && ids.has(connection.target.nodeId)));
        assert.ok(template.nodes.every((node) => !node.execution.taskId));
        for (let i = 0; i < template.nodes.length; i++) {
            for (const other of template.nodes.slice(i + 1)) {
                const a = template.nodes[i].frame, b = other.frame;
                const overlaps = a.position.x < b.position.x + b.width && b.position.x < a.position.x + a.width && a.position.y < b.position.y + b.height && b.position.y < a.position.y + a.height;
                assert.equal(overlaps, false, `${template.name} nodes must not overlap`);
            }
        }
    }
    const frameVideo = templates[1].nodes.find((node) => node.kind === "video");
    assert.equal(frameVideo?.generation.videoGenerationMode, "image-to-video");
});
