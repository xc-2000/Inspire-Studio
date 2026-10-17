package com.inspirestudio.agent;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static com.inspirestudio.agent.CanvasAgentTurnService.*;

import com.inspirestudio.agent.CanvasAgentTurnService.*;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.service.TextTokenBillingService;
import io.agentscope.core.formatter.openai.OpenAIChatFormatter;
import io.agentscope.core.formatter.openai.dto.OpenAIMessage;
import io.agentscope.core.message.*;
import io.agentscope.core.model.*;
import io.agentscope.core.model.exception.OpenAIException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class CanvasAgentTurnServiceTest {
    private static ProtocolMessage message(String role, Object content) { return new ProtocolMessage(role, content, null, null, null, null); }
    private static TurnRequest request(String model, String mode, List<ProtocolMessage> messages) {
        return new TurnRequest(model, "system", messages, List.of(new ToolDefinition("function", new ToolFunction("get_canvas", "Read canvas", Map.of("type", "object")))), mode, null);
    }
    private static ChatResponse reply() {
        return ChatResponse.builder().content(List.of(TextBlock.builder().text("完成").build()))
                .usage(new ChatUsage(123, 45, 0)).finishReason("stop").build();
    }

    @Test void preservesNativeToolProtocolAndActualUsageFromBilledSelection() {
        AgentScopeModelFactory factory = mock(AgentScopeModelFactory.class);
        TextTokenBillingService.BilledModel model = mock(TextTokenBillingService.BilledModel.class);
        when(model.getModelName()).thenReturn("selected-model");
        when(model.chargedCredits()).thenReturn(7);
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.just(reply()));
        when(factory.resolveTextModel("channel::selected-model", 19L)).thenReturn(Mono.just(new AgentScopeModelFactory.TextModelSelection(model, "channel::selected-model", "selected-model", "provider", 0)));
        List<ProtocolMessage> messages = List.of(message("user", "读取节点"),
                new ProtocolMessage("assistant", null, null, List.of(new ToolCall("call-42", "get_canvas", Map.of("nodeId", "node-1"))), null, null),
                new ProtocolMessage("tool", "{\"ok\":true,\"nodeId\":\"node-1\"}", null, null, "call-42", "get_canvas"));

        TurnResponse response = new CanvasAgentTurnService(factory).turn(19L, request("channel::selected-model", "native", messages)).block();
        assertNotNull(response);
        assertEquals(123, response.inputTokens());
        assertEquals(45, response.outputTokens());
        assertEquals(7, response.tokenCredits());
        assertEquals("selected-model", response.model());
        @SuppressWarnings("unchecked") ArgumentCaptor<List<Msg>> captured = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<GenerateOptions> options = ArgumentCaptor.forClass(GenerateOptions.class);
        verify(model).stream(captured.capture(), anyList(), options.capture());
        List<Msg> protocol = captured.getValue();
        assertEquals(MsgRole.SYSTEM, protocol.get(0).getRole());
        ToolUseBlock call = protocol.get(2).getFirstContentBlock(ToolUseBlock.class);
        assertEquals("call-42", call.getId());
        assertEquals(Map.of("nodeId", "node-1"), call.getInput());
        assertEquals(MsgRole.TOOL, protocol.get(3).getRole());
        ToolResultBlock result = protocol.get(3).getFirstContentBlock(ToolResultBlock.class);
        assertEquals(call.getId(), result.getId());
        assertEquals(call.getName(), result.getName());
        assertEquals("{\"ok\":true,\"nodeId\":\"node-1\"}", ((TextBlock) result.getOutput().getFirst()).getText());
        var formatter = new OpenAIChatFormatter() {
            List<OpenAIMessage> encode(List<Msg> input) { return doFormat(input); }
        };
        List<OpenAIMessage> wire = formatter.encode(protocol);
        assertEquals("assistant", wire.get(2).getRole());
        assertEquals("call-42", wire.get(2).getToolCalls().getFirst().getId());
        assertEquals("tool", wire.get(3).getRole());
        assertEquals("call-42", wire.get(3).getToolCallId());
        assertEquals("{\"ok\":true,\"nodeId\":\"node-1\"}", wire.get(3).getContentAsString());
        assertFalse(options.getValue().getStream());
        assertEquals(1, options.getValue().getExecutionConfig().getMaxAttempts());
        verify(factory, never()).defaultTextModel(anyLong());
    }

    @Test void usesAuthenticatedUserForDefaultModelAndJsonSchemaWithoutTools() {
        AgentScopeModelFactory factory = mock(AgentScopeModelFactory.class);
        Model model = mock(Model.class);
        when(model.getModelName()).thenReturn("default");
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.just(reply()));
        when(factory.defaultTextModel(31L)).thenReturn(Mono.just(model));
        TurnRequest request = new TurnRequest(null, "system", List.of(message("user", "hello")), List.of(), "structured-json", Map.of("type", "object"));
        new CanvasAgentTurnService(factory).turn(31L, request).block();
        ArgumentCaptor<GenerateOptions> options = ArgumentCaptor.forClass(GenerateOptions.class);
        verify(model).stream(anyList(), eq(List.of()), options.capture());
        assertEquals("json_schema", options.getValue().getResponseFormat().getType());
        assertEquals(Map.of("type", "object"), options.getValue().getResponseFormat().getJsonSchema().getSchema());
        verify(factory).defaultTextModel(31L);
    }

    @Test void unavailableModelDoesNotInvokeAnyProvider() {
        AgentScopeModelFactory factory = mock(AgentScopeModelFactory.class);
        when(factory.resolveTextModel("removed::model", 31L)).thenReturn(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "所选文本模型不可用")));
        StepVerifier.create(new CanvasAgentTurnService(factory).turn(31L, request("removed::model", "native", List.of(message("user", "hello")))))
                .expectErrorSatisfies(error -> { assertInstanceOf(TurnException.class, error); assertTrue(error.getMessage().contains("不可用")); }).verify();
        verify(factory, never()).defaultTextModel(anyLong());
    }

    @Test void httpCancellationCancelsModelStream() {
        AgentScopeModelFactory factory = mock(AgentScopeModelFactory.class);
        Model model = mock(Model.class);
        AtomicBoolean canceled = new AtomicBoolean();
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.<ChatResponse>never().doOnCancel(() -> canceled.set(true)));
        when(factory.defaultTextModel(31L)).thenReturn(Mono.just(model));
        StepVerifier.create(new CanvasAgentTurnService(factory).turn(31L, request(null, "native", List.of(message("user", "hello")))))
                .thenCancel().verify();
        assertTrue(canceled.get());
        verify(model, times(1)).stream(anyList(), anyList(), any());
    }

    @Test void sanitizesProviderErrorsAndRetainsCompatibilityStatus() {
        TurnException error = TurnException.from(new OpenAIException("raw unsafe", 400,
                "{\"error\":{\"code\":\"unsupported_parameter\",\"message\":\"tools unsupported api_key=secretvalue Bearer testcredential\"}}"));
        assertEquals(400, error.status());
        assertEquals("unsupported_parameter", error.code());
        assertTrue(error.getMessage().contains("tools unsupported"));
        assertFalse(error.getMessage().contains("secretvalue"));
        assertFalse(error.getMessage().contains("testcredential"));
        TurnException unknown = TurnException.from(new IllegalStateException("network ended"));
        assertEquals(502, unknown.status());
    }

    @Test void rejectsMalformedToolResultsBeforeSelectingModel() {
        AgentScopeModelFactory factory = mock(AgentScopeModelFactory.class);
        StepVerifier.create(new CanvasAgentTurnService(factory).turn(31L, request(null, "native", List.of(message("tool", "orphaned result")))))
                .expectError(TurnException.class).verify();
        verifyNoInteractions(factory);
    }

    @Test void convertsImagesAndSystemMessagesWithoutFlatteningRoles() {
        var messages = toMessages(request(null, "native", List.of(message("user", List.of(
                Map.of("type", "text", "text", "look"), Map.of("type", "image_url", "image_url", Map.of("url", "data:image/png;base64,AA==")))))));
        assertEquals(MsgRole.USER, messages.get(1).getRole());
        ImageBlock image = messages.get(1).getFirstContentBlock(ImageBlock.class);
        Base64Source source = assertInstanceOf(Base64Source.class, image.getSource());
        assertEquals("image/png", source.getMediaType());
        assertEquals("AA==", source.getData());
    }

    @Test void aggregatesNativeCallsAndRejectsIncompleteOutput() {
        Model model = mock(Model.class);
        when(model.getModelName()).thenReturn("model");
        ChatResponse call = ChatResponse.builder().content(List.of(new ToolUseBlock("native-1", "get_canvas", Map.of("x", 1)))).finishReason("tool_calls").build();
        TurnResponse result = aggregate(model, "native", List.of(call));
        assertEquals("native-1", result.toolCalls().getFirst().id());
        assertEquals(Map.of("x", 1), result.toolCalls().getFirst().arguments());
        assertThrows(TurnException.class, () -> aggregate(model, "native", List.of(ChatResponse.builder().content(List.of()).finishReason("length").build())));
    }
}
