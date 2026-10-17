package com.inspirestudio.ai.provider;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiTaskExecutionContext;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.entity.AiGenerationTask;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * New API渠道适配器测试。
 *
 * @date     2026-08-12 11:00
 */
class NewApiProviderAdapterTest {

    @Test
    void videoAudioDefaultsOnAndPreservesExplicitBooleans() {
        for (Map<String, Object> parameters : List.of(Map.<String, Object>of(),
                Map.<String, Object>of("generate_audio", true), Map.<String, Object>of("generate_audio", "true"))) {
            var body = NewApiProviderAdapter.buildVideoRequestPayload("seedance-2.0", "test", parameters, List.of(), List.of());
            Assertions.assertEquals(true, body.get("generate_audio"));
        }
        for (Map<String, Object> parameters : List.of(Map.<String, Object>of("generate_audio", false),
                Map.<String, Object>of("generate_audio", "false"), Map.<String, Object>of("with_audio", false))) {
            var body = NewApiProviderAdapter.buildVideoRequestPayload("seedance-2.0", "test", parameters,
                    List.of("https://example.com/frame.png"), List.of());
            Assertions.assertEquals(false, body.get("generate_audio"));
            Assertions.assertEquals("https://example.com/frame.png", body.get("input_reference"));
        }
    }

    @Test
    void keepsThirtySecondVideoDuration() {
        var body = NewApiProviderAdapter.buildVideoRequestPayload("seedance-2.5", "test", Map.of("seconds",30), List.of(), List.of());
        Assertions.assertEquals("30", String.valueOf(body.get("seconds")));
    }

    @Test
    void keepsCanvasStringDurationAndReferenceInGatewayRequest() {
        var body = NewApiProviderAdapter.buildVideoRequestPayload("seedance-2.5", "test",
                Map.of("seconds", "30", "size", "16:9"), List.of("https://example.com/frame.png"), List.of());
        Assertions.assertEquals("30", body.get("seconds"));
        Assertions.assertEquals("seedance-2.5", body.get("model"));
        Assertions.assertTrue(body.toString().contains("https://example.com/frame.png"));
    }

    @Test
    void resumesSameGatewayJobAfterDownloadFailureAndStoresAuthenticatedContent() {
        var http = mock(AiHttpClient.class);
        var media = mock(AiMediaSupport.class);
        var properties = new InspireProperties();
        properties.getAi().getTask().setPollingIntervalSeconds(1);
        var adapter = new NewApiProviderAdapter(http, media, properties);
        var task = new AiGenerationTask(); task.setTaskType("video"); task.setUserId(1L);
        var channel = new AiTaskDtos.AiChannelConfig("c", "gateway", "http://newapi:3000/v1", "key", "dola", List.of("seedance-2.5"));
        var context = new AiTaskExecutionContext(task, channel, "seedance-2.5", false, "",
                new AiTaskDtos.CreateAiTaskRequest("video", "test", "seedance-2.5", Map.of("seconds",30), List.of(), List.of(), "canvas"),
                () -> reactor.core.publisher.Mono.just(false), p -> reactor.core.publisher.Mono.empty(), d -> reactor.core.publisher.Mono.empty());
        when(http.sendJsonRequest(eq(channel),eq("POST"),eq("/videos"),any()))
                .thenReturn(reactor.core.publisher.Mono.just(JSONObject.of("id","gateway-job")));
        when(http.sendJsonRequest(eq(channel),eq("GET"),eq("/videos/gateway-job"),org.mockito.ArgumentMatchers.isNull()))
                .thenReturn(reactor.core.publisher.Mono.just(JSONObject.of("status","completed","seconds","30")));
        var binary = new com.inspirestudio.ai.GeneratedBinary(new byte[]{1,2,3},"video/mp4");
        when(http.downloadBinary(channel,"/videos/gateway-job/content"))
                .thenReturn(reactor.core.publisher.Mono.error(new IllegalStateException("download interrupted")),reactor.core.publisher.Mono.just(binary));
        when(media.storeGeneratedMedia(1L,"video","generated-video.mp4",binary,null,null,30000))
                .thenReturn(reactor.core.publisher.Mono.just(new com.inspirestudio.dto.PersistenceDtos.UploadedMediaResponse("r2-file","https://cdn.example/video.mp4",3L,"video/mp4",null,null,30000,null)));
        reactor.test.StepVerifier.withVirtualTime(() -> adapter.execute(context)).thenAwait(java.time.Duration.ofSeconds(2))
                .expectErrorMessage("download interrupted").verify();
        Assertions.assertEquals("gateway-job",com.inspirestudio.ai.AiGenerationRetry.state(context).getString("newApiVideoTaskId"));
        reactor.test.StepVerifier.withVirtualTime(() -> adapter.execute(context)).thenAwait(java.time.Duration.ofSeconds(2))
                .assertNext(result -> Assertions.assertEquals("https://cdn.example/video.mp4",result.getJSONObject("item").getString("url"))).verifyComplete();
        org.mockito.Mockito.verify(http,org.mockito.Mockito.times(1)).sendJsonRequest(eq(channel),eq("POST"),eq("/videos"),any());
    }

    /**
     * 验证New API渠道只支持图片和视频任务。
     *
     * @return void 无返回值
     */
    @Test
    void shouldSupportImageAndVideoTasks() {
        NewApiProviderAdapter adapter = new NewApiProviderAdapter(null, null, new InspireProperties());

        Assertions.assertEquals("newapi", adapter.apiFormat());
        Assertions.assertTrue(adapter.supports(AiTaskTypes.IMAGE));
        Assertions.assertTrue(adapter.supports(AiTaskTypes.VIDEO));
        Assertions.assertFalse(adapter.supports(AiTaskTypes.TEXT));
    }

    /**
     * 验证文生图使用New API兼容的图片生成接口。
     *
     * @return void 无返回值
     */
    @Test
    void shouldSubmitImageGenerationRequest() {
        AiHttpClient aiHttpClient = mock(AiHttpClient.class);
        NewApiProviderAdapter adapter = new NewApiProviderAdapter(aiHttpClient, mock(AiMediaSupport.class), new InspireProperties());
        List<JSONObject> payloads = new ArrayList<>();
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"), eq("/images/generations"), any()))
                .thenAnswer(invocation -> {
                    payloads.add(JSON.parseObject(JSON.toJSONString(invocation.getArgument(3))));
                    return reactor.core.publisher.Mono.just(JSON.parseObject("{\"data\":[]}"));
                });

        adapter.execute(imageContext()).block();

        Assertions.assertEquals(1, payloads.size());
        Assertions.assertEquals("gpt-image-1", payloads.getFirst().getString("model"));
        Assertions.assertEquals("b64_json", payloads.getFirst().getString("response_format"));
        Assertions.assertEquals("生成一只小猫", payloads.getFirst().getString("prompt"));
        Assertions.assertEquals(2, payloads.getFirst().getIntValue("n"));
        Assertions.assertEquals("1024x688", payloads.getFirst().getString("size"));
    }

    /**
     * 验证页面视频参数和参考素材映射为New API请求字段。
     *
     * @return void 无返回值
     */
    @Test
    void shouldBuildVideoRequestPayload() {
        Map<String, Object> payload = NewApiProviderAdapter.buildVideoRequestPayload(
                "bytedance/seedance-2.0/image-to-video", "让人物缓慢转身",
                Map.of("seconds", "5", "resolution", "720p", "size", "9:16", "watermark", false),
                List.of("https://example.com/first.png", "https://example.com/last.png"),
                List.of("https://example.com/reference.mp4"));
        JSONObject json = JSON.parseObject(JSON.toJSONString(payload));

        Assertions.assertEquals(5, json.getIntValue("duration"));
        Assertions.assertEquals("5", json.getString("seconds"));
        Assertions.assertEquals("720p", json.getString("resolution"));
        Assertions.assertFalse(json.containsKey("size"));
        Assertions.assertEquals("https://example.com/first.png", json.getString("image"));
        Assertions.assertEquals("https://example.com/first.png", json.getString("input_reference"));
        Assertions.assertEquals(2, json.getJSONArray("images").size());
        Assertions.assertEquals("9:16", json.getJSONObject("metadata").getString("aspect_ratio"));
        Assertions.assertFalse(json.getJSONObject("metadata").getBooleanValue("watermark"));
        Assertions.assertEquals(2, json.getJSONObject("metadata").getJSONArray("reference_images").size());
        Assertions.assertEquals("https://example.com/reference.mp4", json.getJSONObject("metadata").getJSONArray("reference_videos").getString(0));
    }

    /**
     * 验证完成视频地址必须从metadata.url读取。
     *
     * @return void 无返回值
     */
    @Test
    void shouldReadCompletedVideoUrlFromMetadata() {
        JSONObject completed = JSON.parseObject("{\"status\":\"completed\",\"metadata\":{\"url\":\"https://example.com/video.mp4\"}}");

        Assertions.assertEquals("https://example.com/video.mp4", NewApiProviderAdapter.readVideoResultUrl(completed));
        Assertions.assertEquals("", NewApiProviderAdapter.readVideoResultUrl(JSON.parseObject("{\"status\":\"completed\"}")));
    }

    /**
     * 验证New API成功响应的状态和视频地址兼容处理。
     *
     * @return void 无返回值
     */
    @Test
    void shouldReadCompletedVideoPathFromNestedVideoData() {
        JSONObject response = JSON.parseObject("{\"status\":\"done\",\"progress\":100,\"data\":{\"video\":{\"url\":\"/v1/videos/video-1/content\"}}}");

        Assertions.assertEquals("/v1/videos/video-1/content", NewApiProviderAdapter.readVideoResultUrl(response));
        Assertions.assertEquals("https://api.example.com/v1/videos/video-1/content",
                NewApiProviderAdapter.resolveVideoResultUrl("/v1/videos/video-1/content", "https://api.example.com/v1"));
    }

    /**
     * 验证New API查询响应会读取嵌套的视频任务详情。
     *
     * @return void 无返回值
     */
    @Test
    void shouldReadNestedVideoTaskPayload() {
        JSONObject response = JSON.parseObject("""
                {"code":"success","data":{"task_id":"platform-task","status":"IN_PROGRESS","progress":"30%","data":{"task_id":"task-provider","status":"processing","progress":30}}}
                """);

        JSONObject task = NewApiProviderAdapter.responseTaskPayload(response);

        Assertions.assertEquals("task-provider", task.getString("task_id"));
        Assertions.assertEquals("processing", task.getString("status"));
        Assertions.assertEquals(30, task.getIntValue("progress"));
    }

    /**
     * 验证内层只有请求标识时保留New API外层任务状态。
     *
     * @return void 无返回值
     */
    @Test
    void shouldFallbackToOuterVideoTaskPayloadWhenNestedStatusIsMissing() {
        JSONObject response = JSON.parseObject("""
                {"code":"success","data":{"task_id":"task-provider","status":"NOT_START","progress":"0%","data":{"request_id":"request-1"}}}
                """);

        JSONObject task = NewApiProviderAdapter.responseTaskPayload(response);

        Assertions.assertEquals("task-provider", task.getString("task_id"));
        Assertions.assertEquals("NOT_START", task.getString("status"));
    }

    /**
     * 验证New API进度字段兼容数字和百分号字符串。
     *
     * @return void 无返回值
     */
    @Test
    void shouldParseVideoProgressWithPercentSuffix() {
        Assertions.assertEquals(0, NewApiProviderAdapter.parseProgress(JSON.parseObject("{\"progress\":\"0%\"}"), 10));
        Assertions.assertEquals(30, NewApiProviderAdapter.parseProgress(JSON.parseObject("{\"progress\":\"30%\"}"), 10));
        Assertions.assertEquals(40, NewApiProviderAdapter.parseProgress(JSON.parseObject("{\"progress\":40}"), 10));
        Assertions.assertEquals(10, NewApiProviderAdapter.parseProgress(JSON.parseObject("{\"progress\":\"invalid\"}"), 10));
    }

    /**
     * 构建图片任务上下文。
     *
     * @return AiTaskExecutionContext 图片生成任务上下文
     */
    private AiTaskExecutionContext imageContext() {
        AiGenerationTask task = new AiGenerationTask();
        task.setTaskType(AiTaskTypes.IMAGE);
        task.setUserId(1L);
        return new AiTaskExecutionContext(task,
                new AiTaskDtos.AiChannelConfig("channel-1", "New API", "https://newapi.example.com/v1", "test-key", "newapi", List.of("gpt-image-1")),
                "gpt-image-1", false, "",
                new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.IMAGE, "生成一只小猫", "gpt-image-1",
                        Map.of("count", 2, "quality", "medium", "size", "3:2", "resolution", "1K"),
                        List.of(), List.of(), "imagePage"),
                () -> reactor.core.publisher.Mono.just(false), progress -> reactor.core.publisher.Mono.empty(), delta -> reactor.core.publisher.Mono.empty());
    }
}
