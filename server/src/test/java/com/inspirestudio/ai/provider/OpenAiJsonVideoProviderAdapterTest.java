package com.inspirestudio.ai.provider;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.ai.AiHttpClient;
import com.inspirestudio.ai.AiErrorDetails;
import com.inspirestudio.ai.AiMediaSupport;
import com.inspirestudio.ai.AiProviderException;
import com.inspirestudio.ai.AiTaskExecutionContext;
import com.inspirestudio.ai.AiTaskTypes;
import com.inspirestudio.ai.GeneratedBinary;
import com.inspirestudio.ai.VideoGenerationMode;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.entity.AiGenerationTask;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import reactor.core.publisher.Mono;

/** OpenAI JSON视频渠道协议测试。 */
class OpenAiJsonVideoProviderAdapterTest {

    @Test
    void shouldReadNativeFailureReasonWithoutExposingRawTask() {
        var http = mock(AiHttpClient.class);
        var properties = new InspireProperties();
        properties.getAi().getLumina().setLocalApiToken("native-token");
        var response = JSON.parseObject("{\"error\":{\"message\":\"Upstream video generation did not complete\"}}");
        when(http.sendBearerJsonUrlRequest(any(), eq("GET"), eq("http://127.0.0.1/v1/videos/123"), eq(null)))
                .thenReturn(Mono.just(JSON.parseObject("{\"task\":{\"status\":\"risk\",\"children\":[{\"fail_reason\":\"The input text may contain sensitive information. [code=23003]\",\"extra\":{\"error_code\":23003},\"inputs\":[{\"prompt\":\"private original prompt\"}]}]}}")));
        var error = new OpenAiJsonVideoProviderAdapter(http, null, properties)
                .resolveVideoFailure(videoContext(), "video_123", response).block();
        Assertions.assertNotNull(error);
        Assertions.assertEquals("23003", error.getDetails().code());
        Assertions.assertEquals("prompt_policy_violation", error.getDetails().category());
        Assertions.assertTrue(error.isTerminalTaskFailure());
        Assertions.assertTrue(error.getMessage().contains("提示词未通过上游内容审核"));
        Assertions.assertFalse(error.getMessage().contains("private original prompt"));
    }

    @Test
    void shouldKeepOriginalFailureIfNativeLookupIsUnavailable() {
        var http = mock(AiHttpClient.class);
        var properties = new InspireProperties();
        properties.getAi().getLumina().setLocalApiToken("native-token");
        when(http.sendBearerJsonUrlRequest(any(), any(), any(), eq(null)))
                .thenReturn(Mono.error(new IllegalStateException("native lookup unavailable")));
        var error = new OpenAiJsonVideoProviderAdapter(http, null, properties).resolveVideoFailure(videoContext(), "video_123",
                JSON.parseObject("{\"error\":{\"message\":\"Upstream video generation did not complete\"}}" )).block();
        Assertions.assertNotNull(error);
        Assertions.assertEquals("Upstream video generation did not complete", error.getMessage());
        Assertions.assertTrue(error.isTerminalTaskFailure());
    }

    @Test
    void shouldNotLookupNativeDetailsWithoutTokenOrForSpecificErrors() {
        var http = mock(AiHttpClient.class);
        var properties = new InspireProperties();
        var adapter = new OpenAiJsonVideoProviderAdapter(http, null, properties);
        adapter.resolveVideoFailure(videoContext(), "video_123", JSON.parseObject("{\"error\":{\"message\":\"Upstream video generation did not complete\"}}" )).block();
        properties.getAi().getLumina().setLocalApiToken("native-token");
        var error = adapter.resolveVideoFailure(videoContext(), "video_123", JSON.parseObject("{\"error\":{\"message\":\"Account balance insufficient\"}}" )).block();
        Assertions.assertEquals("Account balance insufficient", error.getMessage());
        verify(http, never()).sendBearerJsonUrlRequest(any(), any(), any(), any());
    }

    /** Lumina OpenAI地址应转换为同服务的原生媒体上传地址。 */
    @Test
    void shouldBuildLuminaNativeImageUploadUrl() {
        Assertions.assertEquals("http://192.0.2.20:8788/v1/media/images",
                OpenAiJsonVideoProviderAdapter.luminaImageUploadUrl(
                        "http://192.0.2.20:8788/openai/v1/"));
    }

    /** 前端使用image/*时必须按真实PNG文件头上传，不能误报格式不支持。 */
    @Test
    void shouldDetectPngWhenDeclaredMimeTypeIsGeneric() throws Exception {
        byte[] png = imageBytes("png");

        var image = OpenAiJsonVideoProviderAdapter.prepareLuminaReferenceImage(
                new GeneratedBinary(png, "image/png"), "image/*");

        Assertions.assertEquals("image/png", image.mimeType());
        Assertions.assertArrayEquals(png, image.data());
    }

    /** Lumina不直接接受但ImageIO可读取的图片应自动转换为PNG。 */
    @Test
    void shouldConvertBmpReferenceImageToPng() throws Exception {
        byte[] bmp = imageBytes("bmp");

        var image = OpenAiJsonVideoProviderAdapter.prepareLuminaReferenceImage(
                new GeneratedBinary(bmp, "image/bmp"), "image/bmp");

        Assertions.assertEquals("image/png", image.mimeType());
        Assertions.assertEquals(0x89, image.data()[0] & 0xff);
        Assertions.assertEquals('P', image.data()[1]);
        Assertions.assertEquals('N', image.data()[2]);
        Assertions.assertEquals('G', image.data()[3]);
    }

    /** 新格式只能处理视频任务。 */
    @Test
    void shouldOnlySupportVideoTasks() {
        OpenAiJsonVideoProviderAdapter adapter = new OpenAiJsonVideoProviderAdapter(null, null, new InspireProperties());

        Assertions.assertEquals("openai-video-json", adapter.apiFormat());
        Assertions.assertTrue(adapter.supports(AiTaskTypes.VIDEO));
        Assertions.assertFalse(adapter.supports(AiTaskTypes.IMAGE));
        Assertions.assertFalse(adapter.supports(AiTaskTypes.TEXT));
    }

    /** 四种页面视频模式应映射到文档规定的JSON字段。 */
    @Test
    void shouldMapAllVideoModesToLuminaJsonProtocol() {
        Map<String, Object> parameters = Map.of("seconds", "10", "resolution", "720P", "size", "16:9");

        JSONObject text = json(OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                "Doubao-Seedance-2.0-pro-fast", "城市夜景", parameters, VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of()));
        JSONObject image = json(OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                "Doubao-Seedance-2.0-pro-fast", "镜头推进", parameters, VideoGenerationMode.IMAGE_TO_VIDEO,
                List.of("https://example.com/input.png"), List.of("reference_image")));
        JSONObject firstLast = json(OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                "Doubao-Seedance-2.0-pro-fast", "平滑过渡", parameters, VideoGenerationMode.FIRST_LAST_FRAME_TO_VIDEO,
                List.of("https://example.com/last.png", "https://example.com/first.png"), List.of("last_frame", "first_frame")));
        JSONObject reference = json(OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                "Doubao-Seedance-2.0-pro-fast", "保持主体一致", parameters, VideoGenerationMode.REFERENCE_TO_VIDEO,
                List.of("https://example.com/a.png", "https://example.com/b.png"), List.of("reference_image", "reference_image")));

        Assertions.assertEquals("t2v", text.getString("task_type"));
        Assertions.assertEquals(10, text.getIntValue("seconds"));
        Assertions.assertEquals("720p", text.getString("resolution"));
        Assertions.assertEquals("16:9", text.getString("aspect_ratio"));
        Assertions.assertTrue(text.getBooleanValue("with_audio"));
        Assertions.assertEquals("i2v", image.getString("task_type"));
        Assertions.assertEquals(List.of("https://example.com/input.png"),
                image.getJSONArray("media_urls").toJavaList(String.class));
        Assertions.assertFalse(image.containsKey("input_reference"));
        Assertions.assertFalse(image.containsKey("prompt_pic"));
        Assertions.assertEquals("flf", firstLast.getString("task_type"));
        Assertions.assertEquals("https://example.com/first.png", firstLast.getString("first_prompt_pic"));
        Assertions.assertEquals("https://example.com/last.png", firstLast.getString("last_prompt_pic"));
        Assertions.assertEquals("r2v", reference.getString("task_type"));
        Assertions.assertEquals(List.of("https://example.com/a.png", "https://example.com/b.png"),
                reference.getJSONArray("reference_urls").toJavaList(String.class));
    }

    /** 像素尺寸应发送size，并允许显式关闭音频。 */
    @Test
    void shouldPreservePixelSizeAndAudioSetting() {
        JSONObject payload = json(OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                "Doubao-Seedance-2.0-pro-fast", "测试", Map.of("duration", 5, "size", "1280X720", "with_audio", false),
                VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of()));

        Assertions.assertEquals("1280x720", payload.getString("size"));
        Assertions.assertFalse(payload.containsKey("aspect_ratio"));
        Assertions.assertFalse(payload.getBooleanValue("with_audio"));
    }

    /** Mini 模型不得把超过 8 秒的请求发送到 Lumina。 */
    @Test
    void shouldRejectSeedanceMiniDurationOverEightSeconds() {
        BusinessException error = Assertions.assertThrows(BusinessException.class, () ->
                OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                        "Doubao-Seedance-2.0-mini", "测试", Map.of("seconds", 9),
                        VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of()));

        Assertions.assertTrue(error.getMessage().contains("4到8秒"));
    }

    /** 不同实时模型ID应应用各自的时长、清晰度和提示词限制。 */
    @Test
    void shouldApplyPerModelLimitsFromLuminaDocumentation() {
        JSONObject seedance25 = json(OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                "Doubao-Seedance-2.5", "测试", Map.of("seconds", 30, "resolution", "1080p"),
                VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of()));
        JSONObject seedance20Pro = json(OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                "Doubao-Seedance-2.0-pro", "测试", Map.of("seconds", 15, "resolution", "4k"),
                VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of()));

        Assertions.assertEquals(30, seedance25.getIntValue("seconds"));
        Assertions.assertEquals("1080p", seedance25.getString("resolution"));
        Assertions.assertEquals("4k", seedance20Pro.getString("resolution"));
        Assertions.assertThrows(BusinessException.class, () ->
                OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                        "Doubao-Seedance-2.0-pro-fast", "测试", Map.of("seconds", 5, "resolution", "1080p"),
                        VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of()));
        Assertions.assertThrows(BusinessException.class, () ->
                OpenAiJsonVideoProviderAdapter.buildVideoRequestPayload(
                        "ByteDance-Seedance-1.0-pro-fast", "字".repeat(501), Map.of("seconds", 5, "resolution", "480p"),
                        VideoGenerationMode.TEXT_TO_VIDEO, List.of(), List.of()));
    }

    /** 提交、轮询、下载和对象存储应完整走JSON协议与/content端点。 */
    @Test
    void shouldSubmitJsonPollDownloadAndStoreVideo() {
        AiHttpClient aiHttpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        InspireProperties properties = new InspireProperties();
        properties.getAi().getTask().setPollingIntervalSeconds(1);
        OpenAiJsonVideoProviderAdapter adapter = new OpenAiJsonVideoProviderAdapter(aiHttpClient, mediaSupport, properties);

        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"), eq("/videos"), any(), any()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_7687663393578188853\",\"status\":\"queued\"}")));
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"), eq("/videos/video_7687663393578188853"), eq(null)))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_7687663393578188853\",\"status\":\"completed\"}")));
        when(aiHttpClient.downloadBinary(any(AiTaskDtos.AiChannelConfig.class), eq("/videos/video_7687663393578188853/content")))
                .thenReturn(Mono.just(new GeneratedBinary(new byte[]{1, 2, 3}, "video/mp4")));
        PersistenceDtos.UploadedMediaResponse stored = new PersistenceDtos.UploadedMediaResponse(
                "video:test", "https://cdn.example.com/generated.mp4", 3L, "video/mp4", null, null, 5000, null);
        when(mediaSupport.storeGeneratedMedia(eq(1L), eq(AiTaskTypes.VIDEO), eq("generated-video.mp4"), any(), eq(null), eq(null), eq(5000)))
                .thenReturn(Mono.just(stored));

        JSONObject result = adapter.execute(videoContext()).block();

        Assertions.assertNotNull(result);
        Assertions.assertEquals("video_7687663393578188853", result.getString("providerTaskId"));
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        ArgumentCaptor<Map<String, String>> headers = ArgumentCaptor.forClass(Map.class);
        verify(aiHttpClient).sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"), eq("/videos"), payload.capture(), headers.capture());
        verify(aiHttpClient, never()).sendMultipartRequest(any(), any(), any(), any());
        JSONObject request = json(payload.getValue());
        Assertions.assertEquals("t2v", request.getString("task_type"));
        Assertions.assertEquals("Doubao-Seedance-2.0-pro-fast", request.getString("model"));
        Assertions.assertEquals("inspire-video-task-1", headers.getValue().get("Idempotency-Key"));
        verify(aiHttpClient).downloadBinary(any(AiTaskDtos.AiChannelConfig.class), eq("/videos/video_7687663393578188853/content"));
        verify(mediaSupport).storeGeneratedMedia(eq(1L), eq(AiTaskTypes.VIDEO), eq("generated-video.mp4"), any(), eq(null), eq(null), eq(5000));
    }

    /** 轮询偶发404时应继续查询原任务，且绝不能再次POST造成重复生成。 */
    @Test
    void shouldKeepPollingOriginalTaskWithoutDuplicateSubmissionAfterTransient404() {
        AiHttpClient aiHttpClient = mock(AiHttpClient.class);
        AiMediaSupport mediaSupport = mock(AiMediaSupport.class);
        InspireProperties properties = new InspireProperties();
        OpenAiJsonVideoProviderAdapter adapter = new OpenAiJsonVideoProviderAdapter(aiHttpClient, mediaSupport, properties);
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"), eq("/videos"), any(), any()))
                .thenReturn(Mono.just(JSON.parseObject("{\"id\":\"video_original\",\"status\":\"queued\"}")));
        when(aiHttpClient.sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"), eq("/videos/video_original"), eq(null)))
                .thenReturn(Mono.error(new AiProviderException(new AiErrorDetails(
                        "provider", "http", "polling", 404, "404", "invalid_request_error", null,
                        "Task 'video_original' was not found", true, false))),
                        Mono.just(JSON.parseObject("{\"id\":\"video_original\",\"status\":\"completed\"}")));
        when(aiHttpClient.downloadBinary(any(AiTaskDtos.AiChannelConfig.class), eq("/videos/video_original/content")))
                .thenReturn(Mono.just(new GeneratedBinary(new byte[]{1, 2, 3}, "video/mp4")));
        PersistenceDtos.UploadedMediaResponse stored = new PersistenceDtos.UploadedMediaResponse(
                "video:original", "https://cdn.example.com/original.mp4", 3L, "video/mp4", null, null, 5000, null);
        when(mediaSupport.storeGeneratedMedia(eq(1L), eq(AiTaskTypes.VIDEO), eq("generated-video.mp4"), any(), eq(null), eq(null), eq(5000)))
                .thenReturn(Mono.just(stored));

        JSONObject result = adapter.execute(videoContext()).block();

        Assertions.assertNotNull(result);
        Assertions.assertEquals("video_original", result.getString("providerTaskId"));
        ArgumentCaptor<Map<String, String>> headers = ArgumentCaptor.forClass(Map.class);
        verify(aiHttpClient, times(1)).sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("POST"), eq("/videos"), any(), headers.capture());
        verify(aiHttpClient, times(2)).sendJsonRequest(any(AiTaskDtos.AiChannelConfig.class), eq("GET"), eq("/videos/video_original"), eq(null));
        Assertions.assertEquals("inspire-video-task-1", headers.getValue().get("Idempotency-Key"));
        verify(aiHttpClient).downloadBinary(any(AiTaskDtos.AiChannelConfig.class), eq("/videos/video_original/content"));
    }

    /** 完成响应存在远程视频地址时应优先读取。 */
    @Test
    void shouldReadNestedCompletedVideoUrl() {
        JSONObject response = JSON.parseObject("{\"status\":\"completed\",\"output\":{\"video_url\":\"https://example.com/video.mp4\"}}");

        Assertions.assertEquals("https://example.com/video.mp4", OpenAiJsonVideoProviderAdapter.readVideoResultUrl(response));
    }

    private AiTaskExecutionContext videoContext() {
        AiGenerationTask task = new AiGenerationTask();
        task.setId("task-1");
        task.setTaskType(AiTaskTypes.VIDEO);
        task.setUserId(1L);
        return new AiTaskExecutionContext(task,
                new AiTaskDtos.AiChannelConfig("channel-1", "Lumina 视频", "http://127.0.0.1/openai/v1",
                        "test-key", "openai-video-json", List.of("Doubao-Seedance-2.0-pro-fast")),
                "Doubao-Seedance-2.0-pro-fast", false, "",
                new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "一只猫在跑步", "Doubao-Seedance-2.0-pro-fast",
                        Map.of("seconds", "5", "resolution", "480p", "size", "16:9"),
                        List.of(), List.of(), "videoPage", null, null, VideoGenerationMode.TEXT_TO_VIDEO),
                () -> Mono.just(false), progress -> Mono.empty(), delta -> Mono.empty());
    }

    @Test
    void shouldConvertActualOpenDramaWebpEvenWhenNamedPng() throws Exception {
        byte[] webp = openDramaReference();
        var converted = OpenAiJsonVideoProviderAdapter.prepareLuminaReferenceImage(new GeneratedBinary(webp, "image/png"), "image/png");
        Assertions.assertEquals("image/png", converted.mimeType());
        BufferedImage original = ImageIO.read(new java.io.ByteArrayInputStream(webp));
        BufferedImage png = ImageIO.read(new java.io.ByteArrayInputStream(converted.data()));
        Assertions.assertNotNull(png);
        Assertions.assertEquals(original.getWidth(), png.getWidth());
        Assertions.assertEquals(original.getHeight(), png.getHeight());
        Assertions.assertArrayEquals(original.getRGB(0, 0, original.getWidth(), original.getHeight(), null, 0, original.getWidth()),
                png.getRGB(0, 0, png.getWidth(), png.getHeight(), null, 0, png.getWidth()));
    }

    @Test
    void shouldUploadConvertedReferenceBeforeSubmittingVideoExactlyOnce() throws Exception {
        AiHttpClient http = mock(AiHttpClient.class);
        AiMediaSupport media = mock(AiMediaSupport.class);
        InspireProperties properties = new InspireProperties();
        properties.getAi().getLumina().setLocalApiToken("test-upload-token");
        var base = videoContext();
        String url = "https://example.com/reference.png";
        var reference = new AiTaskDtos.AiTaskMediaReference("shot-1", "reference.png", "image/png", null, url);
        var request = new AiTaskDtos.CreateAiTaskRequest(AiTaskTypes.VIDEO, "卡车沿山路平稳行驶", base.model(), base.request().parameters(),
                List.of(reference), List.of(), "canvas", null, null, VideoGenerationMode.IMAGE_TO_VIDEO);
        var context = new AiTaskExecutionContext(base.task(), base.channel(), base.model(), false, "", request, base.cancelChecker(), base.progressReporter(), base.deltaEmitter());
        when(media.resolveReferenceUrl(1L, reference)).thenReturn(Mono.just(url));
        when(http.downloadRemoteBinary(url, "image/png")).thenReturn(Mono.just(new GeneratedBinary(openDramaReference(), "image/png")));
        when(http.uploadBinaryUrl(eq("http://127.0.0.1/v1/media/images"), eq("test-upload-token"), eq("image/png"), eq("reference-1.png"), any()))
                .thenAnswer(invocation -> {
                    byte[] uploaded = invocation.getArgument(4);
                    Assertions.assertEquals(0x89, uploaded[0] & 0xff);
                    Assertions.assertNotNull(ImageIO.read(new java.io.ByteArrayInputStream(uploaded)));
                    return Mono.just(JSON.parseObject("{\"uri\":\"tos://test/reference\"}"));
                });
        // Stop after the submission boundary; this test never contacts a paid model.
        when(http.sendJsonRequest(any(), eq("POST"), eq("/videos"), any(), any()))
                .thenReturn(Mono.error(new IllegalStateException("test-submission-boundary")));
        var error = Assertions.assertThrows(IllegalStateException.class,
                () -> new OpenAiJsonVideoProviderAdapter(http, media, properties).execute(context).block());
        Assertions.assertEquals("test-submission-boundary", error.getMessage());
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(http, times(1)).sendJsonRequest(any(), eq("POST"), eq("/videos"), payload.capture(), any());
        Assertions.assertEquals("i2v", json(payload.getValue()).getString("task_type"));
        Assertions.assertEquals(List.of("tos://test/reference"), json(payload.getValue()).getJSONArray("media_urls").toJavaList(String.class));
    }

    @Test
    void shouldRejectInvalidImageWithoutSubmitting() {
        Assertions.assertThrows(BusinessException.class, () -> OpenAiJsonVideoProviderAdapter.prepareLuminaReferenceImage(
                new GeneratedBinary("<html>not an image</html>".getBytes(java.nio.charset.StandardCharsets.UTF_8), "image/png"), "image/png"));
    }

    private byte[] openDramaReference() throws Exception {
        try (var input = getClass().getResourceAsStream("/media/open-drama-reference.webp")) {
            Assertions.assertNotNull(input);
            return input.readAllBytes();
        }
    }

    private JSONObject json(Object value) {
        return JSON.parseObject(JSON.toJSONString(value));
    }

    private byte[] imageBytes(String format) throws Exception {
        BufferedImage image = new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, 0x336699);
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            Assertions.assertTrue(ImageIO.write(image, format, output));
            return output.toByteArray();
        }
    }
}
