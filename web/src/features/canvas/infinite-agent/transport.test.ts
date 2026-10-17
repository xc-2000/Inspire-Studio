import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { CanvasAgentRequestError, canvasAgentSelectedModel, canvasAgentSystemPrompt, isCanvasAgentContextLimitError, requestCanvasAgentCheckpoint, requestCanvasAgentTurn } from "./transport";
import type { CanvasAgentToolDefinition } from "./upstream/canvas-agent-tools";

const config = { model: "fallback::model", textModel: "text::model", agentModel: "agent::model", systemPrompt: "平台用户设定", apiKey: "private-local-value", baseUrl: "https://private-provider.invalid" } as AiConfig;
const tools: CanvasAgentToolDefinition[] = [{ type: "function", function: { name: "get_canvas_summary", description: "Read canvas", parameters: { type: "object", properties: {}, additionalProperties: false } } }];
const input = { config, systemPrompt: "runtime context", messages: [{ role: "user" as const, content: "hello" }], tools, toolMode: "native" as const };
const originalFetch = globalThis.fetch;
beforeEach(() => useUserStore.setState({ token: "test-platform-token", expiresAt: "2099-01-01T00:00:00Z", hydrated: true }));
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState({ token: "", expiresAt: "", hydrated: true }); });
function success(content = "done") { return Response.json({ code: 0, data: { content, toolCalls: [], model: "model", inputTokens: 100, outputTokens: 50, tokenCredits: 2 } }); }
function failure(status: number, message: string, code = "unsupported_parameter") {
    return Response.json({ code: status, error: { status, code, message } }, { status });
}

test("platform endpoint carries full protocol and bearer auth while excluding local provider credentials", async () => {
    globalThis.fetch = async (url, init) => {
        assert.match(String(url), /\/api\/v1\/ai\/canvas-agent\/turn$/);
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-platform-token");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "agent::model");
        assert.deepEqual(body.messages, input.messages);
        assert.deepEqual(body.tools, tools);
        assert.equal(body.apiKey, undefined);
        assert.equal(body.baseUrl, undefined);
        assert.equal(String(init?.body).includes(config.apiKey), false);
        assert.equal(String(init?.body).includes(config.baseUrl), false);
        return success();
    };
    assert.equal((await requestCanvasAgentTurn(input)).content, "done");
    assert.equal(canvasAgentSelectedModel({ ...config, agentModel: "" }), "text::model");
});

test("native protocol falls back through structured JSON to prompt JSON only after explicit incompatibility", async () => {
    const modes: string[] = [];
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)); modes.push(body.toolMode);
        if (body.toolMode === "native") return failure(400, "tools are unsupported");
        if (body.toolMode === "structured-json") {
            assert.equal(body.tools.length, 0);
            assert.equal(body.jsonSchema.properties.actions.type, "array");
            assert.match(body.systemPrompt, /JSON 工具定义/);
            return failure(400, "response_format is not supported");
        }
        assert.equal(body.jsonSchema, undefined);
        return success('{"actions":[],"reply":"done"}');
    };
    assert.equal((await requestCanvasAgentTurn(input)).toolMode, "prompt-json");
    assert.deepEqual(modes, ["native", "structured-json", "prompt-json"]);
});

test("auth, quota, server, network, and schema-validation failures never resubmit", async () => {
    for (const [status, message] of [[401, "tools unsupported"], [429, "tools unsupported"], [500, "tools unsupported"], [400, "invalid schema for function tools[0].parameters"]] as const) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return failure(status, message); };
        await assert.rejects(requestCanvasAgentTurn(input), CanvasAgentRequestError);
        assert.equal(calls, 1);
    }
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError("network ended"); };
    await assert.rejects(requestCanvasAgentTurn(input), /network ended/);
    assert.equal(calls, 1);
});

test("image compatibility fallback removes only image blocks and keeps text/tool protocol", async () => {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
        calls++;
        if (calls === 1) return failure(400, "unsupported image input");
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.messages[0].content, [{ type: "text", text: "look" }]);
        assert.equal(body.toolMode, "native");
        return success();
    };
    await requestCanvasAgentTurn({ ...input, messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }] });
    assert.equal(calls, 2);
});

test("checkpoint uses the same billed endpoint and retains upstream summary instructions", async () => {
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.toolMode, "prompt-json");
        assert.equal(body.tools.length, 0);
        assert.match(body.systemPrompt, /不得声称工具或媒体已成功/);
        assert.match(body.messages[0].content, /旧计划/);
        assert.match(body.messages[0].content, /本次归档的完整旧轮次/);
        return success("  compressed  ");
    };
    assert.equal(await requestCanvasAgentCheckpoint({ config, previousCheckpoint: "旧计划", messages: [{ user: "约束" }] }), "compressed");
});

test("cancel signal is passed to fetch and an aborted turn is not retried", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
        calls++;
        assert.equal(init?.signal, controller.signal);
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
    };
    await assert.rejects(requestCanvasAgentTurn({ ...input, signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
    await assert.rejects(requestCanvasAgentTurn({ ...input, signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
});

test("context limit signals remain visible to upstream memory compaction", () => {
    assert.equal(isCanvasAgentContextLimitError(new CanvasAgentRequestError("prompt too long", 400, "context_length_exceeded")), true);
    assert.equal(isCanvasAgentContextLimitError(new TypeError("network failure")), false);
    assert.match(canvasAgentSystemPrompt(config, "runtime", tools), /^平台用户设定\n\nruntime/);
});
