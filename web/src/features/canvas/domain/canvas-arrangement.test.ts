import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundNode, createImageNode, createTextNode } from "../constants";
import { arrangeCanvasNodes, expandCanvasSelection } from "./canvas-arrangement";
import type { CanvasConnection, CanvasNode } from "../types";

const text = (id: string, x: number, y: number, width = 100) => ({ ...createTextNode({ id, position: { x, y } }), frame: { position: { x, y }, width, height: 80 } });
const edge = (source: string, target: string): CanvasConnection => ({ id: `${source}-${target}`, source: { nodeId: source }, target: { nodeId: target } });
const ids = (nodes: CanvasNode[]) => new Set(nodes.map((node) => node.id));

test("DAG 布局保持依赖从左到右，不移动未选中节点或改变执行数据", () => {
    const a = text("a", 500, 150), b = text("b", 40, 40, 180), c = text("c", 0, 5), outside = text("outside", 900, 900);
    a.execution = { phase: "running", taskId: "live-task" };
    const result = arrangeCanvasNodes([c, b, a, outside], [edge("a", "b"), edge("b", "c")], new Set(["a", "b", "c"]), "dag");
    const positions = new Map(result.map((node) => [node.id, node.frame.position.x]));
    assert.ok(positions.get("a")! + a.frame.width < positions.get("b")!);
    assert.ok(positions.get("b")! + b.frame.width < positions.get("c")!);
    assert.equal(result[3], outside);
    assert.equal(result.find((node) => node.id === "a")!.execution, a.execution);
    assert.equal(a.frame.position.x, 500);
});

test("环路和重复连线不会造成死循环或重叠，排列结果稳定", () => {
    const nodes = [text("a", 0, 0), text("b", 0, 0), text("c", 0, 0)];
    const edges = [edge("a", "b"), edge("a", "b"), edge("b", "a")];
    const result = arrangeCanvasNodes(nodes, edges, ids(nodes), "dag");
    const positions = result.map((node) => `${node.frame.position.x}:${node.frame.position.y}`);
    assert.equal(new Set(positions).size, 3);
    assert.deepEqual(arrangeCanvasNodes(result, edges, ids(result), "dag"), result);
});

test("混合尺寸节点按实际边界对齐，等距分布不会产生负间距", () => {
    const nodes = [text("a", 0, 0, 100), text("b", 50, 70, 200), text("c", 120, 150, 80)];
    const aligned = arrangeCanvasNodes(nodes, [], ids(nodes), "right");
    assert.deepEqual(aligned.map((node) => node.frame.position.x + node.frame.width), [250, 250, 250]);
    const spaced = arrangeCanvasNodes(nodes, [], ids(nodes), "distributeX");
    assert.ok(spaced[1].frame.position.x >= spaced[0].frame.position.x + spaced[0].frame.width);
    assert.ok(spaced[2].frame.position.x >= spaced[1].frame.position.x + spaced[1].frame.width);
    assert.equal(arrangeCanvasNodes(nodes, [], new Set(["a"]), "right"), nodes);
    assert.equal(arrangeCanvasNodes(nodes, [], new Set(["a", "b"]), "distributeX"), nodes);
});

test("背景板和图片批次作为整体排列，成员不被重复移动", () => {
    const member = text("member", 50, 60);
    const board = { ...createBackgroundNode({ id: "board", position: { x: 0, y: 0 }, memberNodeIds: [member.id] }), frame: { position: { x: 0, y: 0 }, width: 400, height: 300 } };
    const outside = text("outside", 900, 500);
    const nodes = [board, member, outside];
    const result = arrangeCanvasNodes(nodes, [], ids(nodes), "bottom");
    const boardMove = result[0].frame.position.y - board.frame.position.y;
    assert.equal(result[1].frame.position.y - member.frame.position.y, boardMove);
    assert.equal(result[1].frame.position.x - result[0].frame.position.x, 50);
    const batch = createImageNode({ id: "root", position: { x: 0, y: 0 } });
    batch.grouping = { ...batch.grouping, isRoot: true, childIds: ["child"] };
    const child = createImageNode({ id: "child", position: { x: 20, y: 20 } });
    assert.deepEqual([...expandCanvasSelection([batch, child], new Set(["root", "missing"]))], ["root", "child"]);
});
