package com.inspirestudio.agent;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.ai.AiErrorDetails;
import com.inspirestudio.ai.AiErrorSupport;
import com.inspirestudio.ai.AiProviderException;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.service.TextTokenBillingService;
import io.agentscope.core.agent.accumulator.ToolCallsAccumulator;
import io.agentscope.core.formatter.ResponseFormat;
import io.agentscope.core.formatter.openai.dto.JsonSchema;
import io.agentscope.core.message.*;
import io.agentscope.core.model.*;
import io.agentscope.core.model.exception.OpenAIException;
import io.agentscope.core.model.transport.HttpTransportException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Mono;

/** Single billed model turn for the vendored infinite-canvas runtime. No server-side tool execution. */
@Service
@RequiredArgsConstructor
public class CanvasAgentTurnService {
    private static final Set<String> MODES = Set.of("native", "structured-json", "prompt-json");
    private final AgentScopeModelFactory models;

    public record TurnRequest(String model, String systemPrompt, List<ProtocolMessage> messages,
                              List<ToolDefinition> tools, String toolMode, Map<String, Object> jsonSchema) {}
    public record ProtocolMessage(String role, Object content, String reasoningContent,
                                  List<ToolCall> toolCalls, String toolCallId, String name) {}
    public record ToolCall(String id, String name, Map<String, Object> arguments) {}
    public record ToolDefinition(String type, ToolFunction function) {}
    public record ToolFunction(String name, String description, Map<String, Object> parameters) {}
    public record TurnResponse(String content, String reasoningContent, List<ToolCall> toolCalls,
                               String toolMode, String model, long inputTokens, long outputTokens, int tokenCredits) {}

    public Mono<TurnResponse> turn(Long userId, TurnRequest request) {
        return Mono.defer(() -> {
            validate(request);
            Mono<Model> selected = StringUtils.hasText(request.model())
                    ? models.resolveTextModel(request.model().trim(), userId).map(AgentScopeModelFactory.TextModelSelection::agentModel)
                    : models.defaultTextModel(userId);
            return selected.flatMap(model -> invoke(model, request));
        }).onErrorMap(error -> error instanceof TurnException ? error : TurnException.from(error));
    }

    private Mono<TurnResponse> invoke(Model model, TurnRequest request) {
        List<Msg> messages = toMessages(request);
        List<ToolSchema> tools = "native".equals(request.toolMode())
                ? request.tools().stream().map(tool -> ToolSchema.builder().name(tool.function().name())
                    .description(tool.function().description()).parameters(tool.function().parameters()).build()).toList()
                : List.of();
        GenerateOptions.Builder options = GenerateOptions.builder().stream(false)
                .executionConfig(ExecutionConfig.builder().maxAttempts(1).retryOn(error -> false)
                        .timeout(Duration.ofSeconds(180)).build());
        if ("structured-json".equals(request.toolMode()) && request.jsonSchema() != null) {
            options.responseFormat(ResponseFormat.jsonSchema(JsonSchema.builder().name("canvas_agent_actions")
                    .schema(request.jsonSchema()).build()));
        }
        // Cancellation of the HTTP response subscription cancels the model stream. No detached subscription/cache.
        return model.stream(messages, tools, options.build()).collectList().map(responses -> aggregate(model, request.toolMode(), responses));
    }

    static TurnResponse aggregate(Model model, String mode, List<ChatResponse> responses) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        ToolCallsAccumulator calls = new ToolCallsAccumulator();
        long input = -1;
        long output = -1;
        for (ChatResponse response : responses) {
            if (response.getFinishReason() != null && Set.of("length", "content_filter", "max_tokens", "MAX_TOKENS").contains(response.getFinishReason())) {
                throw new TurnException(502, "incomplete_output", "文本模型输出未完成：" + response.getFinishReason());
            }
            if (response.getUsage() != null) {
                input = Math.max(input, response.getUsage().getInputTokens());
                output = Math.max(output, response.getUsage().getOutputTokens());
            }
            if (response.getContent() == null) continue;
            for (ContentBlock block : response.getContent()) {
                if (block instanceof TextBlock text) content.append(text.getText());
                else if (block instanceof ThinkingBlock thinking) reasoning.append(thinking.getThinking());
                else if (block instanceof ToolUseBlock tool) calls.add(tool);
            }
        }
        List<ToolCall> toolCalls = calls.buildAllToolCalls().stream().map(call -> {
            if (!StringUtils.hasText(call.getName())) throw new TurnException(502, "invalid_tool", "工具调用缺少名称");
            return new ToolCall(StringUtils.hasText(call.getId()) ? call.getId() : UUID.randomUUID().toString(),
                    call.getName(), call.getInput() == null ? Map.of() : call.getInput());
        }).toList();
        if (responses.isEmpty() || (content.isEmpty() && toolCalls.isEmpty())) {
            throw new TurnException(502, "empty_output", "文本模型没有返回内容");
        }
        return new TurnResponse(content.toString(), reasoning.isEmpty() ? null : reasoning.toString(), toolCalls,
                mode, model.getModelName(), input, output, TextTokenBillingService.chargedCredits(model));
    }

    static List<Msg> toMessages(TurnRequest request) {
        List<Msg> result = new ArrayList<>();
        if (StringUtils.hasText(request.systemPrompt())) result.add(Msg.builder().role(MsgRole.SYSTEM).textContent(request.systemPrompt()).build());
        for (ProtocolMessage message : request.messages()) {
            List<ContentBlock> blocks = new ArrayList<>();
            if ("tool".equals(message.role())) {
                blocks.add(new ToolResultBlock(message.toolCallId(), message.name(), text(stringContent(message.content()))));
            } else {
                addContent(blocks, message.content());
                if (StringUtils.hasText(message.reasoningContent())) {
                    blocks.add(ThinkingBlock.builder().thinking(message.reasoningContent()).build());
                }
                if (message.toolCalls() != null) for (ToolCall call : message.toolCalls()) {
                    blocks.add(new ToolUseBlock(call.id(), call.name(), call.arguments()));
                }
            }
            result.add(Msg.builder().role(MsgRole.valueOf(message.role().toUpperCase(Locale.ROOT))).content(blocks).build());
        }
        return result;
    }

    private static TextBlock text(String text) { return TextBlock.builder().text(text).build(); }
    private static String stringContent(Object value) { return value instanceof String text ? text : ""; }
    private static void addContent(List<ContentBlock> blocks, Object content) {
        if (content instanceof String value) { if (!value.isEmpty()) blocks.add(text(value)); return; }
        if (content == null) return;
        if (!(content instanceof List<?> parts)) throw invalid("消息正文格式不合法");
        for (Object part : parts) {
            if (!(part instanceof Map<?, ?> value)) throw invalid("消息内容块格式不合法");
            if ("text".equals(value.get("type")) && value.get("text") instanceof String text) blocks.add(text(text));
            else if ("image_url".equals(value.get("type")) && value.get("image_url") instanceof Map<?, ?> image
                    && image.get("url") instanceof String url) {
                if (url.startsWith("data:image/") && url.contains(";base64,")) {
                    int split = url.indexOf(";base64,");
                    blocks.add(new ImageBlock(new Base64Source(url.substring(5, split), url.substring(split + 8))));
                } else if (url.startsWith("https://") || url.startsWith("http://")) blocks.add(new ImageBlock(new URLSource(url)));
                else throw invalid("图片引用格式不合法");
            } else throw invalid("不支持的消息内容块");
        }
    }

    static void validate(TurnRequest request) {
        if (request == null || !MODES.contains(request.toolMode() == null ? "" : request.toolMode())) throw invalid("Agent工具模式不合法");
        if (request.messages() == null || request.messages().isEmpty() || request.messages().size() > 2048) throw invalid("Agent消息数量不合法");
        if (request.tools() == null || request.tools().size() > 128) throw invalid("Agent工具数量不合法");
        if (JSON.toJSONString(request).getBytes(StandardCharsets.UTF_8).length > 8 * 1024 * 1024) throw invalid("Agent输入过长");
        for (ToolDefinition tool : request.tools()) {
            if (tool == null || !"function".equals(tool.type()) || tool.function() == null || !StringUtils.hasText(tool.function().name())
                    || tool.function().parameters() == null) throw invalid("Agent工具定义不合法");
        }
        for (ProtocolMessage message : request.messages()) {
            if (message == null || !Set.of("system", "user", "assistant", "tool").contains(message.role() == null ? "" : message.role())) throw invalid("Agent消息角色不合法");
            if ("tool".equals(message.role()) && (!StringUtils.hasText(message.toolCallId()) || !StringUtils.hasText(message.name()) || !(message.content() instanceof String))) throw invalid("工具结果缺少调用标识或正文");
            if (message.toolCalls() != null) for (ToolCall call : message.toolCalls()) {
                if (call == null || !StringUtils.hasText(call.id()) || !StringUtils.hasText(call.name()) || call.arguments() == null) throw invalid("历史工具调用格式不合法");
            }
        }
    }

    private static BusinessException invalid(String message) { return new BusinessException(ErrorCode.PARAM_INVALID, message); }

    public static final class TurnException extends RuntimeException {
        private final int status;
        private final String code;
        public TurnException(int status, String code, String message) { super(message); this.status = status; this.code = code; }
        public int status() { return status; }
        public String code() { return code; }
        static TurnException from(Throwable error) {
            // Preserve safe provider status/code: fallback must never turn an unknown transport failure into a new call.
            Throwable current = error;
            for (int depth = 0; current != null && depth < 8; depth++, current = current.getCause()) {
                if (current instanceof TurnException turn) return turn;
                if (current instanceof OpenAIException provider && provider.getStatusCode() != null) {
                    AiErrorDetails safe = AiErrorSupport.classifyProviderResponse(provider.getStatusCode(), provider.getResponseBody(), "submission");
                    return new TurnException(provider.getStatusCode(), safe.code(), safe.message());
                }
                if (current instanceof HttpTransportException provider && provider.getStatusCode() != null) {
                    AiErrorDetails safe = AiErrorSupport.classifyProviderResponse(provider.getStatusCode(), provider.getResponseBody(), "submission");
                    return new TurnException(provider.getStatusCode(), safe.code(), safe.message());
                }
                if (current instanceof AiProviderException provider) {
                    AiErrorDetails safe = provider.getDetails();
                    return new TurnException(safe.httpStatus() == null ? 502 : safe.httpStatus(), safe.code(), safe.message());
                }
                if (current instanceof BusinessException business) {
                    int status = business.getCode() == ErrorCode.TOKEN_INVALID ? 401
                            : business.getCode() == ErrorCode.PERMISSION_DENIED ? 403
                            : business.getCode() == ErrorCode.PARAM_INVALID || business.getCode() == ErrorCode.PARAM_MISSING ? 400 : 502;
                    return new TurnException(status, String.valueOf(business.getCode()), AiErrorSupport.fromThrowable(business, "server", "submission").message());
                }
            }
            return new TurnException(502, "unknown_model_failure", AiErrorSupport.fromThrowable(error, "provider", "submission").message());
        }
    }
}
