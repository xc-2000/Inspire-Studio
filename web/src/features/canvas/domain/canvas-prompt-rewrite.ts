import type { CanvasImageNode, CanvasNode, CanvasVideoNode } from "../types";

type MediaNode = CanvasImageNode | CanvasVideoNode;

/** One deliberate rewrite and one retry, with the node reserved across both stages. */
export async function rewriteAndRetryCanvasNode<Result>(options: {
    nodeId: string;
    getNode: (id: string) => CanvasNode | undefined;
    acquire: (id: string) => AbortController | null;
    release: (id: string, controller: AbortController) => void;
    rewrite: (type: "image" | "video", prompt: string, failureReason: string, signal: AbortSignal) => Promise<string>;
    commit: (node: MediaNode) => void;
    retry: (node: MediaNode, controller: AbortController) => Promise<Result>;
    onRewriting: (id: string, value: boolean) => void;
}): Promise<Result> {
    const original = options.getNode(options.nodeId);
    if (!original || (original.kind !== "image" && original.kind !== "video") || original.execution.phase !== "failed") {
        throw new Error("仅支持改写生成失败的图片或视频节点");
    }
    if (original.kind === "image" && original.grouping.isRoot) throw new Error("请在具体的失败图片上改写，已成功的图片会保留");
    const prompt = original.generation.prompt.trim();
    if (!prompt) throw new Error("此节点没有已保存的提示词，请先填写提示词");
    const generationSnapshot = JSON.stringify(original.generation);
    const controller = options.acquire(original.id);
    if (!controller) throw new Error("当前节点正在处理，请等待任务完成");
    options.onRewriting(original.id, true);
    try {
        controller.signal.throwIfAborted();
        const rewritten = (await options.rewrite(original.kind, prompt, original.execution.errorMessage || "生成失败", controller.signal)).trim();
        controller.signal.throwIfAborted();
        if (!rewritten || rewritten === prompt) throw new Error("没有得到新的有效提示词，未重新提交生成，请手动调整后重试");
        const current = options.getNode(original.id);
        if (!current || current.kind !== original.kind || (current.kind !== "image" && current.kind !== "video")) throw new Error("节点已删除或类型已变化，已停止重新生成");
        if (current.execution.phase !== "failed" || JSON.stringify(current.generation) !== generationSnapshot) {
            throw new Error("节点配置已变化，已保留你的修改，请重新点击改写");
        }
        const next = { ...current, generation: { ...current.generation, prompt: rewritten } } as MediaNode;
        options.commit(next);
        controller.signal.throwIfAborted();
        return await options.retry(next, controller);
    } finally {
        options.onRewriting(original.id, false);
        options.release(original.id, controller);
    }
}
