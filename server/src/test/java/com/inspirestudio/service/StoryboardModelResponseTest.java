package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.inspirestudio.common.BusinessException;
import io.agentscope.core.message.ContentBlock;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ThinkingBlock;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.model.ChatResponse;
import io.agentscope.core.model.GenerateOptions;
import io.agentscope.core.model.Model;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import reactor.core.publisher.Flux;
import reactor.test.StepVerifier;

class StoryboardModelResponseTest {
    @Test
    void callsTheSelectedModelOnceWithoutToolsOrNativeResponseSchema() {
        Model model = mock(Model.class);
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.just(response("stop", text("{\"prompts\":[]}"))));
        var invocation = StoryboardModelResponse.call(model, "完整系统要求", "完整小说原文");
        verifyNoInteractions(model);
        Msg result = invocation.block();
        assertNotNull(result);
        assertEquals("{\"prompts\":[]}", result.getTextContent());
        @SuppressWarnings("unchecked") ArgumentCaptor<List<Msg>> messages = ArgumentCaptor.forClass(List.class);
        var options = ArgumentCaptor.forClass(GenerateOptions.class);
        verify(model, times(1)).stream(messages.capture(), eq(List.of()), options.capture());
        assertEquals(2, messages.getValue().size());
        assertEquals(MsgRole.SYSTEM, messages.getValue().get(0).getRole());
        assertEquals("完整系统要求", messages.getValue().get(0).getTextContent());
        assertEquals(MsgRole.USER, messages.getValue().get(1).getRole());
        assertEquals("完整小说原文", messages.getValue().get(1).getTextContent());
        assertFalse(options.getValue().getStream());
        assertNull(options.getValue().getResponseFormat());
        assertEquals(1, options.getValue().getExecutionConfig().getMaxAttempts());
        assertEquals(Duration.ofSeconds(300), options.getValue().getExecutionConfig().getTimeout());
        assertFalse(options.getValue().getExecutionConfig().getRetryOn().test(new IllegalStateException("upstream")));
    }

    @Test
    void accumulatesEveryTextBlockAndIgnoresThinkingWithoutTurningItIntoAnAnswer() {
        var output = StoryboardModelResponse.aggregate(List.of(
                response(null, ThinkingBlock.builder().thinking("推理不应混入JSON").build(), text("{\"prompts\":")),
                response(null, text("[{\"shotId\":\"one\",\"visualDescription\":\"灯塔亮起\"}]")),
                response("stop", text("}"))));
        assertEquals("{\"prompts\":[{\"shotId\":\"one\",\"visualDescription\":\"灯塔亮起\"}]}", output.getTextContent());
        assertFalse(output.getTextContent().contains("推理"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"length", "max_tokens", "MAX_TOKENS", "max_output_tokens", "content_filter", "safety", "RECITATION"})
    void rejectsIncompleteOrBlockedOutputEvenIfItsJsonIsBalanced(String finishReason) {
        var error = assertThrows(BusinessException.class,
                () -> StoryboardModelResponse.aggregate(List.of(response(finishReason, text("{\"prompts\":[]}")))));
        assertFalse(error instanceof StoryboardModelResponse.EmptyResponseException);
        assertTrue(error.getMessage().contains("截断"));
    }

    @Test
    void makesOnlyEmptyAnswersEligibleForTheExplicitPhaseRetry() {
        for (var responses : List.of(List.<ChatResponse>of(), List.of(response("stop", text("  "))),
                List.of(response("stop", ThinkingBlock.builder().thinking("只有思考没有正文").build())))) {
            assertThrows(StoryboardModelResponse.EmptyResponseException.class, () -> StoryboardModelResponse.aggregate(responses));
        }
        assertThrows(BusinessException.class, () -> StoryboardModelResponse.aggregate(List.of(response("content_filter"))));
    }

    @Test
    void unwrapsAUniqueGenerateResponseAsDataWithoutExecutingAnything() {
        var response = response("tool_calls", text("结果如下"), new ToolUseBlock("one", "generate_response",
                Map.of("prompts", List.of(Map.of("shotId", "one", "visualDescription", "灯塔亮起")))));
        var output = StoryboardModelResponse.aggregate(List.of(response));
        var parsed = StoryboardStructuredOutput.parse(output, com.inspirestudio.dto.StoryboardDtos.PromptContentResult.class);
        assertEquals("灯塔亮起", parsed.prompts().getFirst().visualDescription());
    }

    @Test
    void rejectsUnknownOrMultipleToolCallsInsteadOfRunningThemOrPickingOne() {
        for (var content : List.of(
                List.<ContentBlock>of(new ToolUseBlock("one", "delete_file", Map.of("path", "private-test"))),
                List.<ContentBlock>of(new ToolUseBlock("one", "generate_response", Map.of("prompts", List.of())),
                        new ToolUseBlock("two", "generate_response", Map.of("prompts", List.of()))),
                List.<ContentBlock>of(new ToolUseBlock("one", "generate_response", Map.of())))) {
            var error = assertThrows(BusinessException.class, () -> StoryboardModelResponse.aggregate(List.of(
                    ChatResponse.builder().content(content).finishReason("tool_calls").build())));
            assertFalse(error instanceof StoryboardModelResponse.EmptyResponseException);
            assertFalse(error.getMessage().contains("private-test"));
        }
    }

    @Test
    void doesNotRetryProviderErrorsOrReplaceThemWithEmptyOutputErrors() {
        Model model = mock(Model.class);
        var upstream = new IllegalStateException("provider-error");
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.error(upstream));
        StepVerifier.create(StoryboardModelResponse.call(model, "system", "user"))
                .expectErrorMatches(error -> error == upstream).verify();
        verify(model, times(1)).stream(anyList(), anyList(), any());
    }

    @Test
    void cancellationStopsTheUnderlyingRequest() {
        Model model = mock(Model.class);
        AtomicBoolean canceled = new AtomicBoolean();
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.<ChatResponse>never().doOnCancel(() -> canceled.set(true)));
        StepVerifier.create(StoryboardModelResponse.call(model, "system", "user")).thenCancel().verify();
        assertTrue(canceled.get());
        verify(model, times(1)).stream(anyList(), anyList(), any());
    }

    @Test
    void rejectsOversizedOutputBeforeReturningItToTheParser() {
        assertThrows(BusinessException.class, () -> StoryboardModelResponse.aggregate(List.of(response("stop", text("x".repeat(2_000_001))))));
    }

    private static TextBlock text(String content) { return TextBlock.builder().text(content).build(); }
    private static ChatResponse response(String finishReason, ContentBlock... content) {
        return ChatResponse.builder().content(List.of(content)).finishReason(finishReason).build();
    }
}
