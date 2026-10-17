package com.inspirestudio.ai.provider;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiTaskExecutionContext;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.ai.GeneratedBinary;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.entity.AiGenerationTask;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import reactor.test.scheduler.VirtualTimeScheduler;

/** AutoDL ComfyUI 渠道适配器测试。 */
class AutoDlComfyUiProviderAdapterTest {

    /** 适配器只支持视频任务。 */
    @Test
    void shouldOnlySupportVideoTasks() {
        AutoDlComfyUiProviderAdapter adapter =
                new AutoDlComfyUiProviderAdapter(null, null, new InspireProperties());

        Assertions.assertEquals("autodl-comfyui", adapter.apiFormat());
        Assertions.assertTrue(adapter.supports(AiTaskTypes.VIDEO));
        Assertions.assertFalse(adapter.supports(AiTaskTypes.IMAGE));
        Assertions.assertFalse(adapter.supports(AiTaskTypes.TEXT));
    }

    /** 通用参数、图片和音频应映射到工作流字段。 */
    @Test
    void shouldBuildWorkflowPayload() {
        JSONObject payload = JSON.parseObject(JSON.toJSONString(
                AutoDlComfyUiProviderAdapter.buildRequestPayload(
                        "产品缓慢旋转",
                        Map.of("seconds", "8", "resolution", "768p", "size", "1280x720", "seed", 123456L),
                        List.of("https://example.com/one.png", "https://example.com/two.png"),
                        List.of("https://example.com/voice.mp3"))));

        Assertions.assertEquals("产品缓慢旋转", payload.getString("prompt"));
        Assertions.assertEquals(8, payload.getIntValue("duration"));
        Assertions.assertEquals("768p横", payload.getString("resolution"));
        Assertions.assertEquals(123456L, payload.getLongValue("seed"));
        Assertions.assertEquals("https://example.com/one.png", payload.getString("ref_image_0"));
        Assertions.assertEquals("https://example.com/two.png", payload.getString("ref_image_1"));
        Assertions.assertEquals("https://example.com/voice.mp3", payload.getString("ref_audio_0"));
    }

    /** 像素尺寸和比例都应正确识别横竖方向。 */
    @Test
    void shouldMapResolutionOrientation() {
        Assertions.assertEquals("480p竖", AutoDlComfyUiProviderAdapter.resolutionParameter(
                Map.of("resolution", "480p", "size", "720x1280")));
        Assertions.assertEquals("768p竖", AutoDlComfyUiProviderAdapter.resolutionParameter(
                Map.of("resolution", "768", "size", "9:16")));
        Assertions.assertEquals("768p横", AutoDlComfyUiProviderAdapter.resolutionParameter(
                Map.of("resolution", "768p", "size", "16:9")));
    }

    /** 工作流边界限制应在提交前拒绝。 */
    @Test
    void shouldRejectInvalidWorkflowParameters() {
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.buildRequestPayload("", Map.of(), List.of(), List.of()));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.buildRequestPayload(
                        "test", Map.of("seconds", "16"), List.of(), List.of()));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.buildRequestPayload(
                        "test", Map.of("resolution", "1080p"), List.of(), List.of()));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.buildRequestPayload(
                        "test", Map.of(), java.util.stream.IntStream.range(0, 10)
                                .mapToObj(index -> "image-" + index).toList(), List.of()));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.buildRequestPayload(
                        "test", Map.of(), List.of(), java.util.stream.IntStream.range(0, 4)
                                .mapToObj(index -> "audio-" + index).toList()));
    }

    /** 工作流 ID 来自所选模型，允许配置多个安全 ID，并拒绝路径注入。 */
    @Test
    void shouldResolveConfiguredWorkflowId() {
        Assertions.assertEquals("custom_video_workflow_v2",
                AutoDlComfyUiProviderAdapter.workflowId(" custom_video_workflow_v2 "));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.workflowId("../other-workflow"));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.workflowId(""));
    }

    /** 成功任务只提交一次，并把临时视频地址转存到对象存储。 */
    @Test
    void shouldSubmitOncePollAndStoreVideo() {
        AiHttpClient httpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        AutoDlComfyUiProviderAdapter adapter =
                new AutoDlComfyUiProviderAdapter(httpClient, mediaSupport, new InspireProperties());
        String configuredWorkflowId = "custom_video_workflow_v2";
        String providerTaskId = "autodl-task-1";
        String sourceUrl = "https://temporary.example.com/result.mp4";
        PersistenceDtos.UploadedMediaResponse stored = new PersistenceDtos.UploadedMediaResponse(
                "video:r2-result", "https://r2.example.com/result.mp4", 100L,
                "video/mp4", null, null, 5000, null);
        when(mediaSupport.resolveReferenceBinary(eq(7L), any(AiTaskDtos.AiTaskMediaReference.class), any(String.class)))
                .thenAnswer(invocation -> Mono.just(new GeneratedBinary(
                        invocation.<AiTaskDtos.AiTaskMediaReference>getArgument(1).id().getBytes(java.nio.charset.StandardCharsets.UTF_8),
                        invocation.<AiTaskDtos.AiTaskMediaReference>getArgument(1).mimeType())));
        when(httpClient.sendRawAuthorizationJsonRequest(
                any(AiTaskDtos.AiChannelConfig.class), eq("POST"),
                eq("/api/v1/comfyui/comfyui_workflow/" + configuredWorkflowId), any()))
                .thenReturn(Mono.just(JSON.parseObject(
                        "{\"code\":\"Success\",\"data\":{\"task_id\":\"" + providerTaskId + "\",\"status\":\"QUEUED\"}}")));
        when(httpClient.sendRawAuthorizationJsonRequest(
                any(AiTaskDtos.AiChannelConfig.class), eq("GET"),
                eq("/api/v1/comfyui/comfyui_workflow/result/" + providerTaskId), isNull()))
                .thenReturn(Mono.just(JSON.parseObject(
                        "{\"code\":\"Success\",\"data\":{\"task_id\":\"" + providerTaskId
                                + "\",\"status\":\"SUCCESS\",\"results\":[{\"url\":\"" + sourceUrl
                                + "\",\"type\":\"video\"}]}}")));
        when(mediaSupport.registerGeneratedMediaUrl(
                7L, AiTaskTypes.VIDEO, sourceUrl, "video/mp4", null, null, 5000))
                .thenReturn(Mono.just(stored));

        VirtualTimeScheduler scheduler = VirtualTimeScheduler.create();
        StepVerifier.withVirtualTime(() -> adapter.execute(videoContext(configuredWorkflowId)), () -> scheduler, 1)
                .thenAwait(Duration.ofSeconds(5))
                .assertNext(result -> Assertions.assertEquals(
                        "https://r2.example.com/result.mp4", result.getJSONObject("item").getString("url")))
                .verifyComplete();

        ArgumentCaptor<Object> payloadCaptor = ArgumentCaptor.forClass(Object.class);
        verify(httpClient, times(1)).sendRawAuthorizationJsonRequest(
                any(AiTaskDtos.AiChannelConfig.class), eq("POST"),
                eq("/api/v1/comfyui/comfyui_workflow/" + configuredWorkflowId),
                payloadCaptor.capture());
        JSONObject submitted = JSON.parseObject(JSON.toJSONString(payloadCaptor.getValue()));
        Assertions.assertEquals("data:image/png;base64,aW1hZ2UtMQ==", submitted.getString("ref_image_0"));
        Assertions.assertEquals("data:audio/mpeg;base64,YXVkaW8tMQ==", submitted.getString("ref_audio_0"));
        Assertions.assertFalse(submitted.toJSONString().contains("example.com"));
        verify(mediaSupport).resolveReferenceBinary(eq(7L),
                eq(videoContext(configuredWorkflowId).request().references().getFirst()), eq("image/png"));
        verify(mediaSupport).resolveReferenceBinary(eq(7L),
                eq(videoContext(configuredWorkflowId).request().audioReferences().getFirst()), eq("audio/mpeg"));
        verify(mediaSupport).registerGeneratedMediaUrl(
                7L, AiTaskTypes.VIDEO, sourceUrl, "video/mp4", null, null, 5000);
    }

    /** R2读取失败发生在准备阶段，不应提交生成或丢弃参考图改成文生视频。 */
    @Test
    void shouldNotSubmitWhenReferenceCannotBeRead() {
        AiHttpClient httpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        when(mediaSupport.resolveReferenceBinary(eq(7L), any(), any(String.class)))
                .thenReturn(Mono.error(new java.io.IOException("reference timeout")));
        StepVerifier.create(new AutoDlComfyUiProviderAdapter(httpClient, mediaSupport, new InspireProperties())
                        .execute(videoContext(AutoDlComfyUiProviderAdapter.WORKFLOW_ID)))
                .expectErrorMessage("reference timeout")
                .verify();
        verifyNoInteractions(httpClient);
    }

    /** 上游提交超时无法确认是否已受理，不能自动再次创建收费任务。 */
    @Test
    void shouldNotRetryGenerationSubmission() {
        AiHttpClient httpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        when(mediaSupport.resolveReferenceBinary(eq(7L), any(), any(String.class)))
                .thenAnswer(invocation -> Mono.just(new GeneratedBinary(new byte[]{1},
                        invocation.<AiTaskDtos.AiTaskMediaReference>getArgument(1).mimeType())));
        when(httpClient.sendRawAuthorizationJsonRequest(any(), eq("POST"), any(), any()))
                .thenReturn(Mono.error(new java.net.http.HttpTimeoutException("submission timeout")));
        StepVerifier.create(new AutoDlComfyUiProviderAdapter(httpClient, mediaSupport, new InspireProperties())
                        .execute(videoContext(AutoDlComfyUiProviderAdapter.WORKFLOW_ID)))
                .expectErrorMessage("submission timeout")
                .verify();
        verify(httpClient, times(1)).sendRawAuthorizationJsonRequest(any(), eq("POST"), any(), any());
    }

    /** 校验下载返回的实际类型，避免上游收到HTML错误页或不支持的文件。 */
    @Test
    void shouldRejectUnsupportedH3MediaBeforeSubmission() {
        for (String mimeType : List.of("text/html", "image/gif", "application/octet-stream")) {
            AiHttpClient httpClient = mock(AiHttpClient.class);
            AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
            when(mediaSupport.resolveReferenceBinary(eq(7L), any(), any(String.class)))
                    .thenReturn(Mono.just(new GeneratedBinary(new byte[]{1}, mimeType)));
            StepVerifier.create(new AutoDlComfyUiProviderAdapter(httpClient, mediaSupport, new InspireProperties())
                            .execute(videoContext(AutoDlComfyUiProviderAdapter.WORKFLOW_ID)))
                    .expectErrorMatches(error -> error instanceof BusinessException
                            && error.getMessage().contains("参考图片格式不支持"))
                    .verify();
            verifyNoInteractions(httpClient);
        }
    }

    /** 图片和音频的限制应合计而非分别计算。 */
    @Test
    void shouldRejectCombinedReferenceSizeBeforeSubmission() {
        AiHttpClient httpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        byte[] data = new byte[26 * 1024 * 1024];
        when(mediaSupport.resolveReferenceBinary(eq(7L), any(), any(String.class)))
                .thenAnswer(invocation -> Mono.just(new GeneratedBinary(data,
                        invocation.<AiTaskDtos.AiTaskMediaReference>getArgument(1).mimeType())));
        StepVerifier.create(new AutoDlComfyUiProviderAdapter(httpClient, mediaSupport, new InspireProperties())
                        .execute(videoContext(AutoDlComfyUiProviderAdapter.WORKFLOW_ID)))
                .expectErrorMatches(error -> error instanceof BusinessException
                        && error.getMessage().contains("合计不能超过50MB"))
                .verify();
        verifyNoInteractions(httpClient);
    }

    @Test
    void shouldEnforceExactSizeBoundaryAndRejectEmptyFiles() {
        long maximum = AutoDlComfyUiProviderAdapter.MAXIMUM_REFERENCE_BYTES;
        Assertions.assertEquals(maximum, AutoDlComfyUiProviderAdapter.checkedReferenceSize(maximum - 1, 1));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.checkedReferenceSize(maximum, 1));
        Assertions.assertThrows(BusinessException.class,
                () -> AutoDlComfyUiProviderAdapter.checkedReferenceSize(0, 0));
    }

    @Test
    void shouldNormalizeSupportedMimeTypesAndPreserveBinary() {
        byte[] data = new byte[]{0, 1, 2, 127, -128, -1};
        String encoded = Base64.getEncoder().encodeToString(data);
        Assertions.assertEquals("data:image/jpeg;base64," + encoded,
                AutoDlComfyUiProviderAdapter.referenceDataUrl(new GeneratedBinary(data, "image/jpg; charset=binary"),
                        AutoDlComfyUiProviderAdapter.WORKFLOW_ID, false));
        Assertions.assertEquals("data:audio/wav;base64," + encoded,
                AutoDlComfyUiProviderAdapter.referenceDataUrl(new GeneratedBinary(data, "audio/x-wav"),
                        AutoDlComfyUiProviderAdapter.WORKFLOW_ID, true));
        // 其他可配置工作流可自行接收GIF等格式，不能被H3的accept_types误拦截。
        Assertions.assertEquals("data:image/gif;base64," + encoded,
                AutoDlComfyUiProviderAdapter.referenceDataUrl(new GeneratedBinary(data, "image/gif"),
                        "custom_video_workflow_v2", false));
    }

    /** 构建视频任务上下文。 */
    private AiTaskExecutionContext videoContext(String workflowId) {
        AiGenerationTask task = new AiGenerationTask();
        task.setId("task-1");
        task.setUserId(7L);
        task.setTaskType(AiTaskTypes.VIDEO);
        AiTaskDtos.AiTaskMediaReference image = new AiTaskDtos.AiTaskMediaReference(
                "image-1", "reference.png", "image/png", "image:owned-reference",
                "https://example.com/reference.png");
        AiTaskDtos.AiTaskMediaReference audio = new AiTaskDtos.AiTaskMediaReference(
                "audio-1", "reference.mp3", "audio/mpeg", "audio:owned-reference",
                "https://example.com/reference.mp3", null, 500, 1500);
        return new AiTaskExecutionContext(
                task,
                new AiTaskDtos.AiChannelConfig(
                        "channel-1", "AutoDL ComfyUI", "https://autodl.art", "test-token",
                        AutoDlComfyUiProviderAdapter.API_FORMAT, List.of(workflowId)),
                workflowId,
                false,
                "",
                new AiTaskDtos.CreateAiTaskRequest(
                        AiTaskTypes.VIDEO, "让商品缓慢旋转", workflowId,
                        Map.of("size", "9:16", "resolution", "768p", "seconds", "5"),
                        List.of(image), List.of(), "videoPage", List.of(), List.of(),
                        "reference-to-video", List.of(audio)),
                () -> Mono.just(false),
                progress -> Mono.empty(),
                delta -> Mono.empty());
    }
}
