import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode } from "../constants";
import { applyReversedImagePrompt, createReversedPromptNode, matchesReverseImageSource } from "./canvas-image-reverse";

const result = { promptZh: "一只橘猫坐在窗前", promptEn: "An orange cat sitting by a window", negativePrompt: "blur, distortion", style: "摄影" };
function image() {
    const node = createImageNode({ id: "source", position: { x: 50, y: 80 } });
    node.content = { source: "https://example.com/cat.png", storageKey: "image:cat" };
    node.generation.prompt = "原提示词";
    node.generation.model = "keep-my-model";
    node.execution = { phase: "succeeded", taskId: "existing-image-task" };
    return node;
}
test("回填只更新提示词，保留原图、模型和任务状态，原快照可供撤销", () => {
    const source = image();
    const updated = applyReversedImagePrompt(source, source, result.promptZh);
    assert.equal(updated.generation.prompt, result.promptZh);
    assert.equal(updated.generation.model, source.generation.model);
    assert.equal(updated.content, source.content);
    assert.equal(updated.execution, source.execution);
    assert.equal(source.generation.prompt, "原提示词");
});
test("分析期间图片被替换、删除或开始生成时不能回填或创建错误关联", () => {
    const source = image();
    for (const current of [undefined, { ...source, content: { ...source.content, source: "https://example.com/new.png" } }, { ...source, execution: { phase: "running" as const } }]) {
        assert.equal(matchesReverseImageSource(current, source), false);
        assert.throws(() => applyReversedImagePrompt(current, source, "新的提示词"), /更换或移除/);
        assert.throws(() => createReversedPromptNode(current ? [current] : [], source, result, "text", "edge"), /更换或移除/);
    }
});
test("并发修改过的提示词不会被旧分析覆盖", () => {
    const source = image();
    assert.throws(() => applyReversedImagePrompt({ ...source, generation: { ...source.generation, prompt: "用户新输入" } }, source, result.promptZh), /已被修改/);
});
test("结果创建为不重叠的相连文本节点，保留中英、负面词及章节", () => {
    const source = image(); source.dramaChapterId = "chapter-1";
    const first = createReversedPromptNode([source], source, result, "text-1", "edge-1");
    const second = createReversedPromptNode([source, first.node], source, result, "text-2", "edge-2");
    assert.equal(first.connection.source.nodeId, source.id);
    assert.equal(first.connection.target.nodeId, "text-1");
    assert.equal(first.node.dramaChapterId, "chapter-1");
    for (const text of [result.promptZh, result.promptEn, result.negativePrompt]) assert.ok(first.node.content.text.includes(text));
    assert.notDeepEqual(second.node.frame.position, first.node.frame.position);
    assert.equal(source.content.source, "https://example.com/cat.png");
});
