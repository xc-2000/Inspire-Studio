import test from "node:test";
import assert from "node:assert/strict";
import { InfiniteAgentRunGuard, recoverInfiniteAgentMemory, type InfiniteAgentMemory } from "./session";

const memory = (): InfiniteAgentMemory => ({ state: { phase: "script", approvedNodeIds: ["script"], referenceNodeIds: [], pendingTaskIds: ["video-task"], completedTaskIds: [] }, protocolMessages: [{ role: "user", content: "生成视频" }], requestId: "request", status: "running", updatedAt: "2026-09-30T00:00:00Z" });

test("refresh preserves actual protocol and tells the Agent to inspect instead of replaying", () => {
    const original = memory();
    const restored = recoverInfiniteAgentMemory(JSON.parse(JSON.stringify(original)))!;
    assert.equal(restored.status, "interrupted");
    assert.deepEqual(restored.state.pendingTaskIds, ["video-task"]);
    assert.match(String(restored.protocolMessages.at(-1)?.content), /不要自动重放/);
    assert.equal(original.protocolMessages.length, 1);
    assert.equal(recoverInfiniteAgentMemory(restored), restored);
});

test("completed conversation is kept verbatim and empty history is supported", () => {
    const completed = { ...memory(), status: "completed" as const };
    assert.equal(recoverInfiniteAgentMemory(completed), completed);
    assert.equal(recoverInfiniteAgentMemory(), undefined);
});

test("double clicks and cancel cannot release the guard until running work settles", () => {
    const guard = new InfiniteAgentRunGuard();
    const first = guard.start()!;
    assert.equal(guard.start(), null);
    guard.cancel();
    assert.equal(first.signal.aborted, true);
    assert.equal(guard.start(), null);
    guard.finish(first);
    const next = guard.start()!;
    guard.finish(first);
    assert.equal(guard.running, true);
    assert.equal(next.signal.aborted, false);
    guard.finish(next);
    assert.equal(guard.running, false);
});

test("refresh preserves active skill metadata and its activation source", () => {
    const original: InfiniteAgentMemory = { ...memory(), activeSkills: [{ id: 17, name: "角色四视图", targetType: "canvasSettingGraph" }], skillSource: "auto" };
    const restored = recoverInfiniteAgentMemory(JSON.parse(JSON.stringify(original)))!;
    assert.deepEqual(restored.activeSkills, original.activeSkills);
    assert.equal(restored.skillSource, "auto");
    assert.equal(restored.status, "interrupted");
    const completed = { ...restored, status: "completed" as const };
    assert.equal(recoverInfiniteAgentMemory(completed), completed);
    assert.equal(recoverInfiniteAgentMemory(memory())?.activeSkills, undefined);
});

test("refresh interrupts a running film while preserving its exact recovery scope", () => {
    const original: InfiniteAgentMemory = { ...memory(), film: { brief: "山间茶铺", status: "running", nodeIds: ["script", "shot-1"], resultNodeId: "final" } };
    const restored = recoverInfiniteAgentMemory(original)!;
    assert.deepEqual(restored.film, { ...original.film, status: "interrupted" });
    assert.equal(recoverInfiniteAgentMemory(restored), restored);
    const finished: InfiniteAgentMemory = { ...original, status: "completed", film: { ...original.film!, status: "completed" } };
    assert.equal(recoverInfiniteAgentMemory(finished), finished);
});
