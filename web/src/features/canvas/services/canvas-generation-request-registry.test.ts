import assert from "node:assert/strict";
import test from "node:test";

import { createCanvasGenerationRequestRegistry } from "./canvas-generation-request-registry.ts";

test("启动同一目标的新请求会中止旧请求", () => {
    const registry = createCanvasGenerationRequestRegistry();
    const first = new AbortController();
    const second = new AbortController();

    registry.start("target", "origin", "running", first);
    registry.start("target", "origin", "running", second);

    assert.equal(first.signal.aborted, true);
    assert.equal(registry.finish("target", second), true);
    assert.equal(registry.isRunning("running"), false);
});

test("按运行节点停止会返回全部受影响节点", () => {
    const registry = createCanvasGenerationRequestRegistry();
    registry.start("child", "origin", "running", new AbortController());

    assert.deepEqual([...registry.stopByRunningId("running")].sort(), ["child", "origin"]);
    assert.equal(registry.isRunning("running"), false);
});

test("停止全部请求会中止控制器并清空注册表", () => {
    const registry = createCanvasGenerationRequestRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.start("first", "origin", "running", first);
    registry.start("second", "origin", "running", second);

    registry.stopAll();

    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, true);
    assert.equal(registry.isRunning("running"), false);
});

test("deleting a result or its origin aborts the matching request without stopping unrelated work", () => {
    for (const removedId of ["result", "origin", "running"]) {
        const registry = createCanvasGenerationRequestRegistry();
        const matching = new AbortController();
        const unrelated = new AbortController();
        registry.start("result", "origin", "running", matching);
        registry.start("other-result", "other-origin", "other-running", unrelated);
        assert.deepEqual([...registry.stopForNodeIds(new Set([removedId]))].sort(), ["origin", "result", "running"]);
        assert.equal(matching.signal.aborted, true);
        assert.equal(unrelated.signal.aborted, false);
        assert.equal(registry.isRunning("running"), false);
        assert.equal(registry.isRunning("other-running"), true);
        assert.equal(registry.finish("result", matching), false);
    }
});

test("deleting one node clears every registration sharing its aborted controller", () => {
    const registry = createCanvasGenerationRequestRegistry();
    const controller = new AbortController();
    registry.start("root", "origin", "root", controller);
    registry.start("child", "origin", "root", controller);
    assert.deepEqual([...registry.stopForNodeIds(new Set(["child"]))].sort(), ["child", "origin", "root"]);
    assert.equal(registry.isRunning("root"), false);
    assert.equal(registry.finish("root", controller), false);
});
