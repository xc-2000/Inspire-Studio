package com.inspirestudio.ai;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import java.time.Duration;
import java.time.Instant;
import java.util.function.Supplier;
import reactor.core.publisher.Mono;

/** One persisted task, one charge, at most three additional generation attempts. */
public final class AiGenerationRetry {
    public static final int MAX_RETRIES = 3;
    public static final String STATE_KEY = "automaticRetry";
    private AiGenerationRetry() {}

    public static Mono<JSONObject> execute(AiTaskExecutionContext context, Supplier<Mono<JSONObject>> operation) {
        return attempt(context, operation).map(result -> {
            JSONObject retry = state(context).getJSONObject(STATE_KEY);
            if (retry != null) {
                retry.put("status", "succeeded");
                retry.remove("nextRetryAt");
                result.put(STATE_KEY, retry);
            }
            return result;
        });
    }

    private static Mono<JSONObject> attempt(AiTaskExecutionContext context, Supplier<Mono<JSONObject>> operation) {
        return Mono.defer(() -> {
            JSONObject data = state(context);
            JSONObject retry = data.getJSONObject(STATE_KEY);
            if (retry != null && "exhausted".equals(retry.getString("status"))) {
                return Mono.error(exhausted(AiErrorSupport.fromData(retry.get("lastError"))));
            }
            long waitMillis = retry != null && "waiting".equals(retry.getString("status"))
                    ? Math.max(0, retry.getLongValue("nextRetryAt") - System.currentTimeMillis()) : 0;
            return Mono.delay(Duration.ofMillis(waitMillis))
                    .then(ensureActive(context))
                    .then(Mono.defer(() -> {
                        Mono<Void> progress = Mono.empty();
                        if (retry != null) {
                            retry.put("status", "running");
                            retry.remove("nextRetryAt");
                            context.task().setResultData(data.toJSONString());
                            progress = context.updateRunningProgress(5);
                        }
                        return progress.then(Mono.defer(operation).onErrorResume(error -> retry(context, operation, error)));
                    }));
        });
    }

    private static Mono<JSONObject> retry(AiTaskExecutionContext context, Supplier<Mono<JSONObject>> operation, Throwable failure) {
        return ensureActive(context).then(Mono.defer(() -> {
            AiErrorDetails error = AiErrorSupport.fromThrowable(failure, "task", "execution");
            if ("canceled".equals(error.category())) return Mono.error(failure);
            JSONObject data = state(context);
            JSONObject retry = data.getJSONObject(STATE_KEY);
            if (retry == null) retry = new JSONObject();
            int used = Math.min(MAX_RETRIES, Math.max(0, retry.getIntValue("retriesUsed")));
            retry.put("maxRetries", MAX_RETRIES);
            retry.put("lastError", error.toMap());
            retry.put("lastFailedAt", Instant.now().toString());
            data.put(STATE_KEY, retry);
            // Only a confirmed terminal provider failure allows a fresh video submission.
            // Query/download errors retain the checkpoint to resume the same upstream job.
            if (failure instanceof AiProviderException provider && provider.isTerminalTaskFailure()) {
                data.remove("openAiVideoTaskId");
                data.remove("miniMaxVideoTaskId");
                data.remove("newApiVideoTaskId");
                data.put("openAiVideoSubmission", data.getIntValue("openAiVideoSubmission") + 1);
            }
            if (used >= MAX_RETRIES) {
                retry.put("status", "exhausted");
                retry.remove("nextRetryAt");
                context.task().setResultData(data.toJSONString());
                return context.updateRunningProgress(95).then(Mono.error(exhausted(error)));
            }
            int next = used + 1;
            retry.put("retriesUsed", next);
            retry.put("attempt", next + 1);
            retry.put("status", "waiting");
            retry.put("nextRetryAt", System.currentTimeMillis() + retryDelay(next).toMillis());
            context.task().setResultData(data.toJSONString());
            return context.updateRunningProgress(5).then(Mono.defer(() -> attempt(context, operation)));
        }));
    }

    private static Mono<Void> ensureActive(AiTaskExecutionContext context) {
        return Mono.defer(context::isCancelRequested).flatMap(canceled -> Boolean.TRUE.equals(canceled)
                ? Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "任务已取消")) : Mono.empty());
    }

    static Duration retryDelay(int retry) {
        return Duration.ofSeconds(switch (retry) { case 1 -> 5; case 2 -> 15; default -> 30; });
    }

    public static JSONObject state(AiTaskExecutionContext context) {
        String value = context.task().getResultData();
        JSONObject data = value == null || value.isBlank() ? null : JSON.parseObject(value);
        return data == null ? new JSONObject() : data;
    }

    private static AiProviderException exhausted(AiErrorDetails error) {
        if (error == null) error = AiErrorSupport.fromThrowable(new IllegalStateException("生成失败"), "task", "execution");
        String message = "自动重试 3 次后仍失败：" + readableMessage(error.message());
        return new AiProviderException(new AiErrorDetails(error.source(), error.category(), error.stage(),
                error.httpStatus(), error.code(), error.type(), error.parameter(), message, error.requestAccepted(), false));
    }

    public static String readableMessage(String message) {
        if (message == null) return "生成失败";
        if (message.toLowerCase(java.util.Locale.ROOT).contains("task user quota exceed")) return "上游账号生成配额已用尽，请检查渠道额度后重试";
        if (message.contains("Upstream video generation did not complete")) return "上游视频任务生成失败，未返回成片";
        return message;
    }
}
