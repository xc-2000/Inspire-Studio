package com.inspirestudio.ai;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.entity.AiGenerationTask;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class AiGenerationRetryTest {
    @Test void retriesExactlyThreeTimesThenFails() {
        var calls = new AtomicInteger();
        var context = context(new AtomicBoolean());
        StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context, () -> {
            calls.incrementAndGet();
            return Mono.error(new IllegalStateException("temporary failure"));
        })).thenAwait(Duration.ofSeconds(51))
                .expectErrorMatches(e -> e.getMessage().equals("自动重试 3 次后仍失败：temporary failure")).verify();
        assertEquals(4, calls.get());
        var retry = AiGenerationRetry.state(context).getJSONObject("automaticRetry");
        assertEquals(3, retry.getIntValue("retriesUsed"));
        assertEquals("exhausted", retry.getString("status"));
    }

    @Test void stopsImmediatelyAfterSuccess() {
        var calls = new AtomicInteger();
        var context = context(new AtomicBoolean());
        StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context, () -> calls.incrementAndGet() < 3
                        ? Mono.error(new IllegalStateException("busy")) : Mono.just(new JSONObject(Map.of("item", "video")))))
                .thenAwait(Duration.ofSeconds(21)).assertNext(result -> {
                    assertEquals("video", result.getString("item"));
                    assertEquals(2, result.getJSONObject("automaticRetry").getIntValue("retriesUsed"));
                    assertEquals("succeeded", result.getJSONObject("automaticRetry").getString("status"));
                }).verifyComplete();
        assertEquals(3, calls.get());
    }

    @Test void cancelDuringBackoffDoesNotSubmitAgain() {
        var calls = new AtomicInteger();
        var canceled = new AtomicBoolean();
        var context = context(canceled);
        StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context, () -> {
            calls.incrementAndGet();
            return Mono.error(new IllegalStateException("busy"));
        })).thenAwait(Duration.ofSeconds(1)).then(() -> canceled.set(true)).thenAwait(Duration.ofSeconds(5))
                .expectErrorMessage("任务已取消").verify();
        assertEquals(1, calls.get());
    }

    @Test void restartPreservesRemainingRetryBudget() {
        var calls = new AtomicInteger();
        var context = context(new AtomicBoolean());
        context.task().setResultData("{\"automaticRetry\":{\"retriesUsed\":3,\"attempt\":4,\"status\":\"running\"}}");
        StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context, () -> {
            calls.incrementAndGet();
            return Mono.error(new IllegalStateException("busy"));
        })).thenAwait(Duration.ofSeconds(1)).expectErrorMatches(e -> e.getMessage().contains("重试 3 次")).verify();
        assertEquals(1, calls.get());
        // A crash after exhausting the budget must not give a fifth attempt on recovery.
        StepVerifier.create(AiGenerationRetry.execute(context, () -> {
            calls.incrementAndGet(); return Mono.just(new JSONObject());
        })).expectErrorMatches(e -> e.getMessage().contains("重试 3 次")).verify();
        assertEquals(1, calls.get());
    }

    @Test void pollingFailureRetainsUpstreamJobButConfirmedFailureClearsIt() {
        for (boolean terminal : List.of(false, true)) {
            var context = context(new AtomicBoolean());
            context.task().setResultData("{\"openAiVideoTaskId\":\"existing-video\",\"miniMaxVideoTaskId\":\"existing-minimax\"}");
            var calls = new AtomicInteger();
            StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context, () -> {
                if (calls.incrementAndGet() == 1) return Mono.error(terminal
                        ? AiErrorSupport.providerTaskFailure(new JSONObject(Map.of("status", "failed")), "failed")
                        : AiErrorSupport.providerPollingTimeout("query timed out"));
                assertEquals(terminal ? null : "existing-video", AiGenerationRetry.state(context).getString("openAiVideoTaskId"));
                assertEquals(terminal ? null : "existing-minimax", AiGenerationRetry.state(context).getString("miniMaxVideoTaskId"));
                return Mono.just(new JSONObject());
            })).thenAwait(Duration.ofSeconds(6)).expectNextCount(1).verifyComplete();
            assertEquals(2, calls.get());
        }
    }

    @Test void synchronousAdapterFailureAlsoUsesBoundedRetries() {
        var calls = new AtomicInteger();
        StepVerifier.withVirtualTime(() -> AiGenerationRetry.execute(context(new AtomicBoolean()), () -> {
            calls.incrementAndGet(); throw new IllegalStateException("synchronous");
        })).thenAwait(Duration.ofSeconds(51)).expectErrorMatches(e -> e.getMessage().contains("synchronous")).verify();
        assertEquals(4, calls.get());
    }

    private AiTaskExecutionContext context(AtomicBoolean canceled) {
        var task = new AiGenerationTask();
        task.setId("same-task"); task.setUserId(1L); task.setTaskType("video");
        return new AiTaskExecutionContext(task,
                new AiTaskDtos.AiChannelConfig("test", "test", "https://example.com", "test", "openai", List.of("video")),
                "video", false, "",
                new AiTaskDtos.CreateAiTaskRequest("video", "test", "video", Map.of(), List.of(), List.of(), "canvas"),
                () -> Mono.just(canceled.get()), progress -> Mono.empty(), delta -> Mono.empty());
    }
}
