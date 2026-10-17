import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/features/settings/stores/use-config-store";
import { buildInfiniteCanvasContext, supportedCanvasAgentTools } from "./canvas-adapter";
import { loadCanvasAgentSkills } from "./skill-library";
import { createCanvasAgentSkillDiscovery } from "./skill-discovery";
import { createCanvasAgentState, runCanvasAgent } from "./upstream/canvas-agent-runtime";
import { CANVAS_AGENT_SKILL_DISCOVERY_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL } from "./upstream/canvas-agent-tools";

test("a discovered long skill cannot create a card until all main-file parts have been read", async () => {
    const skill = { id: 23, name: "商品摄影长技能", targetType: "image" as const, description: "商品摄影", coverUrl: "", systemPrompt: "保留主体真实釉面与布光层次。".repeat(2200) };
    const tools = [...supportedCanvasAgentTools, ...CANVAS_AGENT_SKILL_DISCOVERY_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL];
    const discovery = await createCanvasAgentSkillDiscovery({ fetchCatalogue: async () => [skill], fetchSkill: async () => skill, tools });
    const config = { ...defaultConfig, agentModel: "test-model", textModel: "test-model" };
    const snapshot = { projectId: "long-skills-test", title: "长技能测试", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    let calls = 0;
    let writes = 0;
    const result = await runCanvasAgent({
        config, initialState: createCanvasAgentState(), protocolMessages: [], references: [],
        userText: `用商品摄影技能创建方案文本卡片\n${discovery.userGuidance}`, tools,
        getActiveSkillContents: () => discovery.activeSkillContents,
        getUnreadRequiredSkillFiles: () => discovery.unreadRequiredFiles,
        getContext: state => buildInfiniteCanvasContext(snapshot, state, config),
        requestTurn: async request => {
            const step = calls++;
            const call = (name: string, args: Record<string, unknown>) => ({ content: "", toolMode: "native" as const, toolCalls: [{ id: `long-${step}`, name, arguments: args }] });
            if (step === 0) return call("search_skills", { query: "商品", targetType: "image" });
            if (step === 1) return call("activate_skills", { skillIds: [23] });
            if (step === 2 || step === 4 || step === 6) return call("create_text_node", { title: "长技能方案", content: "以柔光保留主体釉面。" });
            if (step === 3 || step === 5) {
                const receipt = request.messages.filter(message => message.role === "tool" && message.name === "create_text_node").at(-1);
                assert.ok(receipt && receipt.role === "tool");
                assert.equal(JSON.parse(receipt.content).code, "skill_content_review_required");
                assert.equal(writes, 0);
                const unread = discovery.unreadRequiredFiles;
                assert.ok(unread.length > 0);
                if (step === 3) return call("read_skill_file", unread[0]);
                return { content: "", toolMode: "native", toolCalls: unread.map((file, index) => ({ id: `read-rest-${index}`, name: "read_skill_file", arguments: { ...file } })) };
            }
            return { content: "完整读取技能后创建了方案", toolMode: "native", toolCalls: [] };
        },
        executeAction: async action => {
            if (["search_skills", "activate_skills", "read_skill_file"].includes(action.name)) return discovery.executeTool(action.name, action.arguments);
            assert.equal(action.name, "create_text_node");
            assert.deepEqual(discovery.unreadRequiredFiles, []);
            writes++;
            return { ok: true, nodeId: "long-skill-card" };
        },
    });
    assert.equal(writes, 1);
    assert.equal(calls, 8);
    assert.match(result.reply, /完整读取技能/);
});

test("a selected library skill reaches the reused Agent and executes a real tool round-trip", async () => {
    const skill = { id: 1, name: "商品摄影", targetType: "image" as const, description: "商品描述", coverUrl: "", systemPrompt: "先分析陶瓷釉面反光，再给出镜头方案。旧版本只输出 CreationPlan。" };
    const bundle = await loadCanvasAgentSkills([skill], async () => skill, { tools: supportedCanvasAgentTools });
    const config = { ...defaultConfig, agentModel: "test-model", textModel: "test-model" };
    const snapshot = { projectId: "skills-test", title: "技能测试", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    let modelCalls = 0;
    let writes = 0;
    const result = await runCanvasAgent({
        config,
        initialState: createCanvasAgentState(), protocolMessages: [], references: [],
        userText: "按所选技能创建一张文字摄影方案卡，不生成图片",
        activeSkillContents: bundle.activeSkillContents,
        getUnreadRequiredSkillFiles: () => bundle.unreadRequiredFiles,
        tools: bundle.hasFiles ? [...supportedCanvasAgentTools, CANVAS_AGENT_SKILL_FILE_TOOL] : supportedCanvasAgentTools,
        getContext: (state) => buildInfiniteCanvasContext(snapshot, state, config),
        requestTurn: async (request) => {
            assert.ok(request.systemPrompt.includes("先分析陶瓷釉面反光"));
            assert.ok(request.tools.some((tool) => tool.function.name === "create_text_node"));
            modelCalls++;
            if (modelCalls === 1) return { content: "", toolMode: "native", toolCalls: [{ id: "skill-plan", name: "create_text_node", arguments: { title: "陶瓷摄影方案", content: "用柔光保留釉面反光层次。" } }] };
            const receipt = request.messages.find((message) => message.role === "tool");
            assert.equal(receipt?.role, "tool");
            if (receipt?.role === "tool") assert.equal(JSON.parse(receipt.content).nodeId, "plan-node");
            return { content: "方案已放入画布", toolMode: "native", toolCalls: [] };
        },
        executeAction: async (action) => {
            if (action.name === "read_skill_file") return bundle.readSkillFile(action.arguments);
            assert.equal(action.name, "create_text_node");
            assert.ok(String(action.arguments.content).includes("釉面反光"));
            writes++;
            return { ok: true, nodeId: "plan-node" };
        },
    });
    assert.equal(writes, 1);
    assert.equal(modelCalls, 2);
    assert.equal(result.reply, "方案已放入画布");
});

test("the Agent discovers, activates and reads a library skill before creating content without a manual selection", async () => {
    const skill = { id: 9, name: "商品摄影", targetType: "image" as const, description: "布光与商品材质", coverUrl: "", systemPrompt: "技能正文：釉面需要保留柔和而真实的反光。" };
    const tools = [...supportedCanvasAgentTools, ...CANVAS_AGENT_SKILL_DISCOVERY_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL];
    const activated: number[][] = [];
    const discovery = await createCanvasAgentSkillDiscovery({
        fetchCatalogue: async () => [skill], fetchSkill: async () => skill, tools,
        onSkillsActivated: (selections, source) => { assert.equal(source, "auto"); activated.push(selections.map(item => item.id)); },
    });
    const config = { ...defaultConfig, agentModel: "test-model", textModel: "test-model" };
    const snapshot = { projectId: "auto-skills-test", title: "自动技能测试", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    let calls = 0;
    let writes = 0;
    const result = await runCanvasAgent({
        config, initialState: createCanvasAgentState(), protocolMessages: [], references: [],
        userText: `帮我创作一个陶瓷杯摄影方案\n${discovery.userGuidance}`, tools,
        getActiveSkillContents: () => discovery.activeSkillContents,
        getUnreadRequiredSkillFiles: () => discovery.unreadRequiredFiles,
        getContext: (state) => buildInfiniteCanvasContext(snapshot, state, config),
        requestTurn: async (request) => {
            const step = calls++;
            const call = (name: string, args: Record<string, unknown>) => ({ content: "", toolMode: "native" as const, toolCalls: [{ id: `auto-${step}`, name, arguments: args }] });
            if (step === 0) {
                assert.ok(!request.systemPrompt.includes(skill.systemPrompt));
                return call("search_skills", { query: "商品", targetType: "image" });
            }
            if (step === 1) return call("activate_skills", { skillIds: [9] });
            assert.ok(request.systemPrompt.includes(skill.systemPrompt), "activated body must reach subsequent turns");
            if (step === 2) return call("read_skill_file", { skillId: "9", path: "SKILL.md" });
            if (step === 3) {
                const read = request.messages.find(message => message.role === "tool" && message.name === "read_skill_file");
                assert.ok(read && read.role === "tool" && read.content.includes("釉面需要保留"));
                return call("create_text_node", { title: "陶瓷杯摄影", content: "以柔光保留釉面真实反光。" });
            }
            return { content: "已按自动匹配的商品摄影技能创建方案", toolMode: "native", toolCalls: [] };
        },
        executeAction: async (action) => {
            if (action.name === "search_skills" || action.name === "activate_skills" || action.name === "read_skill_file") return discovery.executeTool(action.name, action.arguments);
            assert.equal(action.name, "create_text_node");
            assert.deepEqual(discovery.currentSelections.map(item => item.id), [9]);
            writes++;
            return { ok: true, nodeId: "auto-skill-card" };
        },
    });
    assert.equal(writes, 1);
    assert.equal(calls, 5);
    assert.deepEqual(activated, [[9]]);
    assert.match(result.reply, /自动匹配/);
});
