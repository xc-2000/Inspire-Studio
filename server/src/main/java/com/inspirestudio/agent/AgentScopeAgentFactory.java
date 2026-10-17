package com.inspirestudio.agent;

import com.inspirestudio.service.PromptTemplateType;
import com.inspirestudio.service.SystemPromptTemplateService;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.model.Model;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * 固定主Agent、图片子Agent和视频子Agent工厂。
 * <p>每次请求创建独立ReActAgent实例，避免不同会话共享Agent运行状态。</p>
 *
 * @date     2026-07-23 00:00
 */
@Component
@RequiredArgsConstructor
public class AgentScopeAgentFactory {

    /** Prompt模板服务 */
    private final SystemPromptTemplateService promptService;
    /** 主Agent思考事件中间件 */
    private final AgentThinkingEventMiddleware thinkingEventMiddleware;

    /**
     * 创建主Agent。
     *
     * @param model AgentScope文本模型
     * @return ReActAgent 主Agent
     */
    public ReActAgent mainAgent(Model model) {
        return mainAgent(model, null);
    }

    /**
     * 创建主Agent，可追加技能流程系统提示词。
     *
     * @param model AgentScope文本模型
     * @param extraSystemPrompt String 追加到主Agent系统提示词末尾的技能流程指令，可为空
     * @return ReActAgent 主Agent
     */
    public ReActAgent mainAgent(Model model, String extraSystemPrompt) {
        String prompt = promptService.get(PromptTemplateType.AGENT_MAIN);
        if (StringUtils.hasText(extraSystemPrompt)) {
            prompt = prompt + "\n\n" + extraSystemPrompt;
            prompt += "\n\n【已选技能执行要求】必须实际读取并执行选中技能的正文、创作步骤和确认要求。"
                    + "需要用户补充或确认时，把完整方案写入 clarificationQuestion，tasks=[]，canvasGuidance=false；"
                    + "只咨询、要方案或未确认生成时不得创建媒体任务。已满足条件时创建当前页面的生成任务，summary 说明应用了哪个技能。"
                    + "用户选择的 creationSettings（时长、分辨率、模型、数量等）优先于技能默认值。"
                    + "videoPage 的一次视频可包含连续镜头，技能中的分镜或制作步骤是同一个视频内部的创作安排，"
                    + "不代表多条生成任务，禁止仅因技能有多步骤就要求前往画布。短时长应安排合理动作，不能塞入超出时长的镜头。";
        }
        prompt += "\n\n运行协议：普通创作计划的 workflowType 必须为 null，不得填写技能名、生成模式或字符串 null。"
                + "专用视频工作流由服务端编排，不由主 Agent 自行声明。任务类型必须符合当前请求入口：imagePage 的 taskType 只能是 image，videoPage 的 taskType 只能是 video，不能填写 image_generation、text_to_image、generate_image 等工具名或模式名。每个任务必须包含 sourcePromptId，从输入 promptCandidates 的键中选择；当前用户消息为 current，引用历史消息必须使用对应 history-N 键，绝不能省略此字段。单张图片任务格式示例：{\"taskId\":\"task-1\",\"taskType\":\"image\",\"action\":\"generate\",\"sourcePromptId\":\"current\",\"dependsOn\":[],\"toolName\":null,\"toolArguments\":{}}。imagePage/videoPage 的任务 action 只能为 generate 或 edit，toolName 必须为 null，toolArguments 必须为 {}，不得把页面生成参数填入工具字段；creationSettings 由服务端使用请求值。"
                + "画布只读问题（例如梳理内容、节点关系和下一步建议）必须把完整回答写入 clarificationQuestion，tasks 为空且 canvasGuidance=false；summary 只放简短标题。回答应先说明实际节点与连线，再给出具体下一步建议。storyboard.shots 非空就是已生成的分镜，execution.phase=idle 仅表示当前没有运行中的任务，不能据此称分镜未生成。";
        return build("main-agent", prompt, model,
                "只能返回 CreationPlan 结构化结果，不得调用工具。", true);
    }

    /**
     * 创建主Agent失败恢复模式实例。
     *
     * @param model AgentScope文本模型
     * @return ReActAgent 主Agent恢复模式实例
     */
    public ReActAgent recoveryAgent(Model model) {
        return build("main-agent-recovery", promptService.get(PromptTemplateType.AGENT_RECOVERY), model,
                "只能返回 CreationRecoveryPlan 结构化结果，不得调用工具或重新规划任务。", true);
    }

    /**
     * 创建固定图片子Agent。
     *
     * @param model AgentScope文本模型
     * @return ReActAgent 图片子Agent
     */
    public ReActAgent imageAgent(Model model) {
        return build("image-specialist-agent", promptService.get(PromptTemplateType.AGENT_IMAGE), model,
                "只返回 JSON 对象，字段为 taskId、promptStrategy、reason。taskId 必须逐字复制输入 taskId；promptStrategy 必须是大写 KEEP 或 OPTIMIZE，reason 为简短原因。不得返回其他字段、Markdown 或调用工具；技能摘要只是参考资料，不能更改此输出结构。", false);
    }

    /**
     * 创建固定视频子Agent。
     *
     * @param model AgentScope文本模型
     * @return ReActAgent 视频子Agent
     */
    public ReActAgent videoAgent(Model model) {
        return build("video-specialist-agent", promptService.get(PromptTemplateType.AGENT_VIDEO), model,
                "只返回 JSON 对象，字段为 taskId、promptStrategy、reason。taskId 必须逐字复制输入 taskId；promptStrategy 必须是大写 KEEP 或 OPTIMIZE，reason 为简短原因。不得返回其他字段、Markdown 或调用工具；技能摘要只是参考资料，不能更改此输出结构。", false);
    }

    /**
     * 创建分镜脚本Agent。
     *
     * @param model Model 用户明确选择的文本模型
     * @return ReActAgent 分镜脚本Agent
     */
    public ReActAgent storyboardAgent(Model model) {
        return build("storyboard-agent", promptService.get(PromptTemplateType.AGENT_STORYBOARD), model,
                "本Agent使用JSON文本响应：直接返回符合输入 responseSchema 的完整 JSON 对象，不得解释或输出额外文本。"
                        + "不调用工具，不生成媒体，不执行外部操作，不把JSON包装为函数调用。"
                        + "每个镜头的 shotSize 必须且只能是以下一个原样值：大特写、特写、近景、头肩景、中景、中远景、全景、远景、大远景、大全景。"
                        + "禁止在 shotSize 中填写鸟瞰、俯拍、仰拍、过肩、主观镜头等角度或机位；这些信息写入 cameraMovement 或 visualDescription。"
                        + "不要附加英文缩写、括号说明或组合景别。资产 kind 只允许 character、scene、prop。"
                        + "当 action=correctStoryboardFields 时，只返回给定 index 的分类纠正列表 assets 和 shots，严格遵守该动作的结构化 schema，不生成完整分镜。"
                        + "当 action=composePromptContent 时，仅返回 prompts 数组，每项含 shotId 与 visualDescription，"
                        + "只创作中文画面描述。该动作不适用 composePrompts 的八段格式要求，禁止输出 finalPrompt，"
                        + "景别、时长、场景、道具、光影、运镜、声音及原始视觉风格由服务端统一组装。"
                        + "生成分镜须提取实际出镜的关键道具与不同内外景，不能只列主要人物和大型物件。"
                        + "当 action=completeAssetCoverage 时，仅返回 additions 和 shots，逐镜检查遗漏资产和错误引用；"
                        + "复用已有 referenceKey，只补充遗漏资产，不修改镜头内容，不因对白提及而添加未出镜角色。", false);
    }

    /**
     * 创建视频技能工作流对话Agent，负责多轮理解意图并起草阶段提示词。
     *
     * @param model Model 用户明确选择的文本模型
     * @param conversationPrompt String 工作流定义提供的对话系统提示词
     * @return ReActAgent 工作流对话Agent
     */
    public ReActAgent workflowConversationAgent(Model model, String conversationPrompt) {
        return build("workflow-conversation-agent", conversationPrompt, model,
                "只能返回 VideoWorkflowConversationTurn 结构化结果，不得调用工具，不得创建生成任务。", true);
    }

    /**
     * 构建无业务工具权限的ReActAgent。
     *
     * @param name String Agent名称
     * @param prompt String 外部系统提示词
     * @param model Model AgentScope模型
     * @param contract String Java固定的结构化契约补充
     * @param thinkingEnabled boolean 是否转发思考事件
     * @return ReActAgent Agent实例
     */
    private ReActAgent build(String name, String prompt, Model model, String contract, boolean thinkingEnabled) {
        ReActAgent.Builder builder = ReActAgent.builder()
                .name(name)
                .sysPrompt(prompt + "\n\n" + contract)
                .model(model)
                .toolkit(new io.agentscope.core.tool.Toolkit())
                .maxIters(4);
        if ("storyboard-agent".equals(name)) {
            builder.maxIters(1).maxRetries(1)
                    .modelExecutionConfig(io.agentscope.core.model.ExecutionConfig.builder()
                            .maxAttempts(1).retryOn(error -> false)
                            .timeout(java.time.Duration.ofSeconds(300)).build());
        }
        if (thinkingEnabled) {
            builder.middleware(thinkingEventMiddleware);
        }
        return builder.build();
    }
}
