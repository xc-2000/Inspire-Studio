import assert from "node:assert/strict";
import test from "node:test";
import { CanvasToolLedger, deliverCanvasToolReceipt } from "./canvas-tool-ledger";

test("重复工具事件合并执行及回传", async () => {
    const ledger = new CanvasToolLedger<{ nodeId: string }>();
    let executions = 0, deliveries = 0;
    const execute = async () => { executions++; return { nodeId: "created-node" }; };
    const submit = async () => { deliveries++; };
    await Promise.all([ledger.run("request:call", execute, submit), ledger.run("request:call", execute, submit)]);
    await ledger.run("request:call", execute, submit);
    assert.equal(executions, 1); assert.equal(deliveries, 1);
});

test("回传失败重发原结果，不重新创建节点或生成媒体", async () => {
    const ledger = new CanvasToolLedger<{ ok: boolean }>();
    let executions = 0, deliveries = 0;
    const result = { ok: true };
    const execute = async () => { executions++; return result; };
    const submit = async (receipt: typeof result) => {
        assert.equal(receipt, result);
        if (++deliveries === 1) throw new Error("network");
    };
    await assert.rejects(ledger.run("request:call", execute, submit));
    await ledger.run("request:call", execute, submit);
    assert.equal(executions, 1); assert.equal(deliveries, 2);
});

test("不同请求的同名调用各自执行", async () => {
    const ledger = new CanvasToolLedger<number>(); let count = 0;
    await ledger.run("r1:call", async () => ++count, async () => {});
    await ledger.run("r2:call", async () => ++count, async () => {});
    assert.equal(count, 2);
});

test("回传重试有次数上限且取消后停止", async () => {
    let attempts = 0;
    const controller = new AbortController();
    await assert.rejects(deliverCanvasToolReceipt(async () => { attempts++; throw new Error("offline"); },
        controller.signal, () => true, async () => {}));
    assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(deliverCanvasToolReceipt(async () => { attempts++; throw new Error("offline"); },
        controller.signal, () => true, async () => { controller.abort(); }));
    assert.equal(attempts, 1);
});

test("权限或业务拒绝不自动重试", async () => {
    let attempts = 0;
    await assert.rejects(deliverCanvasToolReceipt(async () => { attempts++; throw new Error("denied"); },
        new AbortController().signal, () => false));
    assert.equal(attempts, 1);
});
