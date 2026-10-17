import assert from "node:assert/strict";
import test from "node:test";

import { countCompletedCanvasAgentTasks, summarizeCanvasAgentProgress, readCanvasAgentPlanProgress, updateCanvasAgentPlanProgress } from "./canvas-agent-progress";

test("画布 Agent 计划按任务更新，不重复计算同一任务的状态", () => {
    const initial = { taskCount: 2, tasks: {} };
    const running = updateCanvasAgentPlanProgress(initial, "task-a", "running", "正在生成分镜");
    const done = updateCanvasAgentPlanProgress(running, "task-a", "succeeded", "分镜完成");
    const second = updateCanvasAgentPlanProgress(done, "task-b", "failed", "视频生成失败");

    assert.equal(countCompletedCanvasAgentTasks(running), 0);
    assert.equal(countCompletedCanvasAgentTasks(done), 1);
    assert.equal(countCompletedCanvasAgentTasks(second), 1);
    assert.deepEqual(Object.keys(second.tasks), ["task-a", "task-b"]);
    assert.equal(done.tasks["task-a"].status, "succeeded");
    assert.equal(running.tasks["task-a"].status, "running");
});

test("忽略损坏的历史计划详情", () => {
    assert.equal(readCanvasAgentPlanProgress({ taskCount: "2", tasks: {} }), null);
    assert.deepEqual(readCanvasAgentPlanProgress({ taskCount: 1, tasks: { a: { status: 2 }, b: { status: "running", message: "执行中" } } }), {
        taskCount: 1,
        tasks: { b: { status: "running", message: "执行中" } },
    });
});

test("依赖失败跳过不算成功，失败与取消仍结束进度", () => {
    const progress = { taskCount: 4, tasks: {
        a: { status: "success", message: "完成" }, b: { status: "failed", message: "失败" },
        c: { status: "skipped", message: "依赖失败" }, d: { status: "canceled", message: "取消" },
    } };
    assert.equal(countCompletedCanvasAgentTasks(progress), 1);
    assert.deepEqual(summarizeCanvasAgentProgress(progress), {
        succeeded: 1, failed: 1, skipped: 1, canceled: 1, settled: 4,
        label: "4/4 已结束 · 成功 1 · 失败 1 · 跳过 1 · 取消 1",
    });
});

test("恢复成功会清除失败状态，迟到执行事件不能覆盖成功", () => {
    const failed = { taskCount: 1, tasks: { t: { status: "failed", message: "临时失败" } } };
    const retry = updateCanvasAgentPlanProgress(failed, "t", "retrying", "重试");
    assert.equal(summarizeCanvasAgentProgress(retry).failed, 0);
    const done = updateCanvasAgentPlanProgress(retry, "t", "success", "完成");
    const late = updateCanvasAgentPlanProgress(done, "t", "running", "迟到事件");
    assert.equal(late.tasks.t.status, "success");
    assert.equal(summarizeCanvasAgentProgress(late).succeeded, 1);
});
