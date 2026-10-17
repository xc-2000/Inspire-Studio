/** Each server composition receives at most 20 sources. Repeated sources are intentional cuts. */
export const DRAMA_ASSEMBLY_BATCH_SIZE = 20;

export type DramaAssemblyMedia = {
    storageKey: string;
    url?: string;
    durationMilliseconds?: number;
    width?: number;
    height?: number;
    [key: string]: unknown;
};

export type DramaAssemblyBatch = {
    id: string;
    level: number;
    index: number;
    sourceKeys: string[];
    phase: "pending" | "submitting" | "running" | "failed" | "succeeded";
    taskId?: string;
    result?: DramaAssemblyMedia;
    error?: string;
};

export type DramaAssemblyState = {
    version: 1;
    sourceKeys: string[];
    phase: "running" | "failed" | "succeeded";
    batches: DramaAssemblyBatch[];
    result?: DramaAssemblyMedia;
    error?: string;
};

/** Only throw this when the server has positively reported a failed/canceled task. */
export class DramaAssemblyTaskFailedError extends Error {
    constructor(message: string) { super(message); this.name = "DramaAssemblyTaskFailedError"; }
}

export type DramaAssemblyOptions = {
    checkpoint?: DramaAssemblyState;
    submit: (sourceKeys: string[]) => Promise<{ id: string }>;
    wait: (taskId: string) => Promise<DramaAssemblyMedia>;
    /** Persist this checkpoint before the runner proceeds to another request. */
    onState: (state: DramaAssemblyState) => void | Promise<void>;
    signal?: AbortSignal;
};

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key, index) => key === b[index]);
const copyState = (state: DramaAssemblyState): DramaAssemblyState => ({
    ...state, sourceKeys: [...state.sourceKeys], result: state.result ? { ...state.result } : undefined,
    batches: state.batches.map(batch => ({ ...batch, sourceKeys: [...batch.sourceKeys], result: batch.result ? { ...batch.result } : undefined })),
});
const readError = (error: unknown) => error instanceof Error ? error.message : "成片合成失败";

/**
 * Merge ordered shots into a single film, composing completed batches again when necessary.
 * Save onState in the document and pass it as checkpoint on reload. A saved running task is
 * polled again, never submitted again; completed batches are reused. Abort only stops this
 * runner and does not cancel or discard the server task. Known failed tasks may be resubmitted.
 * A submission interrupted before its task ID is saved is deliberately not auto-resubmitted:
 * without server idempotency its outcome is ambiguous and a second submission could duplicate it.
 */
export async function runDramaAssembly(sourceKeys: string[], options: DramaAssemblyOptions): Promise<DramaAssemblyState> {
    if (!sourceKeys.length || sourceKeys.some(key => typeof key !== "string" || !key.trim())) throw new Error("请先补齐所有镜头的视频存储信息");
    const keys = sourceKeys.map(key => key.trim());
    const checkpoint = options.checkpoint;
    let state: DramaAssemblyState = checkpoint?.version === 1 && sameKeys(checkpoint.sourceKeys, keys)
        ? copyState(checkpoint)
        : { version: 1, sourceKeys: keys, phase: "running", batches: [] };
    const publish = async () => { await options.onState(copyState(state)); };
    const checkAbort = () => { if (options.signal?.aborted) throw new DOMException("成片处理已暂停，已提交任务可继续恢复", "AbortError"); };
    const replaceBatch = (batch: DramaAssemblyBatch) => {
        state = { ...state, batches: [...state.batches.filter(item => item.id !== batch.id), batch].sort((a, b) => a.level - b.level || a.index - b.index) };
    };
    if (state.phase === "succeeded" && state.result?.storageKey?.trim()) return copyState(state);
    state = { ...state, phase: "running", error: undefined, result: undefined };
    await publish();
    try {
        let inputs = keys.map(storageKey => ({ storageKey }) as DramaAssemblyMedia);
        let level = 0;
        while (inputs.length > 1) {
            const outputs: DramaAssemblyMedia[] = [];
            for (let start = 0, index = 0; start < inputs.length; start += DRAMA_ASSEMBLY_BATCH_SIZE, index++) {
                checkAbort();
                const sources = inputs.slice(start, start + DRAMA_ASSEMBLY_BATCH_SIZE);
                // A remainder of one already is a completed clip, so no server request is needed.
                if (sources.length === 1) { outputs.push(sources[0]); continue; }
                const batchKeys = sources.map(media => media.storageKey);
                const id = `${level}:${index}`;
                const saved = state.batches.find(batch => batch.id === id && sameKeys(batch.sourceKeys, batchKeys));
                let batch: DramaAssemblyBatch = saved || { id, level, index, sourceKeys: batchKeys, phase: "pending" };
                if (batch.phase === "succeeded" && batch.result?.storageKey?.trim()) {
                    outputs.push(batch.result);
                    continue;
                }
                if (batch.phase === "submitting" && !batch.taskId) throw new Error("上次成片提交结果尚未确认，请先核对服务器任务，避免重复提交");
                if (batch.phase === "failed") batch = { ...batch, phase: "pending", taskId: undefined, result: undefined, error: undefined };
                if (!batch.taskId) {
                    batch = { ...batch, phase: "submitting", error: undefined };
                    replaceBatch(batch);
                    await publish();
                    if (options.signal?.aborted) {
                        // The request has not been sent, so this checkpoint is safe to retry.
                        batch = { ...batch, phase: "pending" };
                        replaceBatch(batch);
                        await publish();
                        checkAbort();
                    }
                    const submitted = await options.submit([...batchKeys]);
                    if (!submitted.id?.trim()) throw new Error("合成接口未返回任务编号，提交结果待确认");
                    batch = { ...batch, phase: "running", taskId: submitted.id };
                    replaceBatch(batch);
                    // Persist the ID even if the component was unmounted during submit.
                    await publish();
                }
                checkAbort();
                try {
                    const result = await options.wait(batch.taskId!);
                    if (!result?.storageKey?.trim()) throw new Error("成片任务没有返回有效的视频存储信息");
                    batch = { ...batch, phase: "succeeded", result: { ...result, storageKey: result.storageKey.trim() }, error: undefined };
                } catch (error) {
                    // A transient polling error or AbortError keeps the ID for the next resume.
                    batch = { ...batch, phase: error instanceof DramaAssemblyTaskFailedError ? "failed" : "running", error: readError(error) };
                    replaceBatch(batch);
                    await publish();
                    throw error;
                }
                replaceBatch(batch);
                await publish();
                outputs.push(batch.result!);
            }
            inputs = outputs;
            level++;
        }
        checkAbort();
        state = { ...state, phase: "succeeded", result: inputs[0], error: undefined };
        await publish();
        return copyState(state);
    } catch (error) {
        state = { ...state, phase: error instanceof Error && error.name === "AbortError" ? "running" : "failed", error: readError(error) };
        await publish();
        throw error;
    }
}
