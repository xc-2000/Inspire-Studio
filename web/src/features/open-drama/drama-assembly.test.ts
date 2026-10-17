import assert from "node:assert/strict";
import { test } from "node:test";
import { DramaAssemblyTaskFailedError, runDramaAssembly, type DramaAssemblyState } from "./drama-assembly";

test("45 ordered clips use complete batches and retain a repeated source", async () => {
    const keys = Array.from({ length: 45 }, (_, index) => `shot-${index}`);
    keys[22] = keys[3];
    const calls: string[][] = [];
    const persisted: DramaAssemblyState[] = [];
    const result = await runDramaAssembly(keys, {
        submit: async sources => { calls.push(sources); return { id: `task-${calls.length}` }; },
        wait: async taskId => ({ storageKey: `result-${taskId}` }),
        onState: state => { persisted.push(state); },
    });
    assert.deepEqual(calls.slice(0, 3).flat(), keys);
    assert.deepEqual(calls[3], ["result-task-1", "result-task-2", "result-task-3"]);
    assert.ok(calls.every(call => call.length <= 20));
    assert.equal(result.phase, "succeeded");
    assert.equal(result.result?.storageKey, "result-task-4");
    assert.equal(persisted[0].batches.length, 0, "saved snapshots must not mutate later");
});

test("single clip and one-clip remainder are passed through without a new task", async () => {
    let submits = 0;
    const singleton = await runDramaAssembly(["only"], { submit: async () => { submits++; return { id: "unexpected" }; }, wait: async () => ({ storageKey: "unexpected" }), onState: () => {} });
    assert.equal(submits, 0);
    assert.equal(singleton.result?.storageKey, "only");
    const calls: string[][] = [];
    await runDramaAssembly(Array.from({ length: 21 }, (_, index) => `shot-${index}`), {
        submit: async sources => { calls.push(sources); return { id: `task-${calls.length}` }; },
        wait: async taskId => ({ storageKey: `result-${taskId}` }), onState: () => {},
    });
    assert.deepEqual(calls.map(call => call.length), [20, 2]);
    assert.deepEqual(calls[1], ["result-task-1", "shot-20"]);
});

test("a confirmed failed batch retries while successful batches are reused", async () => {
    const keys = Array.from({ length: 42 }, (_, index) => `shot-${index}`);
    let checkpoint: DramaAssemblyState | undefined;
    const calls: string[][] = [];
    const submit = async (sources: string[]) => { calls.push(sources); return { id: `task-${calls.length}` }; };
    await assert.rejects(runDramaAssembly(keys, {
        submit, wait: async id => { if (id === "task-2") throw new DramaAssemblyTaskFailedError("upstream failed"); return { storageKey: `result-${id}` }; },
        onState: state => { checkpoint = state; },
    }), /upstream failed/);
    assert.equal(checkpoint?.batches[0].phase, "succeeded");
    const result = await runDramaAssembly(keys, { checkpoint, submit, wait: async id => ({ storageKey: `result-${id}` }), onState: state => { checkpoint = state; } });
    assert.equal(calls.length, 5, "first success was not submitted again");
    assert.deepEqual(calls[1], calls[2], "only failed range is resubmitted");
    assert.equal(result.phase, "succeeded");
});

test("transient polling errors resume the existing task ID without resubmitting", async () => {
    let checkpoint: DramaAssemblyState | undefined;
    let submitted = 0;
    const submit = async () => ({ id: `task-${++submitted}` });
    await assert.rejects(runDramaAssembly(["a", "b"], { submit, wait: async () => { throw new Error("network offline"); }, onState: state => { checkpoint = state; } }), /network offline/);
    assert.equal(checkpoint?.batches[0].taskId, "task-1");
    assert.equal(checkpoint?.batches[0].phase, "running");
    const result = await runDramaAssembly(["a", "b"], { checkpoint, submit, wait: async id => ({ storageKey: `result-${id}` }), onState: () => {} });
    assert.equal(submitted, 1);
    assert.equal(result.result?.storageKey, "result-task-1");
});

test("abort during submit saves the task ID and reload resumes it", async () => {
    const abort = new AbortController();
    let checkpoint: DramaAssemblyState | undefined;
    let waits = 0;
    await assert.rejects(runDramaAssembly(["a", "b"], {
        signal: abort.signal, submit: async () => { abort.abort(); return { id: "accepted" }; },
        wait: async () => { waits++; return { storageKey: "unexpected" }; }, onState: state => { checkpoint = state; },
    }), { name: "AbortError" });
    assert.equal(waits, 0);
    assert.equal(checkpoint?.batches[0].taskId, "accepted");
    assert.equal(checkpoint?.phase, "running");
    const result = await runDramaAssembly(["a", "b"], { checkpoint, submit: async () => { throw new Error("duplicate"); }, wait: async id => ({ storageKey: id }), onState: () => {} });
    assert.equal(result.result?.storageKey, "accepted");
});

test("source order changes invalidate previous checkpoints", async () => {
    let checkpoint: DramaAssemblyState | undefined;
    await runDramaAssembly(["a", "b"], { submit: async () => ({ id: "old" }), wait: async () => ({ storageKey: "old-film" }), onState: state => { checkpoint = state; } });
    let newSources: string[] = [];
    const result = await runDramaAssembly(["b", "a"], {
        checkpoint, submit: async sources => { newSources = sources; return { id: "new" }; }, wait: async () => ({ storageKey: "new-film" }), onState: () => {},
    });
    assert.deepEqual(newSources, ["b", "a"]);
    assert.equal(result.result?.storageKey, "new-film");
});

test("empty result storage is rejected and its task remains recoverable", async () => {
    let checkpoint: DramaAssemblyState | undefined;
    await assert.rejects(runDramaAssembly(["a", "b"], {
        submit: async () => ({ id: "accepted" }), wait: async () => ({ storageKey: " " }), onState: state => { checkpoint = state; },
    }), /存储信息/);
    assert.equal(checkpoint?.batches[0].taskId, "accepted");
    assert.notEqual(checkpoint?.phase, "succeeded");
});

test("an interrupted submit with an unknown outcome is never submitted again automatically", async () => {
    let checkpoint: DramaAssemblyState | undefined;
    await assert.rejects(runDramaAssembly(["a", "b"], { submit: async () => { throw new Error("connection reset"); }, wait: async () => ({ storageKey: "unused" }), onState: state => { checkpoint = state; } }), /connection reset/);
    assert.equal(checkpoint?.batches[0].phase, "submitting");
    await assert.rejects(runDramaAssembly(["a", "b"], { checkpoint, submit: async () => { throw new Error("must not submit"); }, wait: async () => ({ storageKey: "unused" }), onState: () => {} }), /提交结果尚未确认/);
});

test("more than two levels still keep every original shot in sequence", async () => {
    const keys = Array.from({ length: 402 }, (_, index) => `shot-${index}`);
    const content = new Map(keys.map(key => [key, [key]]));
    let submits = 0;
    const result = await runDramaAssembly(keys, {
        submit: async sources => { const id = `batch-${++submits}`; content.set(id, sources.flatMap(key => content.get(key)!)); return { id }; },
        wait: async id => ({ storageKey: id }), onState: () => {},
    });
    assert.deepEqual(content.get(result.result!.storageKey), keys);
    assert.equal(submits, 23);
});
