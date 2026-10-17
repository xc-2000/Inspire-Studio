import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createStoryboardNode } from "../constants";
import type { CanvasStoryboardShot } from "../types";
import { readCanvasDramaImageInputs } from "./canvas-drama-image-inputs";

function fixture() {
    const board = createStoryboardNode({ id: "board", position: { x: 0, y: 0 } });
    board.storyboard.assets = [{ id: "actor", kind: "character", name: "林岁安", description: "", image: { source: "/actor.webp" } }];
    const shot: CanvasStoryboardShot = { id: "shot", shotNumber: 1, assetIds: ["actor"], durationSeconds: 5, visualDescription: "", shotSize: "中景", lightingAtmosphere: "", dialogueVoiceover: "", soundEffect: "", cameraMovement: "", finalPrompt: "林岁安在院子里" };
    board.storyboard.shots = [shot];
    const image = createImageNode({ id: "image", position: { x: 0, y: 0 } });
    image.dramaStoryboardId = board.id;
    image.dramaShotId = shot.id;
    return { board, shot, image };
}

test("普通短剧镜头使用当前角色资产，已出图也不以旧分镜脸替代", () => {
    const { board, image } = fixture();
    image.content.source = "/old-face.webp";
    const result = readCanvasDramaImageInputs(image, [board, image], "当前镜头提示词");
    assert.ok(result);
    assert.deepEqual(result.references.map(reference => reference.dataUrl), ["/actor.webp"]);
    assert.match(result.prompt, /^当前镜头提示词/);
    assert.match(result.prompt, /图片1 = 角色「林岁安」/);
});

test("蒙版编辑绕过短剧图号注入，保留局部重绘的原图选择规则", () => {
    const { board, image } = fixture();
    image.generation.editMask = { id: "mask", name: "局部蒙版", type: "image/png", dataUrl: "data:image/png;base64,eA==" };
    const before = JSON.stringify(image);
    assert.equal(readCanvasDramaImageInputs(image, [board, image], "只修改衣服"), null);
    assert.equal(readCanvasDramaImageInputs(image, [], "只修改衣服"), null, "蒙版操作无需依赖旧分镜是否仍存在");
    assert.equal(JSON.stringify(image), before);
});

test("设定图绕过角色镜头图号注入，沿用上游设定图输入", () => {
    const { board, image } = fixture();
    image.generation.settingGraph = { id: 1, name: "角色三视图", targetType: "canvasSettingGraph", systemPrompt: "按上游图片生成三视图" };
    assert.equal(readCanvasDramaImageInputs(image, [board, image], "生成角色设定图"), null);
    assert.equal(readCanvasDramaImageInputs(image, [], "生成角色设定图"), null);
});

test("普通镜头缺失分镜或角色图依旧明确拦截", () => {
    const { board, image, shot } = fixture();
    assert.throws(() => readCanvasDramaImageInputs(image, [], "重试"), /分镜已移除/);
    board.storyboard.shots = [];
    assert.throws(() => readCanvasDramaImageInputs(image, [board], "重试"), /镜头已从分镜中移除/);
    board.storyboard.shots = [shot];
    delete board.storyboard.assets[0].image;
    assert.throws(() => readCanvasDramaImageInputs(image, [board], "重试"), /缺少参考图/);
});

test("普通画布图片和不存在的节点不触发短剧绑定", () => {
    const image = createImageNode({ id: "normal", position: { x: 0, y: 0 } });
    assert.equal(readCanvasDramaImageInputs(image, [image], "普通生成"), null);
    assert.equal(readCanvasDramaImageInputs(undefined, [], "普通生成"), null);
});
