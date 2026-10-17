/**
 * Adapted from tigerowo/infinite-canvas web/src/services/api/canvas-agent.ts,
 * commit f4e557e (see upstream/README.md). Prompt, checkpoint, and compatibility
 * rules are retained; provider HTTP is replaced by this application's billed endpoint.
 */
import { getAuthToken, useUserStore } from "@/features/auth/stores/use-user-store";
import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { serverBaseUrl } from "@/services/api/server";
import type { CanvasAgentProtocolMessage, CanvasAgentToolCall, CanvasAgentToolMode } from "./upstream/types";
import type { CanvasAgentToolDefinition } from "./upstream/canvas-agent-tools";
import { calibrateCanvasAgentTokenEstimate } from "./upstream/canvas-agent-memory";

export type { AiConfig };
export type CanvasAgentModelTurn = {
    content: string;
    reasoningContent?: string;
    responseItems?: unknown[];
    toolCalls: CanvasAgentToolCall[];
    toolError?: string;
    toolMode: CanvasAgentToolMode;
};
export const CANVAS_AGENT_JSON_FALLBACK_SIGNAL = "__CANVAS_AGENT_JSON_FALLBACK__";
type RequestCanvasAgentTurnInput = {
    config: AiConfig;
    systemPrompt: string;
    messages: CanvasAgentProtocolMessage[];
    tools: CanvasAgentToolDefinition[];
    toolMode: CanvasAgentToolMode;
    signal?: AbortSignal;
};
type BilledTurn = CanvasAgentModelTurn & { model: string; inputTokens: number; outputTokens: number; tokenCredits: number };
type Payload = { code?: number; msg?: string; data?: BilledTurn; error?: { status?: number; code?: string; message?: string } };

export class CanvasAgentRequestError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "CanvasAgentRequestError";
        this.status = status;
        this.code = code;
    }
}

export function canvasAgentSelectedModel(config: AiConfig) {
    return config.agentModel || config.textModel || config.model;
}

export async function requestCanvasAgentTurn(input: RequestCanvasAgentTurnInput): Promise<CanvasAgentModelTurn> {
    let messages = input.messages;
    let toolMode = input.toolMode;
    let requestError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
        input.signal?.throwIfAborted();
        try {
            const tools = toolMode === "native" ? input.tools : [];
            const jsonTools = toolMode === "native" ? [] : input.tools;
            const systemPrompt = canvasAgentSystemPrompt(input.config, input.systemPrompt, jsonTools, toolMode === "native");
            const jsonSchema = toolMode === "structured-json" && jsonTools.length ? canvasAgentJsonSchema(jsonTools) : undefined;
            const result = await requestCompletion(input.config, systemPrompt, messages, tools, toolMode, jsonSchema, input.signal);
            calibrateCanvasAgentTokenEstimate(canvasAgentTokenCalibrationKey(input.config), { systemPrompt, messages, tools }, result.inputTokens);
            return { ...result, toolMode };
        } catch (error) {
            requestError = error;
            if (isCanvasAgentContextLimitError(error)) throw error;
            if (hasImageContent(messages) && isImageCompatibilityError(error)) {
                messages = stripImageContent(messages);
                continue;
            }
            if (toolMode === "native" && isToolCompatibilityError(error, "tools")) {
                toolMode = "structured-json";
                continue;
            }
            if (toolMode === "structured-json" && isToolCompatibilityError(error, "structured-json")) {
                toolMode = "prompt-json";
                continue;
            }
            // Network errors, cancellation, auth, quota, and server errors never resubmit a turn.
            throw error;
        }
    }
    throw requestError;
}

export function canvasAgentSystemPrompt(config: AiConfig, prompt: string, jsonTools: CanvasAgentToolDefinition[] = [], nativeTools = false) {
    const configured = config.systemPrompt.trim();
    if (nativeTools) prompt += "\n\n【原生工具回退信号】\n需要执行任何画布操作时必须返回原生工具调用；若本轮无法返回任何原生工具调用，只输出 " + CANVAS_AGENT_JSON_FALLBACK_SIGNAL + "，不得附加文字、Markdown 或声称已完成。仅咨询、解释、分析且无需执行画布操作时正常文字回答，禁止输出此信号。";
    if (jsonTools.length) prompt += "\n\n【JSON 工具定义】\n当前画布执行器会解析并执行回复中的 actions。需要操作画布时必须直接返回合法的 actions JSON；接口没有原生 Tool Calling 不代表没有画布执行能力，不得因此拒绝执行或要求用户手动提交。所有工具参数都放在对应 action 的 arguments 中。\n" + JSON.stringify(jsonTools.map(({ function: tool }) => tool));
    return configured ? configured + "\n\n" + prompt : prompt;
}

export async function requestCanvasAgentCheckpoint(input: { config: AiConfig; previousCheckpoint?: string; messages: unknown; signal?: AbortSignal }) {
    const turn = await requestCanvasAgentTurn({
        config: input.config,
        systemPrompt: "你负责生成画布 Agent 的长期对话检查点。仅保留用户长期目标与偏好、已确认方案、不可改变要求、否决方向、未解决事项、重要节点 ID 的职责线索，以及当前 Skill 和阶段线索。节点是否存在、节点正文、任务状态必须以之后注入的真实画布和工具结果为准；不得声称工具或媒体已成功，不得保存 Base64。直接输出检查点正文，控制在 16000 Token 以内。",
        messages: [{ role: "user", content: `【旧检查点】\n${input.previousCheckpoint || "无"}\n\n【本次归档的完整旧轮次】\n${JSON.stringify(input.messages)}` }],
        tools: [], toolMode: "prompt-json", signal: input.signal,
    });
    return turn.content.trim();
}

async function requestCompletion(config: AiConfig, systemPrompt: string, messages: CanvasAgentProtocolMessage[], tools: CanvasAgentToolDefinition[], toolMode: CanvasAgentToolMode, jsonSchema?: Record<string, unknown>, signal?: AbortSignal): Promise<BilledTurn> {
    const token = getAuthToken();
    const response = await fetch(`${serverBaseUrl()}/ai/canvas-agent/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: "include", cache: "no-store", signal,
        // Deliberate allowlist: neither local channel credentials nor config.apiKey/baseUrl leave the browser.
        body: JSON.stringify({ model: canvasAgentSelectedModel(config), systemPrompt, messages, tools, toolMode, ...(jsonSchema ? { jsonSchema } : {}) }),
    });
    const payload = (await response.json().catch(() => null)) as Payload | null;
    if (response.status === 401) {
        useUserStore.getState().clearSession();
        useUserStore.getState().openAuthModal();
    }
    if (!response.ok || !payload || payload.code !== 0 || !payload.data) {
        throw new CanvasAgentRequestError(payload?.error?.message || payload?.msg || `文本模型请求失败：${response.status}`, payload?.error?.status || response.status, payload?.error?.code);
    }
    const result = payload.data;
    if (typeof result.content !== "string" || !Array.isArray(result.toolCalls)) throw new CanvasAgentRequestError("文本模型响应格式不完整", 502);
    return result;
}

function canvasAgentJsonSchema(tools: CanvasAgentToolDefinition[]): Record<string, unknown> {
    return { type: "object", properties: {
        actions: { type: "array", maxItems: 12, items: { type: "object", properties: {
            tool: { type: "string", enum: tools.map(({ function: tool }) => tool.name) },
            arguments: { type: "object", additionalProperties: true },
        }, required: ["tool", "arguments"], additionalProperties: false } }, reply: { type: "string" },
    }, required: ["actions", "reply"], additionalProperties: false };
}

export function canvasAgentTokenCalibrationKey(config: AiConfig) { return `platform:${canvasAgentSelectedModel(config)}`; }
function hasImageContent(messages: CanvasAgentProtocolMessage[]) {
    return messages.some(message => (message.role === "user" || message.role === "system") && Array.isArray(message.content) && message.content.some(item => item.type === "image_url"));
}
function stripImageContent(messages: CanvasAgentProtocolMessage[]) {
    return messages.map((message): CanvasAgentProtocolMessage => (message.role === "user" || message.role === "system") && Array.isArray(message.content)
        ? { role: message.role, content: message.content.filter(item => item.type === "text") } : message);
}
function isCompatibilityStatus(error: unknown): error is CanvasAgentRequestError {
    return error instanceof CanvasAgentRequestError && error.status >= 400 && error.status < 500 && ![401, 403, 408, 409, 429].includes(error.status);
}
function isImageCompatibilityError(error: unknown) {
    return isCompatibilityStatus(error) && /image_url|image input|vision|multimodal|content.*array|unsupported.*image|不支持.*图片|图像输入/i.test(error.message);
}
function isToolCompatibilityError(error: unknown, mode: "tools" | "structured-json") {
    if (!isCompatibilityStatus(error)) return false;
    const detail = `${error.code || ""} ${error.message}`.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    const target = mode === "tools"
        ? String.raw`\btools?\b|\btool[\s.]*(?:choice|calls?|calling)\b|\bfunction[\s.]*(?:calls?|calling|declarations?)\b|工具调用|函数调用`
        : String.raw`\bresponse[\s.]*format\b|\bjson[\s.]*schema\b|\btext[\s.]*format\b|\bresponse[\s.]*mime[\s.]*type\b|\bstructured output\b|结构化输出`;
    if (!new RegExp(target, "i").test(detail)) return false;
    if (mode === "tools" && /\btools?\s*\[\s*\d+\s*\].*\b(?:parameters?|properties|required|additional\s*properties|schema)\b|\binvalid schema for function\b/i.test(detail)) return false;
    if (mode === "structured-json" && /\binvalid (?:json )?schema\b|\bschema (?:validation|violation)\b|\b(?:properties|required|additional\s*properties)\b/i.test(detail)) return false;
    const issue = String.raw`\bunsupported\b|\b(?:does\s+not|doesn't|do\s+not|don't|not)\s+support(?:ed|s|ing)?\b|\b(?:not allowed|not permitted|must be none|unavailable|disabled|not\s+(?:available|enabled|implemented))\b|\b(?:unknown|unrecognized|invalid)\s+(?:(?:request|input)\s+)?(?:field|parameter|argument)\b|不支持|不允许|不可用|未启用|未实现|未知(?:字段|参数)`;
    return new RegExp(`(?:${target}).{0,80}(?:${issue})|(?:${issue}).{0,80}(?:${target})`, "i").test(detail);
}
export function isCanvasAgentContextLimitError(error: unknown) {
    return error instanceof CanvasAgentRequestError && /context_length_exceeded|maximum context|context window|prompt too long|token limit|上下文长度|上下文超限|输入过长/i.test(`${error.code || ""} ${error.message}`);
}
