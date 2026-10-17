import assert from "node:assert/strict";
import test from "node:test";

import type { AiConfig } from "@/features/settings/stores/use-config-store";
import { CanvasAgentRequestError } from "../transport";
import { buildCanvasAgentSkillPrompt } from "./canvas-agent-skills";
import { compactCanvasAgentHistory } from "./canvas-agent-memory";
import { createCanvasAgentState, executeActions, runCanvasAgent, type RunCanvasAgentInput } from "./canvas-agent-runtime";
import { CANVAS_AGENT_SKILL_DISCOVERY_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, parseCanvasAgentJson, type CanvasAgentAction } from "./canvas-agent-tools";
import type { CanvasAgentContext } from "./canvas-agent-context";
import type { CanvasAgentProtocolMessage, CanvasAgentState } from "./types";
import type { OneSentenceFilm } from "../one-sentence-film";

type TurnRequest = Parameters<NonNullable<RunCanvasAgentInput["requestTurn"]>>[0];
type ModelTurn = Awaited<ReturnType<NonNullable<RunCanvasAgentInput["requestTurn"]>>>;
const config = { model: "gpt-5", textModel: "gpt-5", agentModel: "gpt-5", systemPrompt: "" } as AiConfig;

function context(state: CanvasAgentState): CanvasAgentContext {
    return {
        project: { id: "project-1", title: "测试画布", nodeCount: 0, connectionCount: 0 },
        agentState: state,
        selectedNodeIds: [],
        nodes: [],
        connections: [],
        generation: {
            autoGenerateMedia: true,
            textModel: "gpt-5",
            imageModel: "image-model",
            videoModel: "video-model",
            audioModel: "",
            imageQuality: "standard",
            imageSize: "16:9",
            videoQuality: "720p",
            videoSize: "16:9",
            imageCount: "1",
            videoSeconds: "5",
            videoGenerateAudio: "false",
            videoSupportsAudio: false,
            audioVoice: "",
            audioLanguage: "",
            audioFormat: "",
            audioSpeed: "",
        },
        tasks: [],
    };
}

function nativeTurn(toolCalls: ModelTurn["toolCalls"] = [], content = ""): ModelTurn {
    return { content, toolCalls, toolMode: "native" };
}

function input(overrides: Partial<RunCanvasAgentInput>): RunCanvasAgentInput {
    return {
        config,
        initialState: createCanvasAgentState(),
        protocolMessages: [],
        userText: "保存一条正文",
        references: [],
        getContext: context,
        executeAction: async () => ({ ok: true }),
        ...overrides,
    };
}

test("native multi-step turns receive real tool results and track pending and completed media", async () => {
    const executed: CanvasAgentAction[] = [];
    const requests: TurnRequest[] = [];
    const checkpoints: Parameters<NonNullable<RunCanvasAgentInput["onCheckpoint"]>>[0][] = [];
    const turns = [
        nativeTurn([{ id: "create-call", name: "generate_image", arguments: { prompt: "一只猫", size: "16:9", sourceNodeIds: [] } }]),
        nativeTurn([{ id: "status-call", name: "get_generation_task", arguments: { nodeId: "image-1" } }]),
        nativeTurn([], "图片已完成。"),
    ];
    const result = await runCanvasAgent(input({
        userText: "生成一张猫咪图片",
        requestTurn: async (request) => {
            requests.push(structuredClone(request));
            return turns.shift()!;
        },
        executeAction: async (action) => {
            executed.push(action);
            return action.name === "generate_image"
                ? { ok: true, nodeId: "image-1", taskId: "media-1", status: "loading" }
                : { ok: true, nodeId: "image-1", taskId: "media-1", status: "success" };
        },
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    }));
    assert.deepEqual(executed.map((action) => action.name), ["generate_image", "get_generation_task"]);
    const createFeedback = requests[1].messages.find((message) => message.role === "tool");
    assert.equal(createFeedback?.role, "tool");
    if (createFeedback?.role === "tool") {
        assert.equal(createFeedback.toolCallId, "create-call");
        assert.equal(JSON.parse(createFeedback.content).nodeId, "image-1");
    }
    assert.deepEqual(checkpoints[1].state.pendingTaskIds, ["media-1"]);
    assert.deepEqual(result.state.pendingTaskIds, []);
    assert.deepEqual(result.state.completedTaskIds, ["media-1"]);
    assert.equal(result.reply, "图片已完成。");
});

test("a batch with invalid arguments executes nothing until the model corrects the entire batch", async () => {
    let calls = 0;
    const executed: string[] = [];
    const result = await runCanvasAgent(input({
        requestTurn: async (request) => {
            calls += 1;
            if (calls === 1) return nativeTurn([
                { id: "valid", name: "create_text_node", arguments: { title: "正文", content: "完整定稿" } },
                { id: "invalid", name: "get_node", arguments: {} },
            ]);
            if (calls === 2) {
                assert.deepEqual(executed, []);
                const feedback = request.messages.filter((message) => message.role === "tool");
                assert.equal(feedback.length, 2);
                assert.ok(feedback.every((message) => message.role === "tool" && JSON.parse(message.content).code === "invalid_tool_arguments"));
                return nativeTurn([{ id: "corrected", name: "create_text_node", arguments: { title: "正文", content: "完整定稿" } }]);
            }
            return nativeTurn([], "已保存");
        },
        executeAction: async (action) => {
            executed.push(action.id);
            return { ok: true, nodeId: "text-1" };
        },
    }));
    assert.deepEqual(executed, ["corrected"]);
    assert.equal(result.reply, "已保存");
});

test("invalid tool arguments get only one repair attempt without side effects", async () => {
    let modelCalls = 0;
    let writes = 0;
    await assert.rejects(runCanvasAgent(input({
        requestTurn: async () => {
            modelCalls += 1;
            return nativeTurn([{ id: `invalid-${modelCalls}`, name: "generate_video", arguments: { prompt: "镜头", sourceNodeIds: [], generateAudio: "true" } }]);
        },
        executeAction: async () => { writes += 1; return { ok: true }; },
    })), /工具指令仍无效/);
    assert.equal(modelCalls, 2);
    assert.equal(writes, 0);
});

test("unrequested arrangement is rejected with tool feedback and no canvas changes", async () => {
    let calls = 0;
    let writes = 0;
    const result = await runCanvasAgent(input({
        userText: "总结目前的内容，不要整理画布",
        requestTurn: async (request) => {
            calls += 1;
            if (calls === 1) return nativeTurn([{ id: "arrange", name: "arrange_nodes", arguments: { nodeIds: ["n-1"] } }]);
            const rejected = request.messages.find((message) => message.role === "tool");
            assert.equal(rejected?.role, "tool");
            if (rejected?.role === "tool") assert.equal(JSON.parse(rejected.content).code, "action_not_requested");
            return nativeTurn([], "目前只有一条内容。");
        },
        executeAction: async () => { writes += 1; return { ok: true }; },
    }));
    assert.equal(writes, 0);
    assert.equal(result.reply, "目前只有一条内容。");
});

test("native fallback signal switches to structured JSON and preserves actual action feedback", async () => {
    let calls = 0;
    let writes = 0;
    const result = await runCanvasAgent(input({
        requestTurn: async (request) => {
            calls += 1;
            if (calls === 1) return nativeTurn([], "__CANVAS_AGENT_JSON_FALLBACK__");
            assert.equal(request.toolMode, "structured-json");
            if (calls === 2) return {
                content: "{actions:[{tool:'create_text_node',arguments:{title:'笔记',content:'完整正文'}}],reply:''}",
                toolCalls: [],
                toolMode: "structured-json",
            };
            const feedback = request.messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("工具执行结果"));
            assert.ok(feedback);
            assert.ok(JSON.stringify(feedback).includes("text-1"));
            return { content: '{"actions":[],"reply":"已保存正文"}', toolCalls: [], toolMode: "structured-json" };
        },
        executeAction: async (action) => {
            assert.equal(action.arguments.content, "完整正文");
            writes += 1;
            return { ok: true, nodeId: "text-1" };
        },
    }));
    assert.equal(writes, 1);
    assert.equal(result.jsonFallbackMode, "structured-json");
    assert.equal(result.reply, "已保存正文");
});

test("JSON repair refuses truncated action structures", async () => {
    const result = await parseCanvasAgentJson('{"actions":[{"tool":"create_text_node","arguments":{"title":"a","content":"b"}}', { allowRepair: true });
    assert.equal(result.actions.length, 0);
    assert.match(result.error || "", /截断/);
});

test("the host tool subset is exposed exactly and cannot silently add the skill file tool", async () => {
    const tools = CANVAS_AGENT_TOOLS.filter((tool) => tool.function.name === "get_canvas_summary");
    await runCanvasAgent(input({
        tools,
        activeSkillContents: [{ id: "s1", source: "system", name: "笔记", content: "仅保存笔记", hasFiles: true }],
        requestTurn: async (request) => {
            assert.deepEqual(request.tools.map((tool) => tool.function.name), ["get_canvas_summary"]);
            assert.ok(!request.systemPrompt.includes("【系统 Skill 附属文件】"));
            return nativeTurn([], "目前为空");
        },
    }));
});

test("abort signals reach tool execution and stop the run without another model request", async () => {
    const controller = new AbortController();
    let requests = 0;
    await assert.rejects(runCanvasAgent(input({
        signal: controller.signal,
        requestTurn: async () => {
            requests += 1;
            return nativeTurn([{ id: "create", name: "create_text_node", arguments: { title: "a", content: "b" } }]);
        },
        executeAction: async (_action, signal) => {
            assert.equal(signal, controller.signal);
            controller.abort();
            return { ok: true, nodeId: "text-1" };
        },
    })), { name: "AbortError" });
    assert.equal(requests, 1);
});

test("AbortError from a tool is rethrown even before its signal becomes aborted", async () => {
    const error = new Error("用户停止任务");
    error.name = "AbortError";
    await assert.rejects(executeActions(
        [normalizeCanvasAgentAction("get_canvas_summary", {}, "read")],
        createCanvasAgentState(),
        async () => { throw error; },
    ), (actual) => actual === error);
});

test("the initial checkpoint persists the user prompt before a failed model request", async () => {
    const checkpoints: Parameters<NonNullable<RunCanvasAgentInput["onCheckpoint"]>>[0][] = [];
    await assert.rejects(runCanvasAgent(input({
        userText: "这条原始用户消息必须保存",
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
        requestTurn: async () => {
            assert.equal(checkpoints.length, 1);
            throw new Error("network down");
        },
    })), /network down/);
    assert.deepEqual(checkpoints[0].protocolMessages, [{ role: "user", content: "这条原始用户消息必须保存" }]);
});

test("history compaction retains whole tool rounds, current input, and the long-term checkpoint", async () => {
    const oldText = "旧".repeat(210_000);
    const messages: CanvasAgentProtocolMessage[] = [
        { role: "system", content: "系统固定消息" },
        { role: "user", content: oldText },
        { role: "assistant", toolCalls: [{ id: "old-call", name: "get_node", arguments: { nodeId: "n1" } }] },
        { role: "tool", name: "get_node", toolCallId: "old-call", content: '{"ok":true}' },
        { role: "assistant", content: "旧一轮完成" },
        { role: "user", content: "近期一轮" },
        { role: "assistant", content: "近期已完成" },
        { role: "user", content: "当前未完成输入" },
    ];
    const result = await compactCanvasAgentHistory({
        protocolMessages: messages,
        contextCheckpoint: "之前的批准范围",
        createCheckpoint: async (previousCheckpoint, compactedMessages) => {
            assert.equal(previousCheckpoint, "之前的批准范围");
            assert.deepEqual(compactedMessages, messages.slice(1, 5));
            return "批准目标与已完成节点";
        },
    });
    assert.equal(result.compacted, true);
    assert.equal(result.contextCheckpoint, "批准目标与已完成节点");
    assert.deepEqual(result.protocolMessages, [messages[0], ...messages.slice(5)]);
});

test("selected skills override default creative templates while retaining the core constraints", () => {
    const prompt = buildCanvasAgentSkillPrompt("video", "生成视频", context(createCanvasAgentState()), "用户自选技能流程");
    assert.ok(prompt.includes("用户自选技能流程"));
    assert.ok(prompt.includes("【画布创作 Agent 公共执行手册】"));
    assert.ok(!prompt.includes("【总创作流程 Skill"));
    assert.ok(!prompt.includes("【视频生成 Skill"));
});

test("search and activation feedback loads current skills on the next turn while keeping the file tool available", async () => {
    let activeSkills: RunCanvasAgentInput["activeSkillContents"];
    let calls = 0;
    const executed: string[] = [];
    const tools = [...CANVAS_AGENT_TOOLS, ...CANVAS_AGENT_SKILL_DISCOVERY_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL];
    const result = await runCanvasAgent(input({
        userText: "生成视频",
        initialState: { ...createCanvasAgentState(), phase: "video" },
        tools,
        activeSkillContents: [{ id: "stale", source: "system", name: "旧选择", content: "过期技能正文", hasFiles: true }],
        getActiveSkillContents: () => activeSkills,
        requestTurn: async (request) => {
            calls += 1;
            assert.deepEqual(request.tools, tools);
            assert.ok(!request.systemPrompt.includes("过期技能正文"));
            if (calls <= 2) {
                assert.ok(request.systemPrompt.includes("【总创作流程 Skill"));
                assert.ok(!request.systemPrompt.includes("【系统 Skill 附属文件】"));
            } else {
                assert.ok(request.systemPrompt.includes("完整且即时激活的技能正文"));
                assert.ok(request.systemPrompt.includes("【画布创作 Agent 公共执行手册】"));
                assert.ok(request.systemPrompt.includes("【系统 Skill 附属文件】"));
                assert.ok(!request.systemPrompt.includes("【总创作流程 Skill"));
                assert.ok(!request.systemPrompt.includes("【视频生成 Skill"));
            }
            if (calls === 1) return nativeTurn([{ id: "search", name: "search_skills", arguments: { query: "镜头", targetType: "video" } }]);
            const feedback = request.messages.filter((message) => message.role === "tool");
            assert.ok(feedback.some((message) => message.role === "tool" && message.toolCallId === "search" && JSON.parse(message.content).skills[0].id === 7));
            if (calls === 2) return nativeTurn([{ id: "activate", name: "activate_skills", arguments: { skillIds: [7] } }]);
            assert.ok(feedback.some((message) => message.role === "tool" && message.toolCallId === "activate" && JSON.parse(message.content).ok));
            if (calls === 3) return nativeTurn([{ id: "read", name: "read_skill_file", arguments: { skillId: "7", path: "references/shots.md" } }]);
            assert.ok(feedback.some((message) => message.role === "tool" && message.toolCallId === "read" && JSON.parse(message.content).content === "镜头附属文件全文"));
            return nativeTurn([], "技能已读取");
        },
        executeAction: async (action) => {
            executed.push(action.name);
            if (action.name === "search_skills") return { ok: true, skills: [{ id: 7, name: "镜头技能", description: "设计镜头" }] };
            if (action.name === "activate_skills") {
                assert.deepEqual(action.arguments.skillIds, [7]);
                activeSkills = [{ id: "7", source: "system", name: "镜头技能", content: "完整且即时激活的技能正文", hasFiles: true }];
                return { ok: true, activeSkillIds: [7] };
            }
            assert.equal(action.name, "read_skill_file");
            return { ok: true, content: "镜头附属文件全文" };
        },
    }));
    assert.deepEqual(executed, ["search_skills", "activate_skills", "read_skill_file"]);
    assert.equal(calls, 4);
    assert.equal(result.reply, "技能已读取");
});

for (const trigger of ["estimated budget", "provider context limit"] as const) {
    test(`skill contents and default file tools are refreshed after ${trigger} checkpoint compaction`, async () => {
        let activeSkills: RunCanvasAgentInput["activeSkillContents"];
        let checkpointCalls = 0;
        let turnCalls = 0;
        const oldText = "旧".repeat(trigger === "estimated budget" ? 260_000 : 90_000);
        const result = await runCanvasAgent(input({
            protocolMessages: [{ role: "user", content: oldText }, { role: "assistant", content: "旧一轮已完成" }],
            getActiveSkillContents: () => activeSkills,
            requestCheckpoint: async () => {
                checkpointCalls += 1;
                activeSkills = [{ id: "9", source: "system", name: "压缩后技能", content: "压缩重建时的最新技能正文", hasFiles: true }];
                return "保留已确认创作目标";
            },
            requestTurn: async (request) => {
                turnCalls += 1;
                if (trigger === "provider context limit" && turnCalls === 1) {
                    assert.ok(!request.systemPrompt.includes("压缩重建时的最新技能正文"));
                    assert.ok(!request.tools.some((tool) => tool.function.name === "read_skill_file"));
                    throw new CanvasAgentRequestError("maximum context length exceeded", 400, "context_length_exceeded");
                }
                assert.equal(checkpointCalls, 1);
                assert.ok(request.systemPrompt.includes("压缩重建时的最新技能正文"));
                assert.ok(request.systemPrompt.includes("保留已确认创作目标"));
                assert.ok(request.systemPrompt.includes("【系统 Skill 附属文件】"));
                assert.ok(!request.systemPrompt.includes("【总创作流程 Skill"));
                assert.ok(request.tools.some((tool) => tool.function.name === "read_skill_file"));
                assert.ok(!request.messages.some((message) => message.role === "user" && message.content === oldText));
                return nativeTurn([], "已继续");
            },
        }));
        assert.equal(turnCalls, trigger === "estimated budget" ? 1 : 2);
        assert.equal(result.contextCheckpoint, "保留已确认创作目标");
    });
}

test("film mode inspects original nodes before paid continuation and supplies current scoped guidance", async () => {
    const executed: string[] = [];
    await runCanvasAgent(input({
        userText: "继续成片",
        oneSentenceFilm: { getFilm: () => ({ brief: "茶铺", nodeIds: ["saved-shot"], status: "running" }), resume: true },
        executeAction: async action => { executed.push(action.name + ":" + (action.arguments.nodeId || "")); return { ok: true }; },
        requestTurn: async request => {
            assert.deepEqual(executed, ["get_generation_config:", "get_canvas_summary:", "get_node:saved-shot"]);
            assert.match(request.systemPrompt, /一句话成片：本轮用户已授权自主完成/);
            assert.match(request.systemPrompt, /saved-shot/);
            assert.ok(request.messages.some(message => message.role === "tool" && message.name === "get_node"));
            return nativeTurn([], "需要继续");
        },
    }));
});

test("film gets 24 model rounds while an ordinary request retains its 12-round limit", async () => {
    for (const isFilm of [false, true]) {
        let rounds = 0;
        const result = await runCanvasAgent(input({
            oneSentenceFilm: isFilm ? { getFilm: () => ({ brief: "茶铺", nodeIds: [], status: "running" }), resume: false } : undefined,
            requestTurn: async request => {
                rounds += 1;
                assert.equal(request.systemPrompt.includes("【一句话成片："), isFilm);
                return nativeTurn([{ id: `inspect-${rounds}`, name: "get_canvas_summary", arguments: {} }]);
            },
        }));
        assert.equal(rounds, isFilm ? 24 : 12);
        assert.match(result.reply, /步数上限/);
    }
});

test("full film refuses a text-only completion and corrects it at most once", async () => {
    let turns = 0;
    const result = await runCanvasAgent(input({
        oneSentenceFilm: { getFilm: () => ({ brief: "茶铺", nodeIds: [], status: "running", pipelineMode: "full" }), resume: false },
        requestTurn: async request => {
            turns += 1;
            if (turns === 2) assert.ok(JSON.stringify(request.messages).includes("full_film_workflow_required"));
            return nativeTurn([], "已做完全部成片");
        },
    }));
    assert.equal(turns, 2);
    assert.match(result.reply, /完整成片尚未完成/);
});

test("full correction proceeds through planned graph then its saved execution", async () => {
    let currentFilm: OneSentenceFilm = { brief: "茶铺", nodeIds: [], status: "running", pipelineMode: "full" };
    let turns = 0;
    const workflow = { scriptNodeId: "script", shots: [{ textNodeId: "text", imageNodeId: "image", videoNodeId: "video" }] };
    const mutations: string[] = [];
    const result = await runCanvasAgent(input({
        oneSentenceFilm: { getFilm: () => currentFilm, resume: false },
        requestTurn: async request => {
            turns += 1;
            if (turns === 1) return nativeTurn([], "制作方案如下");
            if (turns === 2) return nativeTurn([{ id: "create", name: "create_film_workflow", arguments: { title: "茶铺", script: "茶铺开门，主人泡茶迎客。", shots: [{ title: "晨茶", description: "主人泡茶", imagePrompt: "同一主人在店内泡茶", videoPrompt: "缓慢推进主人泡茶的双手", seconds: 5 }], sourceNodeIds: [] } }]);
            if (turns === 3) {
                assert.match(request.systemPrompt, /已保存工作流/);
                return nativeTurn([{ id: "run", name: "run_film_workflow", arguments: {} }]);
            }
            return nativeTurn([], "完整成片已保存");
        },
        executeAction: async action => {
            if (action.name === "create_film_workflow") {
                mutations.push(action.name);
                currentFilm = { ...currentFilm, workflow, nodeIds: ["script", "text", "image", "video"] };
                return { ok: true, workflow, nodeIds: currentFilm.nodeIds, status: "planned" };
            }
            if (action.name === "run_film_workflow") { mutations.push(action.name); return { ok: true, status: "success", nodeId: "video" }; }
            return { ok: true };
        },
    }));
    assert.deepEqual(mutations, ["create_film_workflow", "run_film_workflow"]);
    assert.equal(result.reply, "完整成片已保存");
});

test("a failed or waiting workflow run is reported without a forced repeat", async () => {
    for (const status of ["failed", "waiting"]) {
        let turns = 0;
        let runs = 0;
        const result = await runCanvasAgent(input({
            oneSentenceFilm: { getFilm: () => ({ brief: "茶铺", nodeIds: [], status: "running", pipelineMode: "full", workflow: { scriptNodeId: "script", shots: [{ textNodeId: "text", imageNodeId: "image", videoNodeId: "video" }] } }), resume: true },
            requestTurn: async () => ++turns === 1 ? nativeTurn([{ id: "run", name: "run_film_workflow", arguments: {} }]) : nativeTurn([], "已完成"),
            executeAction: async action => {
                if (action.name === "run_film_workflow") { runs += 1; return { ok: false, status, message: "任务未完成" }; }
                return { ok: true };
            },
        }));
        assert.equal(turns, 2);
        assert.equal(runs, 1);
        assert.match(result.reply, /尚未完成/);
    }
});

for (const firstAction of ["activate_skills", "create_text_node"] as const) {
    test(`activation blocks all same-turn writes with ${firstAction} first and preserves receipts for next-turn execution`, async () => {
        let activeSkills: RunCanvasAgentInput["activeSkillContents"];
        let calls = 0;
        const executed: string[] = [];
        const tools = [...CANVAS_AGENT_TOOLS, ...CANVAS_AGENT_SKILL_DISCOVERY_TOOLS];
        const activation = { id: "activate", name: "activate_skills", arguments: { skillIds: [7] } };
        const write = { id: "same-turn-write", name: "create_text_node", arguments: { title: "技能方案", content: "待技能指导的内容" } };
        const result = await runCanvasAgent(input({
            tools,
            getActiveSkillContents: () => activeSkills,
            requestTurn: async (request) => {
                calls += 1;
                if (calls === 1) return nativeTurn(firstAction === "activate_skills" ? [activation, write] : [write, activation]);
                const blocked = request.messages.find((message) => message.role === "tool" && message.toolCallId === "same-turn-write");
                assert.equal(blocked?.role, "tool");
                if (blocked?.role === "tool") assert.equal(JSON.parse(blocked.content).code, "skill_content_review_required");
                const activated = request.messages.find((message) => message.role === "tool" && message.toolCallId === "activate");
                assert.equal(activated?.role, "tool");
                if (activated?.role === "tool") assert.equal(JSON.parse(activated.content).ok, true);
                assert.ok(request.systemPrompt.includes("按已激活 Skill 正文重新创作"));
                if (calls === 2) {
                    assert.deepEqual(executed, ["activate"]);
                    return nativeTurn([{ id: "reviewed-write", name: "create_text_node", arguments: { title: "技能方案", content: "已读正文后的正式内容" } }]);
                }
                const saved = request.messages.find((message) => message.role === "tool" && message.toolCallId === "reviewed-write");
                assert.equal(saved?.role, "tool");
                if (saved?.role === "tool") assert.equal(JSON.parse(saved.content).nodeId, "text-1");
                return nativeTurn([], "已按技能保存");
            },
            executeAction: async (action) => {
                executed.push(action.id);
                if (action.name === "activate_skills") {
                    activeSkills = [{ id: "7", source: "system", name: "新技能", content: "按已激活 Skill 正文重新创作" }];
                    return { ok: true, activeSkillIds: [7] };
                }
                assert.equal(action.id, "reviewed-write");
                return { ok: true, nodeId: "text-1" };
            },
        }));
        assert.deepEqual(executed, ["activate", "reviewed-write"]);
        assert.equal(result.reply, "已按技能保存");
    });
}

test("failed activation blocks every media and state mutation in its batch regardless of order", async () => {
    const executed: string[] = [];
    const actions = [
        normalizeCanvasAgentAction("generate_image", { prompt: "猫", sourceNodeIds: [] }, "image"),
        normalizeCanvasAgentAction("activate_skills", { skillIds: [7] }, "activate"),
        normalizeCanvasAgentAction("get_canvas_summary", {}, "query"),
        normalizeCanvasAgentAction("set_agent_state", { phase: "complete" }, "state"),
        normalizeCanvasAgentAction("generate_video", { prompt: "猫在跑", sourceNodeIds: [] }, "video"),
        normalizeCanvasAgentAction("generate_audio", { prompt: "旁白", sourceNodeIds: [] }, "audio"),
        normalizeCanvasAgentAction("edit_image", { prompt: "加帽子", sourceNodeIds: ["n1"] }, "edit"),
        normalizeCanvasAgentAction("create_connection", { fromNodeId: "n1", toNodeId: "n2" }, "connect"),
        normalizeCanvasAgentAction("delete_node", { nodeId: "n1" }, "delete"),
    ];
    const result = await executeActions(actions, createCanvasAgentState(), async (action) => {
        executed.push(action.id);
        return action.name === "activate_skills" ? { ok: false, code: "skill_not_found" } : { ok: true };
    });
    assert.deepEqual(executed, ["activate", "query"]);
    assert.equal(result.state.phase, "intake");
    assert.deepEqual(result.items.map(({ action }) => action.id), actions.map((action) => action.id));
    for (const { action, result: receipt } of result.items) {
        if (action.id === "activate") assert.equal(receipt.code, "skill_not_found");
        else if (action.id === "query") assert.equal(receipt.ok, true);
        else assert.equal(receipt.code, "skill_content_review_required");
    }
});

test("skill file reading defers same-turn generation until the model receives the actual file content", async () => {
    let calls = 0;
    const executed: string[] = [];
    const generation = { id: "unreviewed-media", name: "generate_image", arguments: { prompt: "封面", sourceNodeIds: [] } };
    const result = await runCanvasAgent(input({
        userText: "按 Skill 生成封面",
        tools: [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL],
        activeSkillContents: [{ id: "7", source: "system", name: "封面技能", content: "先读 references/cover.md", hasFiles: true }],
        requestTurn: async (request) => {
            calls += 1;
            if (calls === 1) return nativeTurn([
                generation,
                { id: "read", name: "read_skill_file", arguments: { skillId: "7", path: "references/cover.md" } },
            ]);
            const file = request.messages.find((message) => message.role === "tool" && message.toolCallId === "read");
            assert.equal(file?.role, "tool");
            if (file?.role === "tool") assert.equal(JSON.parse(file.content).content, "附属正文：使用竖版构图");
            const blocked = request.messages.find((message) => message.role === "tool" && message.toolCallId === "unreviewed-media");
            assert.equal(blocked?.role, "tool");
            if (blocked?.role === "tool") assert.equal(JSON.parse(blocked.content).code, "skill_content_review_required");
            if (calls === 2) {
                assert.deepEqual(executed, ["read"]);
                return nativeTurn([{ ...generation, id: "reviewed-media", arguments: { prompt: "封面使用竖版构图", size: "9:16", sourceNodeIds: [] } }]);
            }
            return nativeTurn([], "封面已提交");
        },
        executeAction: async (action) => {
            executed.push(action.id);
            if (action.name === "read_skill_file") return { ok: true, content: "附属正文：使用竖版构图" };
            assert.equal(action.id, "reviewed-media");
            assert.equal(action.arguments.size, "9:16");
            return { ok: true, nodeId: "image-1", taskId: "task-1", status: "loading" };
        },
    }));
    assert.deepEqual(executed, ["read", "reviewed-media"]);
    assert.deepEqual(result.state.pendingTaskIds, ["task-1"]);
});

test("required skill parts block writes across turns while queries remain available until every main part is read", async () => {
    const requiredFiles = [{ skillId: "7", path: "SKILL.md" }, { skillId: "7", path: "SKILL.part-002.md" }];
    const readPaths = new Set<string>();
    let calls = 0;
    const executed: string[] = [];
    const imageCall = (id: string) => ({ id, name: "generate_image", arguments: { prompt: "按完整技能创作", sourceNodeIds: [] } });
    const blockedFeedback = (request: TurnRequest, id: string) => {
        const feedback = request.messages.find((message) => message.role === "tool" && message.toolCallId === id);
        assert.equal(feedback?.role, "tool");
        if (feedback?.role !== "tool") throw new Error("missing feedback");
        const result = JSON.parse(feedback.content);
        assert.equal(result.code, "skill_content_review_required");
        return result.unreadRequiredSkillFiles;
    };
    const result = await runCanvasAgent(input({
        tools: [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL],
        activeSkillContents: [{ id: "7", source: "system", name: "长技能", content: "按nextPath读取SKILL.md主文件全部parts", hasFiles: true }],
        getUnreadRequiredSkillFiles: () => requiredFiles.filter((file) => !readPaths.has(file.path)),
        requestTurn: async (request) => {
            calls += 1;
            if (calls === 1) return nativeTurn([
                { id: "query", name: "get_canvas_summary", arguments: {} },
                { id: "unread-text", name: "create_text_node", arguments: { title: "方案", content: "尚未读正文" } },
                imageCall("unread-image"),
            ]);
            assert.deepEqual(blockedFeedback(request, "unread-text"), requiredFiles);
            assert.deepEqual(blockedFeedback(request, "unread-image"), requiredFiles);
            if (calls === 2) {
                assert.deepEqual(executed, ["query"]);
                return nativeTurn([
                    { id: "read-first", name: "read_skill_file", arguments: requiredFiles[0] },
                    imageCall("same-turn-first"),
                ]);
            }
            assert.deepEqual(blockedFeedback(request, "same-turn-first"), requiredFiles, "batch snapshot must remain intact after reading a part");
            if (calls === 3) return nativeTurn([imageCall("partial-read-image")]);
            assert.deepEqual(blockedFeedback(request, "partial-read-image"), [requiredFiles[1]]);
            if (calls === 4) return nativeTurn([
                { id: "read-last", name: "read_skill_file", arguments: requiredFiles[1] },
                imageCall("same-turn-last"),
            ]);
            assert.deepEqual(blockedFeedback(request, "same-turn-last"), [requiredFiles[1]]);
            if (calls === 5) {
                assert.deepEqual(executed, ["query", "read-first", "read-last"]);
                return nativeTurn([imageCall("reviewed-image")]);
            }
            return nativeTurn([], "已按完整主文件创建图片");
        },
        executeAction: async (action) => {
            executed.push(action.id);
            if (action.name === "read_skill_file") {
                readPaths.add(String(action.arguments.path));
                return { ok: true, content: action.id === "read-first" ? "正文第一部分" : "正文最后部分", fullyRead: readPaths.size === 2 };
            }
            return action.name === "get_canvas_summary" ? { ok: true, nodes: [] } : { ok: true, nodeId: "image-1" };
        },
    }));
    assert.deepEqual(executed, ["query", "read-first", "read-last", "reviewed-image"]);
    assert.equal(result.reply, "已按完整主文件创建图片");
});

test("short inline skill roots permit immediate creation without a redundant skill-file read", async () => {
    let calls = 0;
    const executed: string[] = [];
    const result = await runCanvasAgent(input({
        tools: [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL],
        activeSkillContents: [{ id: "7", source: "system", name: "短技能", content: "已全文内联：使用具体材质和布光方案", hasFiles: true }],
        getUnreadRequiredSkillFiles: () => [],
        requestTurn: async (request) => {
            calls += 1;
            assert.ok(request.systemPrompt.includes("已全文内联：使用具体材质和布光方案"));
            return calls === 1
                ? nativeTurn([{ id: "create", name: "create_text_node", arguments: { title: "材质方案", content: "柔和布光方案" } }])
                : nativeTurn([], "已保存材质方案");
        },
        executeAction: async (action) => {
            executed.push(action.name);
            return { ok: true, nodeId: "text-1" };
        },
    }));
    assert.deepEqual(executed, ["create_text_node"]);
    assert.equal(result.reply, "已保存材质方案");
});

test("a premature final reply requests the missing skill files before allowing completion", async () => {
    const requiredFile = { skillId: "7", path: "SKILL.md" };
    let read = false;
    let calls = 0;
    const executed: string[] = [];
    const result = await runCanvasAgent(input({
        tools: [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL],
        getUnreadRequiredSkillFiles: () => read ? [] : [requiredFile],
        requestTurn: async (request) => {
            calls += 1;
            if (calls === 1) return nativeTurn([], "已经按技能全部完成");
            const feedback = request.messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("工具执行结果"));
            assert.equal(feedback?.role, "user");
            if (feedback?.role === "user" && typeof feedback.content === "string") {
                const receipt = JSON.parse(feedback.content.slice(feedback.content.indexOf("\n") + 1));
                assert.equal(receipt.code, "skill_content_review_required");
                assert.deepEqual(receipt.unreadRequiredSkillFiles, [requiredFile]);
            }
            if (calls === 2) return nativeTurn([{ id: "read", name: "read_skill_file", arguments: requiredFile }]);
            if (calls === 3) return nativeTurn([{ id: "create", name: "create_text_node", arguments: { title: "完整方案", content: "已读正文后创作" } }]);
            return nativeTurn([], "已读正文并保存方案");
        },
        executeAction: async (action) => {
            executed.push(action.id);
            if (action.name === "read_skill_file") { read = true; return { ok: true, content: "技能全文" }; }
            return { ok: true, nodeId: "text-1" };
        },
    }));
    assert.deepEqual(executed, ["read", "create"]);
    assert.equal(result.reply, "已读正文并保存方案");
    assert.equal(calls, 4);
});

test("unread skills bound premature-final retries and report incomplete work at the step limit", async () => {
    let calls = 0;
    let executed = 0;
    const result = await runCanvasAgent(input({
        getUnreadRequiredSkillFiles: () => [{ skillId: "7", path: "SKILL.part-002.md" }],
        requestTurn: async () => { calls += 1; return nativeTurn([], "已完成全部技能任务"); },
        executeAction: async () => { executed += 1; return { ok: true }; },
    }));
    assert.equal(calls, 12);
    assert.equal(executed, 0);
    assert.match(result.reply, /主文件尚未读完/);
    assert.match(result.reply, /创作仍未完成/);
    assert.ok(!result.reply.includes("已完成全部技能任务"));
});
