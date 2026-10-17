import assert from "node:assert/strict";
import test from "node:test";
import { createImageNode, createVideoNode } from "../constants.ts";
import { applyCanvasNodeAttributes, updateCanvasNodeExecution } from "./canvas-node.ts";
import { rewriteAndRetryCanvasNode } from "./canvas-prompt-rewrite.ts";
import { createCanvasGenerationRequestRegistry } from "../services/canvas-generation-request-registry.ts";
import type { CanvasNode } from "../types";

function fixture(kind: "image" | "video" = "image") {
    const base = kind === "image" ? createImageNode({ id: "shot", position: { x: 30, y: 60 } }) : createVideoNode({ id: "shot", position: { x: 30, y: 60 } });
    let node: CanvasNode | undefined = updateCanvasNodeExecution(applyCanvasNodeAttributes(base, {
        status: "error", prompt: "两只狗休息，尾巴摆动", model: "configured-model", references: ["reference-key"],
        seconds: "10", videoGenerationMode: "image-to-video", generationStyleIds: [42],
    }), { errorMessage: "safety_violations=[sexual]" });
    const registry = createCanvasGenerationRequestRegistry();
    const submitted: CanvasNode[] = [];
    const loading: boolean[] = [];
    const options = {
        nodeId: "shot", getNode: () => node,
        acquire: (id: string) => registry.isRunning(id) ? null : registry.start(id, id, id, new AbortController()),
        release: (id: string, controller: AbortController) => { registry.finish(id, controller); },
        rewrite: async () => "两只成年宠物狗在客厅地毯上安静休息，自然放松的日常场景。",
        commit: (value: CanvasNode) => { node = value; },
        retry: async (value: CanvasNode) => { submitted.push(value); return "generated"; },
        onRewriting: (_id: string, value: boolean) => { loading.push(value); },
    };
    return { options, submitted, loading, registry, get: () => node!, set: (n: CanvasNode | undefined) => { node = n; } };
}

for (const kind of ["image", "video"] as const) test(`${kind}: 改写后仅在原节点重试一次并保留模型参考图和位置`, async () => {
    const f = fixture(kind), before = f.get();
    assert.equal(await rewriteAndRetryCanvasNode(f.options), "generated");
    assert.equal(f.submitted.length, 1);
    const after = f.submitted[0] as typeof before & { generation: { prompt: string } };
    assert.equal(after.id, before.id);
    assert.equal(after.frame, before.frame);
    assert.ok("content" in after && "content" in before);
    assert.equal(after.content, before.content);
    assert.deepEqual({ ...after.generation, prompt: "original" }, { ...("generation" in before ? before.generation : {}), prompt: "original" });
    assert.deepEqual(f.loading, [true, false]);
    assert.equal(f.registry.isRunning("shot"), false);
});

test("连续点击在改写期间只提交一份任务，锁覆盖重新生成", async () => {
    const f = fixture(); let resolve!: (value: string) => void;
    const run = rewriteAndRetryCanvasNode({ ...f.options, rewrite: () => new Promise<string>(r => { resolve = r; }), retry: async node => {
        assert.equal(f.registry.isRunning("shot"), true); return f.options.retry(node);
    } });
    await assert.rejects(rewriteAndRetryCanvasNode(f.options), /正在处理/);
    resolve("两只宠物狗在地毯上休息。"); await run;
    assert.equal(f.submitted.length, 1);
});

test("取消改写或删除节点后不提交图片生成", async () => {
    const f = fixture();
    await assert.rejects(rewriteAndRetryCanvasNode({ ...f.options, rewrite: async () => {
        f.registry.stopForNodeIds(new Set(["shot"])); f.set(undefined); return "新的提示词";
    } }), { name: "AbortError" });
    assert.equal(f.submitted.length, 0); assert.equal(f.registry.isRunning("shot"), false);
});

test("改写期间手动修改提示词时不覆盖新输入", async () => {
    const f = fixture();
    await assert.rejects(rewriteAndRetryCanvasNode({ ...f.options, rewrite: async () => {
        f.set(applyCanvasNodeAttributes(f.get(), { prompt: "用户的新提示词" })); return "过时的改写结果";
    } }), /配置已变化/);
    assert.equal(f.submitted.length, 0); assert.equal((f.get() as ReturnType<typeof createImageNode>).generation.prompt, "用户的新提示词");
});

test("改写失败或返回原文时保留节点，不自动生成或循环重试", async () => {
    for (const response of ["", "两只狗休息，尾巴摆动", new Error("文本渠道不可用")]) {
        const f = fixture(), original = f.get();
        await assert.rejects(rewriteAndRetryCanvasNode({ ...f.options, rewrite: async () => { if (response instanceof Error) throw response; return response; } }));
        assert.equal(f.get(), original); assert.equal(f.submitted.length, 0); assert.equal(f.registry.isRunning("shot"), false);
    }
});
