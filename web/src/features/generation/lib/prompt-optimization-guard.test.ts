import assert from "node:assert/strict";
import test from "node:test";

import { looksLikeConversationalReply, readOptimizedPrompt } from "./prompt-optimization-guard.ts";

test("模型返回对话式回复时必须判为无效", () => {
    // 复现真实事故：模型自述能力并罗列多个版本后反问用户。
    const reply = "我没有图像生成能力，能交付的是**可直接投喂生成模型的结构化提示词**（中英双语 + 负向 + 参数）。"
        + "以下已按你给的风格1做融合：\n\n---\n\n## 一、主提示词\n\n**主体**\n黑神话悟空的灵猴形象……\n\n"
        + "需要我按其中一种方向再出一版，或者补一份分镜？";
    assert.equal(looksLikeConversationalReply(reply), true);
    assert.equal(readOptimizedPrompt({ content: reply }), "");
});

test("反问用户意图的回复必须判为无效", () => {
    const reply = "这是一句没有工程上下文的描述。你是想让我基于它做什么？比如：\n\n- 写代码\n- 生成图片 prompt";
    assert.equal(looksLikeConversationalReply(reply), true);
    assert.equal(readOptimizedPrompt({ content: reply }), "");
});

test("正常的提示词正文必须保留", () => {
    const prompt = "一只橘色短毛猫在阳光下的木地板上来回奔跑，毛发随动作轻微摆动，镜头缓慢跟随，暖色调自然光，画面稳定清晰";
    assert.equal(looksLikeConversationalReply(prompt), false);
    assert.equal(readOptimizedPrompt({ content: prompt }), prompt);
});

test("单个Markdown标记不足以判定为对话式回复", () => {
    assert.equal(looksLikeConversationalReply("**主体** 一只猫在跑，镜头缓慢推进"), false);
    assert.equal(looksLikeConversationalReply("## 一、主提示词\n\n**主体**\n一只猫"), true);
    assert.equal(looksLikeConversationalReply(""), false);
});

test("带代码块包裹的提示词应剥离围栏后保留", () => {
    const prompt = "海边日落，海浪缓慢拍打礁石，镜头自左向右横移";
    assert.equal(readOptimizedPrompt({ content: "```\n" + prompt + "\n```" }), prompt);
});

test("结果缺失或非字符串时明确返回空", () => {
    assert.equal(readOptimizedPrompt(null), "");
    assert.equal(readOptimizedPrompt({}), "");
    assert.equal(readOptimizedPrompt({ content: 123 }), "");
    assert.equal(readOptimizedPrompt({ content: "   " }), "");
});

test("超长结果判为无效，避免把整篇方案填进提示词框", () => {
    assert.equal(looksLikeConversationalReply("画面描述".repeat(1200)), true);
});
