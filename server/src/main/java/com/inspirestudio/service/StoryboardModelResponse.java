package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import io.agentscope.core.agent.accumulator.ToolCallsAccumulator;
import io.agentscope.core.message.ContentBlock;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ThinkingBlock;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.model.ChatResponse;
import io.agentscope.core.model.ExecutionConfig;
import io.agentscope.core.model.GenerateOptions;
import io.agentscope.core.model.Model;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import reactor.core.publisher.Mono;

/** Exactly one model invocation; storyboard business operations never enter an agent tool loop. */
@Slf4j
final class StoryboardModelResponse {
    private static final int MAX_RESPONSE_CHARS = 2_000_000;
    private static final Set<String> INCOMPLETE_REASONS = Set.of(
            "length", "max_tokens", "max_output_tokens", "content_filter", "safety", "recitation", "blocked", "error");

    private StoryboardModelResponse() {}

    static Mono<Msg> call(Model model, String systemPrompt, String userPayload) {
        return Mono.defer(() -> {
            List<Msg> messages = List.of(
                    Msg.builder().role(MsgRole.SYSTEM).textContent(systemPrompt).build(),
                    Msg.builder().role(MsgRole.USER).textContent(userPayload).build());
            GenerateOptions options = GenerateOptions.builder().stream(false)
                    .executionConfig(ExecutionConfig.builder().maxAttempts(1).retryOn(error -> false)
                            .timeout(Duration.ofSeconds(300)).build()).build();
            return model.stream(messages, List.of(), options).collectList().map(StoryboardModelResponse::aggregate);
        });
    }

    static Msg aggregate(List<ChatResponse> responses) {
        StringBuilder text = new StringBuilder();
        ToolCallsAccumulator tools = new ToolCallsAccumulator();
        Set<String> finishReasons = new LinkedHashSet<>();
        Set<String> blockTypes = new LinkedHashSet<>();
        int thinkingBlocks = 0;
        int toolBlocks = 0;
        boolean incomplete = false;
        try {
            for (ChatResponse response : responses) {
                if (response.getFinishReason() != null) {
                    String reason = response.getFinishReason().toLowerCase(Locale.ROOT);
                    // Log only known labels, never provider-controlled free text.
                    finishReasons.add(INCOMPLETE_REASONS.contains(reason) || Set.of("stop", "end_turn", "tool_calls", "function_call").contains(reason)
                            ? reason : "other");
                    incomplete |= INCOMPLETE_REASONS.contains(reason);
                }
                if (response.getContent() == null) continue;
                for (ContentBlock block : response.getContent()) {
                    if (block instanceof TextBlock content) {
                        blockTypes.add("text");
                        if (content.getText() != null) text.append(content.getText());
                        if (text.length() > MAX_RESPONSE_CHARS) throw invalid("分镜模型返回的内容过长，原分镜保持不变。请缩小章节范围后重试");
                    } else if (block instanceof ThinkingBlock) {
                        blockTypes.add("thinking");
                        thinkingBlocks++;
                    } else if (block instanceof ToolUseBlock tool) {
                        blockTypes.add("tool_use");
                        toolBlocks++;
                        tools.add(tool);
                    } else blockTypes.add("other");
                }
            }
            if (incomplete) throw invalid("分镜模型输出被截断或被渠道拦截，原分镜保持不变。请缩小章节范围或切换文本模型");
            var calls = tools.buildAllToolCalls();
            if (!calls.isEmpty()) {
                if (calls.size() != 1 || !"generate_response".equals(calls.getFirst().getName())
                        || calls.getFirst().getInput() == null || calls.getFirst().getInput().isEmpty()) {
                    throw invalid("分镜模型返回了不支持的工具请求，原分镜保持不变。请切换文本模型后重试");
                }
                // A compatibility channel can return this response envelope even with no tools sent.
                // It is data only: no tool is executed and no additional model request is made.
                return Msg.builder().role(MsgRole.ASSISTANT).textContent(JSON.toJSONString(calls.getFirst().getInput())).build();
            }
            if (text.toString().isBlank()) throw new EmptyResponseException();
            return Msg.builder().role(MsgRole.ASSISTANT).textContent(text.toString()).build();
        } catch (BusinessException error) {
            log.warn("分镜模型响应不可用: responses={}, blockTypes={}, textLength={}, thinkingBlocks={}, toolBlocks={}, finishReasons={}",
                    responses.size(), blockTypes, text.length(), thinkingBlocks, toolBlocks, finishReasons);
            throw error;
        } catch (RuntimeException error) {
            log.warn("分镜模型响应聚合失败: responses={}, blockTypes={}, textLength={}, thinkingBlocks={}, toolBlocks={}, finishReasons={}",
                    responses.size(), blockTypes, text.length(), thinkingBlocks, toolBlocks, finishReasons);
            throw invalid("分镜模型返回的响应格式不完整，原分镜保持不变。请重试本章或切换文本模型");
        }
    }

    private static BusinessException invalid(String message) {
        return new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, message);
    }

    /** Explicitly distinguish an empty answer from truncation, parsing errors, and provider failures. */
    static final class EmptyResponseException extends BusinessException {
        EmptyResponseException() {
            super(ErrorCode.THIRD_PARTY_CALL_ERROR, "分镜模型未返回正文，原分镜保持不变。请重试本章或切换文本模型");
        }
    }
}
