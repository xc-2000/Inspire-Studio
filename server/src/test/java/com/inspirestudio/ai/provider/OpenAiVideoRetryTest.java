package com.inspirestudio.ai.provider;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.*;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.entity.AiGenerationTask;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static org.junit.jupiter.api.Assertions.*;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class OpenAiVideoRetryTest {
    @Test void queryErrorResumesSameVideoWithoutAnotherPost() { checkRetry(false); }
    @Test void confirmedFailureCreatesNextVideoAttempt() { checkRetry(true); }

    @Test void jsonVideoChangesIdempotencyKeyOnlyAfterConfirmedFailure() { checkJsonRetry(true); }
    @Test void jsonVideoDownloadFailureKeepsOriginalIdempotentTask() { checkJsonRetry(false); }

    private void checkJsonRetry(boolean terminal) {
        var http = mock(AiHttpClient.class);
        var media = mock(AiMediaSupport.class);
        var properties = new InspireProperties();
        properties.getAi().getTask().setPollingIntervalSeconds(1);
        var adapter = new OpenAiJsonVideoProviderAdapter(http, media, properties);
        var context = context();
        var keys = new java.util.ArrayList<String>();
        when(http.sendJsonRequest(any(), eq("POST"), eq("/videos"), any(), anyMap())).thenAnswer(call -> {
            Map<String, String> headers = call.getArgument(4);
            keys.add(headers.get("Idempotency-Key"));
            return Mono.just(new JSONObject(Map.of("id", "json-" + keys.size())));
        });
        var completed = new JSONObject(Map.of("status", "completed"));
        when(http.sendJsonRequest(any(), eq("GET"), eq("/videos/json-1"), isNull()))
                .thenReturn(Mono.just(terminal ? new JSONObject(Map.of("status", "failed", "error", "failed")) : completed));
        when(http.sendJsonRequest(any(), eq("GET"), eq("/videos/json-2"), isNull())).thenReturn(Mono.just(completed));
        var binary = new GeneratedBinary(new byte[]{1, 2}, "video/mp4");
        when(http.downloadBinary(any(), anyString())).thenReturn(terminal ? Mono.just(binary)
                : Mono.error(new IllegalStateException("download failed")), Mono.just(binary));
        when(media.storeGeneratedMedia(eq(1L), eq("video"), anyString(), any(), isNull(), isNull(), eq(6000)))
                .thenReturn(Mono.just(new PersistenceDtos.UploadedMediaResponse("video:test", "https://example.com/video.mp4", 2L, "video/mp4", null, null, 6000, null)));
        StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context, () -> adapter.execute(context)))
                .thenAwait(Duration.ofSeconds(60)).expectNextCount(1).verifyComplete();
        assertEquals(terminal ? List.of("inspire-video-test", "inspire-video-test-retry-1") : List.of("inspire-video-test"), keys);
    }

    private void checkRetry(boolean terminal) {
        var http = mock(AiHttpClient.class);
        var media = mock(AiMediaSupport.class);
        var properties = new InspireProperties();
        properties.getAi().getTask().setPollingIntervalSeconds(1);
        var adapter = new OpenAiProviderAdapter(http, media, properties);
        var context = context();
        when(http.sendMultipartRequest(any(), eq("/videos"), anyString(), anyList()))
                .thenReturn(Mono.just(new JSONObject(Map.of("id", "upstream-1"))),
                        Mono.just(new JSONObject(Map.of("id", "upstream-2"))));
        JSONObject completed = new JSONObject(Map.of("status", "completed", "url", "https://example.com/video.mp4"));
        when(http.sendJsonRequest(any(), eq("GET"), eq("/videos/upstream-1"), isNull()))
                .thenReturn(terminal ? Mono.just(new JSONObject(Map.of("status", "failed", "error", "generation failed")))
                        : Mono.error(AiErrorSupport.providerException(503, "{}", "polling")), Mono.just(completed));
        when(http.sendJsonRequest(any(), eq("GET"), eq("/videos/upstream-2"), isNull())).thenReturn(Mono.just(completed));
        when(media.isHttpUrl("https://example.com/video.mp4")).thenReturn(true);
        when(media.registerGeneratedMediaUrl(eq(1L), eq("video"), anyString(), anyString(), isNull(), isNull(), isNull()))
                .thenReturn(Mono.just(new PersistenceDtos.UploadedMediaResponse("video:test", "https://example.com/video.mp4", 100L, "video/mp4", 1280, 720, 6000, null)));
        StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context, () -> adapter.execute(context)))
                .thenAwait(Duration.ofSeconds(60)).assertNext(result -> {
                    assertEquals(terminal ? "upstream-2" : "upstream-1", result.getString("providerTaskId"));
                    assertEquals(1, result.getJSONObject("automaticRetry").getIntValue("retriesUsed"));
                }).verifyComplete();
        verify(http, times(terminal ? 2 : 1)).sendMultipartRequest(any(), eq("/videos"), anyString(), anyList());
        verify(http, times(terminal ? 1 : 2)).sendJsonRequest(any(), eq("GET"), eq("/videos/upstream-1"), isNull());
    }

    private AiTaskExecutionContext context() {
        var task = new AiGenerationTask(); task.setId("test"); task.setUserId(1L); task.setTaskType("video");
        return new AiTaskExecutionContext(task,
                new AiTaskDtos.AiChannelConfig("test", "test", "https://example.com", "test", "openai", List.of("video")),
                "video", false, "",
                new AiTaskDtos.CreateAiTaskRequest("video", "test", "video", Map.of("seconds", "6"), List.of(), List.of(), "canvas"),
                () -> Mono.just(false), progress -> Mono.empty(), delta -> Mono.empty());
    }
}
