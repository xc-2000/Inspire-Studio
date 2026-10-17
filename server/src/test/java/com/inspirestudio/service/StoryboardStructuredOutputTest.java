package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.inspirestudio.agent.AgentScopeAgentFactory;
import com.inspirestudio.agent.AgentScopeModelFactory;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.StoryboardDtos;
import com.inspirestudio.security.CurrentUserProvider;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.model.ChatResponse;
import io.agentscope.core.model.Model;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import reactor.core.publisher.Flux;

class StoryboardStructuredOutputTest {
    private static final String GENERATED = """
            {"shots":[{"shotNumber":1,"durationSeconds":10,"visualDescription":"人物打开门，走向灯塔。",
            "shotSize":"中景","lightingAtmosphere":null,"dialogueVoiceover":"","soundEffect":null,
            "cameraMovement":"跟随","assetReferenceKeys":[],"continuity":{"sceneId":"tower","time":"夜晚",
            "transition":"establish","openingState":"人物在门外","closingState":"人物进入灯塔","storyBeat":"到达目的地"}}],"assets":[]}
            """;

    @Test
    void readsPlainJsonWhenTheSdkHasNoStructuredMetadata() {
        var parsed = parse(GENERATED);
        assertEquals(1, parsed.shots().size());
        assertEquals("到达目的地", parsed.shots().getFirst().continuity().storyBeat());
    }

    @Test
    void metadataTakesPrecedenceOverIrrelevantText() {
        Msg message = Msg.builder().role(MsgRole.ASSISTANT).textContent("普通说明")
                .metadata(Map.of("_structured_output", Map.of("prompts", List.of(Map.of("shotId", "one", "visualDescription", "人物走向灯塔")))))
                .build();
        assertEquals("one", StoryboardStructuredOutput.parse(message, StoryboardDtos.PromptContentResult.class).prompts().getFirst().shotId());
    }

    @Test
    void acceptsFencedJsonAndOneSurroundingExplanation() {
        for (String text : List.of("```json\n" + GENERATED + "\n```", "以下是分镜结果：\n" + GENERATED + "\n已整理完成。",
                "结果如下：\n```JSON\n" + GENERATED + "\n```\n已完成。")) {
            assertEquals(10, parse(text).shots().getFirst().durationSeconds());
        }
    }

    @Test
    void respectsQuotedBracesAndEscapedQuotesInsteadOfCuttingJsonEarly() {
        String text = """
                {"prompts":[{"shotId":"one","visualDescription":"门上的牌子写着 \\"{灯塔}[入口]\\"，他沿路前行。"}]}
                """;
        assertTrue(StoryboardStructuredOutput.parse(message(text), StoryboardDtos.PromptContentResult.class)
                .prompts().getFirst().visualDescription().contains("{灯塔}[入口]"));
    }

    @Test
    void supportsCoverageCorrectionsAndBothPromptShapes() {
        var coverage = StoryboardStructuredOutput.parse(message("""
                {"additions":[],"shots":[{"index":0,"assetReferenceKeys":[]}],"narrativeComplete":true,"narrativeIssues":[]}
                """), StoryboardDtos.AssetCoverageResult.class);
        assertTrue(coverage.narrativeComplete());
        var corrections = StoryboardStructuredOutput.parse(message("""
                {"assets":[{"index":0,"kind":"scene"}],"shots":[{"index":0,"shotSize":"中景","assetReferenceKeys":[]}]}
                """), StoryboardDtos.StoryboardFieldCorrections.class);
        assertEquals(StoryboardDtos.GeneratedAssetKind.scene, corrections.assets().getFirst().kind());
        assertEquals("one", StoryboardStructuredOutput.parse(message("""
                {"prompts":[{"shotId":"one","finalPrompt":"一段完整提示词"}]}
                """), StoryboardDtos.PromptCompositionResult.class).prompts().getFirst().shotId());
    }

    @Test
    void preservesOptionalNullsAndFieldsThatTheExistingCorrectionPassCanRepair() {
        var result = parse(GENERATED.replace("\"shotSize\":\"中景\"", "\"shotSize\":null")
                .replace("\"assetReferenceKeys\":[]", "\"assetReferenceKeys\":null").replace("\"assets\":[]", "\"assets\":null"));
        assertNull(result.assets());
        assertNull(result.shots().getFirst().shotSize());
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "我已完成", "{}", "[]", "{\"shots\":[],\"assets\":[]}",
            "{\"shots\":\"not-an-array\",\"assets\":[]}", "{\"shots\":[null],\"assets\":[]}",
            "{\"shots\":[{\"shotNumber\":1}]}"})
    void rejectsMissingOrWrongShapeWithoutLeakingRawOutput(String text) {
        BusinessException error = assertThrows(BusinessException.class, () -> parse(text));
        assertTrue(error.getMessage().contains("完整有效"));
        assertFalse(error.getMessage().contains("_structured_output"));
    }

    @Test
    void rejectsTruncatedAmbiguousDuplicateAndMalformedJson() {
        for (String text : List.of(GENERATED.substring(0, GENERATED.lastIndexOf('}')), GENERATED + GENERATED,
                "[" + GENERATED + "]", "```json\n" + GENERATED, GENERATED + "\n```",
                GENERATED + "true", "null" + GENERATED, GENERATED + "123", GENERATED + "\"extra\"",
                GENERATED.replace("\"shots\":", "\"shots\":[],\"shots\":"),
                GENERATED.replace("\"durationSeconds\":10", "\"durationSeconds\":\"10\""),
                GENERATED.replace("\"durationSeconds\":10", "\"durationSeconds\":10.5"))) {
            assertThrows(BusinessException.class, () -> parse(text));
        }
    }

    @Test
    void invalidMetadataCanRecoverOnlyFromAnIndependentlyValidTextObject() {
        Msg valid = Msg.builder().role(MsgRole.ASSISTANT).textContent(GENERATED)
                .metadata(Map.of("_structured_output", Map.of("shots", "bad"))).build();
        assertEquals(1, StoryboardStructuredOutput.parse(valid, StoryboardDtos.GeneratedStoryboardResult.class).shots().size());
        Msg invalid = Msg.builder().role(MsgRole.ASSISTANT).textContent("secret-test-value")
                .metadata(Map.of("_structured_output", Map.of("shots", "bad"))).build();
        var error = assertThrows(BusinessException.class, () -> StoryboardStructuredOutput.parse(invalid, StoryboardDtos.GeneratedStoryboardResult.class));
        assertFalse(error.getMessage().contains("secret-test-value"));
    }

    @Test
    void recoversTheActualCallWithoutASecondBillableModelInvocation() {
        var agent = mock(ReActAgent.class);
        var model = mock(Model.class);
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.just(response(GENERATED)));
        var service = service(agent);
        var result = service.callAgent(1L, "plain-json", selection(model),
                Map.of("action", "generateStoryboard"), StoryboardDtos.GeneratedStoryboardResult.class).block();
        assertNotNull(result);
        assertEquals(1, result.shots().size());
        @SuppressWarnings("unchecked") var messages = (org.mockito.ArgumentCaptor<List<Msg>>) (org.mockito.ArgumentCaptor<?>) org.mockito.ArgumentCaptor.forClass(List.class);
        verify(model, times(1)).stream(messages.capture(), eq(List.of()), any());
        assertEquals("分镜 JSON 系统提示", messages.getValue().getFirst().getTextContent());
        assertEquals(MsgRole.USER, messages.getValue().get(1).getRole());
        var input = com.alibaba.fastjson2.JSON.parseObject(messages.getValue().get(1).getTextContent());
        assertTrue(input.getJSONObject("responseSchema").getJSONObject("properties").containsKey("shots"));
        assertTrue(input.getString("responseContract").contains("不调用工具"));
        verify(agent).close();
    }

    @Test
    void retriesAnEmptyReviewOnlyOnceAndKeepsTheSameCurrentAction() {
        var agent = mock(ReActAgent.class);
        var model = mock(Model.class);
        String review = "{\"additions\":[],\"shots\":[],\"narrativeComplete\":true,\"narrativeIssues\":[]}";
        when(model.stream(anyList(), anyList(), any()))
                .thenReturn(Flux.just(response("")), Flux.just(response(review)));
        var result = service(agent).callAgent(1L, "review-empty", selection(model),
                Map.of("action", "reviewStoryboardAssetCoverage"), StoryboardDtos.AssetCoverageResult.class).block();
        assertNotNull(result);
        assertTrue(result.narrativeComplete());
        @SuppressWarnings("unchecked") var messages = (org.mockito.ArgumentCaptor<List<Msg>>) (org.mockito.ArgumentCaptor<?>) org.mockito.ArgumentCaptor.forClass(List.class);
        verify(model, times(2)).stream(messages.capture(), eq(List.of()), any());
        var payloads = messages.getAllValues().stream().map(items -> items.get(1).getTextContent()).toList();
        assertEquals(payloads.get(0), payloads.get(1));
        assertEquals("reviewStoryboardAssetCoverage", com.alibaba.fastjson2.JSON.parseObject(payloads.getFirst()).getString("action"));
        verify(agent).close();
    }

    @Test
    void stopsAfterTheSecondEmptyResponseInsteadOfLoopingOrHidingTheFailure() {
        var agent = mock(ReActAgent.class);
        var model = mock(Model.class);
        when(model.stream(anyList(), anyList(), any())).thenReturn(Flux.empty());
        var error = assertThrows(BusinessException.class, () -> service(agent).callAgent(1L, "twice-empty", selection(model),
                Map.of("action", "generateStoryboard"), StoryboardDtos.GeneratedStoryboardResult.class).block());
        assertTrue(error.getMessage().contains("未返回正文"));
        verify(model, times(2)).stream(anyList(), anyList(), any());
        verify(agent).close();
    }

    @Test
    void doesNotRetryMalformedOutputTruncationOrAnUpstreamError() {
        for (Flux<ChatResponse> responses : List.of(Flux.just(response("无效结果")),
                Flux.just(ChatResponse.builder().content(List.of(TextBlock.builder().text(GENERATED).build())).finishReason("length").build()),
                Flux.<ChatResponse>error(new IllegalStateException("provider unavailable")))) {
            var agent = mock(ReActAgent.class);
            var model = mock(Model.class);
            when(model.stream(anyList(), anyList(), any())).thenReturn(responses);
            assertThrows(BusinessException.class, () -> service(agent).callAgent(1L, "no-retry", selection(model),
                    Map.of("action", "generateStoryboard"), StoryboardDtos.GeneratedStoryboardResult.class).block());
            verify(model, times(1)).stream(anyList(), anyList(), any());
            verify(agent).close();
        }
    }

    private static StoryboardAgentService service(ReActAgent agent) {
        var factory = mock(AgentScopeAgentFactory.class);
        when(factory.storyboardAgent(any())).thenReturn(agent);
        when(agent.getSysPrompt()).thenReturn("分镜 JSON 系统提示");
        return new StoryboardAgentService(mock(CurrentUserProvider.class), mock(AgentScopeModelFactory.class), factory,
                new InspireProperties(), mock(CreditService.class), mock(SystemPromptTemplateService.class), mock(AiTaskService.class));
    }

    private static AgentScopeModelFactory.TextModelSelection selection(Model model) {
        return new AgentScopeModelFactory.TextModelSelection(model, "test", "test", "test", 1);
    }

    private static ChatResponse response(String text) {
        return ChatResponse.builder().content(List.of(TextBlock.builder().text(text).build())).finishReason("stop").build();
    }

    private static StoryboardDtos.GeneratedStoryboardResult parse(String text) {
        return StoryboardStructuredOutput.parse(message(text), StoryboardDtos.GeneratedStoryboardResult.class);
    }
    private static Msg message(String text) { return Msg.builder().role(MsgRole.ASSISTANT).textContent(text).build(); }
}
