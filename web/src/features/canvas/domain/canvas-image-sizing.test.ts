import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode } from "../constants";
import { fitCanvasImageToSource } from "./canvas-image-sizing";

function fixture() {
    const node = createImageNode({ id: "shot-image", position: { x: 100, y: 200 } });
    node.content.source = "https://media.example.test/shot.webp";
    node.frame.width = 510;
    node.frame.height = 360;
    return node;
}

test("竖图等比收进已有510×360节点，保持中心且不扩展占用边界", () => {
    const node = fixture();
    const fitted = fitCanvasImageToSource(node, node.content.source, 900, 1600);
    assert.equal(fitted.frame.width, 202.5);
    assert.equal(fitted.frame.height, 360);
    assert.deepEqual(fitted.frame.position, { x: 253.75, y: 200 });
    assert.equal(fitted.frame.naturalWidth, 900);
    assert.equal(fitted.frame.naturalHeight, 1600);
    assert.equal(fitted.content, node.content);
    assert.equal(fitted.execution, node.execution);
    assert.equal(fitted.generation, node.generation);
    assert.equal(node.frame.width, 510);
});

test("横图等比收进已有节点，原图较小时也保留画布展示尺度", () => {
    for (const [width, height] of [[1920, 1080], [16, 9]]) {
        const node = fixture();
        const fitted = fitCanvasImageToSource(node, node.content.source, width, height);
        assert.equal(fitted.frame.width, 510);
        assert.equal(fitted.frame.height, 286.875);
        assert.deepEqual(fitted.frame.position, { x: 100, y: 236.5625 });
    }
});

test("用户等比放大后再次加载不重置展示尺寸，重复加载保持幂等", () => {
    const node = fixture();
    const fitted = fitCanvasImageToSource(node, node.content.source, 900, 1600);
    assert.equal(fitCanvasImageToSource(fitted, node.content.source, 900, 1600), fitted);
    const enlarged = { ...fitted, frame: { ...fitted.frame, width: 720, height: 1280, position: { x: -5, y: 37 } } };
    assert.equal(fitCanvasImageToSource(enlarged, node.content.source, 900, 1600), enlarged);
    const negligibleDifference = { ...enlarged, frame: { ...enlarged.frame, width: 720.00001 } };
    assert.equal(fitCanvasImageToSource(negligibleDifference, node.content.source, 900, 1600), negligibleDifference);
});

test("自由缩放只保存自然尺寸，保留用户设置的框与位置", () => {
    const node = fixture();
    node.frame.freeResize = true;
    const fitted = fitCanvasImageToSource(node, node.content.source, 900, 1600);
    assert.deepEqual(fitted.frame, { ...node.frame, naturalWidth: 900, naturalHeight: 1600 });
    assert.equal(fitted.frame.position, node.frame.position);
    assert.equal(fitCanvasImageToSource(fitted, node.content.source, 900, 1600), fitted);
});

test("连续替换竖图、横图、竖图保留显示长边与中心，不逐次缩小", () => {
    const node = fixture();
    const portrait = fitCanvasImageToSource(node, node.content.source, 900, 1600);
    const landscapeSource = "https://media.example.test/landscape.webp";
    const landscapeNode = { ...portrait, content: { ...portrait.content, source: landscapeSource } };
    const landscape = fitCanvasImageToSource(landscapeNode, landscapeSource, 1600, 900);
    assert.equal(landscape.frame.width, 360);
    assert.equal(landscape.frame.height, 202.5);
    assert.deepEqual(landscape.frame.position, { x: 175, y: 278.75 });
    const portraitSource = "https://media.example.test/portrait.webp";
    const restored = fitCanvasImageToSource({ ...landscape, content: { ...landscape.content, source: portraitSource } }, portraitSource, 900, 1600);
    assert.equal(restored.frame.width, portrait.frame.width);
    assert.equal(restored.frame.height, portrait.frame.height);
    assert.deepEqual(restored.frame.position, portrait.frame.position);
    assert.equal(fitCanvasImageToSource(restored, portraitSource, 900, 1600), restored);
});

test("自由比例切回等比时收进用户框，后续加载与切换保持稳定", () => {
    const node = fixture();
    node.frame.freeResize = true;
    const loaded = fitCanvasImageToSource(node, node.content.source, 900, 1600);
    const fixed = fitCanvasImageToSource({ ...loaded, frame: { ...loaded.frame, freeResize: false } }, node.content.source, 900, 1600);
    assert.equal(fixed.frame.width, 202.5);
    assert.equal(fixed.frame.height, 360);
    assert.deepEqual(fixed.frame.position, { x: 253.75, y: 200 });
    assert.equal(fitCanvasImageToSource(fixed, node.content.source, 900, 1600), fixed);
    const toggledAgain = { ...fixed, frame: { ...fixed.frame, freeResize: false } };
    assert.equal(fitCanvasImageToSource(toggledAgain, node.content.source, 900, 1600), toggledAgain);
});

test("过期地址、无效自然尺寸和批次根节点不改变画布数据", () => {
    const node = fixture();
    assert.equal(fitCanvasImageToSource(node, "https://media.example.test/previous.webp", 900, 1600), node);
    assert.equal(fitCanvasImageToSource(node, "", 900, 1600), node);
    for (const invalid of [0, -1, NaN, Infinity]) {
        assert.equal(fitCanvasImageToSource(node, node.content.source, invalid, 1600), node);
        assert.equal(fitCanvasImageToSource(node, node.content.source, 900, invalid), node);
    }
    const batchRoot = { ...node, grouping: { ...node.grouping, isRoot: true } };
    assert.equal(fitCanvasImageToSource(batchRoot, node.content.source, 900, 1600), batchRoot);
});
