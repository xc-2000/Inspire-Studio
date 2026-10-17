package com.inspirestudio.ai;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.service.PersistenceService;
import java.util.Base64;
import java.util.Arrays;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

/**
 * AI媒体处理服务测试。
 *
 * @date 2026-07-26 00:00
 */
class AiMediaSupportTest {
    @Test
    void shouldPersistDecodedImageDimensionsInsteadOfRequestedDimensions() throws Exception {
        var output = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(1254, 1254, java.awt.image.BufferedImage.TYPE_INT_RGB), "png", output);
        byte[] bytes = output.toByteArray();
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq("image"), eq("generated.png"), eq("image/png"), eq(bytes), eq(1254), eq(1254), eq(0)))
                .thenReturn(Mono.just(mediaResponse("https://r2.example/actual.png")));
        service.storeGeneratedMedia(1L, "image", "generated.png", new GeneratedBinary(bytes, "image/png"), 4096, 4096, 0).block();
        verify(persistenceService).storeGeneratedMediaForUser(1L, "image", "generated.png", "image/png", bytes, 1254, 1254, 0);
    }

    @Test
    void shouldReadDimensionsFromImageResultWithoutProviderMetadata() throws Exception {
        var output = new java.io.ByteArrayOutputStream();
        javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(64, 32, java.awt.image.BufferedImage.TYPE_INT_RGB), "jpg", output);
        byte[] bytes = output.toByteArray();
        JSONObject item = new JSONObject();
        item.put("b64_json", Base64.getEncoder().encodeToString(bytes));
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq("image"), eq("generated.png"), anyString(), eq(bytes), eq(64), eq(32), eq(0)))
                .thenReturn(Mono.just(mediaResponse("https://r2.example/actual.jpg")));
        service.storeGeneratedImageItem(1L, item, null, null, 0).block();
        verify(persistenceService).storeGeneratedMediaForUser(eq(1L), eq("image"), eq("generated.png"), anyString(), eq(bytes), eq(64), eq(32), eq(0));
    }

    @Test
    void shouldStoreVideoUrlAndCleanTemporaryFile() {
        var capturedFile = new java.util.concurrent.atomic.AtomicReference<java.nio.file.Path>();
        when(aiHttpClient.downloadRemoteMediaToFile(anyString(), anyString(), any(), org.mockito.ArgumentMatchers.anyLong()))
                .thenAnswer(invocation -> {
                    capturedFile.set(invocation.getArgument(2));
                    return Mono.just(new AiHttpClient.RemoteMediaFile(12L, "video/mp4"));
                });
        when(persistenceService.storeGeneratedMediaFileForUser(eq(1L), eq("video"), eq("generated.mp4"), eq("video/mp4"), any(), eq(null), eq(null), eq(5000)))
                .thenReturn(Mono.just(mediaResponse("https://r2.example/video.mp4")));
        var result = service.registerGeneratedMediaUrl(1L, "video", "https://provider.example/video.mp4", "video/mp4", null, null, 5000).block();
        Assertions.assertEquals("https://r2.example/video.mp4", result.url());
        Assertions.assertFalse(java.nio.file.Files.exists(capturedFile.get()));
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any());
    }

    @Test
    void shouldNotReturnProviderUrlWhenVideoUploadFails() {
        var capturedFile = new java.util.concurrent.atomic.AtomicReference<java.nio.file.Path>();
        when(aiHttpClient.downloadRemoteMediaToFile(anyString(), anyString(), any(), org.mockito.ArgumentMatchers.anyLong()))
                .thenAnswer(invocation -> {
                    capturedFile.set(invocation.getArgument(2));
                    return Mono.just(new AiHttpClient.RemoteMediaFile(12L, "video/mp4"));
                });
        when(persistenceService.storeGeneratedMediaFileForUser(any(), anyString(), anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "上传失败")));
        Assertions.assertThrows(BusinessException.class, () -> service.registerGeneratedMediaUrl(
                1L, "video", "https://provider.example/video.mp4", "video/mp4", null, null, 5000).block());
        Assertions.assertFalse(java.nio.file.Files.exists(capturedFile.get()));
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any());
    }

    @Test
    void shouldRetryReferenceDownloadOnceAndReportNoGenerationSubmitted() {
        var reference = new AiTaskDtos.AiTaskMediaReference("ref", "参考", "image/png", "", "https://example.com/ref.png");
        when(aiHttpClient.downloadRemoteBinary(anyString(), anyString()))
                .thenReturn(Mono.error(new java.net.http.HttpConnectTimeoutException("HTTP connect timed out")));
        reactor.test.StepVerifier.withVirtualTime(() -> service.resolveReferenceBinary(1L, reference, "image/png"))
                .thenAwait(java.time.Duration.ofSeconds(3))
                .expectErrorSatisfies(error -> {
                    var details = ((AiProviderException) error).getDetails();
                    Assertions.assertEquals("reference_media_unavailable", details.code());
                    Assertions.assertEquals(false, details.requestAccepted());
                    Assertions.assertEquals("download", details.stage());
                }).verify();
        verify(aiHttpClient, org.mockito.Mockito.times(2)).downloadRemoteBinary(anyString(), anyString());
    }

    @Test
    void shouldRecoverTemporaryReferenceConnectionFailure() {
        var reference = new AiTaskDtos.AiTaskMediaReference("ref", "参考", "image/png", "", "https://example.com/ref.png");
        var binary = new GeneratedBinary(new byte[]{1, 2}, "image/png");
        when(aiHttpClient.downloadRemoteBinary(anyString(), anyString()))
                .thenReturn(Mono.error(new java.net.http.HttpConnectTimeoutException("timeout")))
                .thenReturn(Mono.just(binary));
        reactor.test.StepVerifier.withVirtualTime(() -> service.resolveReferenceBinary(1L, reference, "image/png"))
                .thenAwait(java.time.Duration.ofSeconds(3)).expectNext(binary).verifyComplete();
        verify(aiHttpClient, org.mockito.Mockito.times(2)).downloadRemoteBinary(anyString(), anyString());
    }

    /** 第三方AI HTTP客户端 */
    private AiHttpClient aiHttpClient;

    /** 媒体持久化服务 */
    private PersistenceService persistenceService;

    /** 服务配置 */
    private InspireProperties properties;

    /** 待测试的AI媒体处理服务 */
    private AiMediaSupport service;

    /**
     * 初始化测试依赖。
     *
     * @return void 无返回值
     */
    @BeforeEach
    void setUp() {
        aiHttpClient = org.mockito.Mockito.mock(AiHttpClient.class);
        persistenceService = org.mockito.Mockito.mock(PersistenceService.class);
        properties = new InspireProperties();
        service = new AiMediaSupport(aiHttpClient, persistenceService, properties);
    }

    /**
     * 验证旧开关关闭时也必须转存HTTP图片。
     *
     * @return void 无返回值
     */
    @Test
    void shouldStoreHttpImageEvenWhenLegacyFlagIsDisabled() {
        String sourceUrl = "http://provider.example/generated.png";
        when(aiHttpClient.downloadRemoteBinary(sourceUrl, "image/png")).thenReturn(Mono.just(new GeneratedBinary(new byte[]{1}, "image/png")));
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq("image"), eq("generated.png"), eq("image/png"), any(byte[].class), eq(null), eq(null), eq(0)))
                .thenReturn(Mono.just(mediaResponse("https://r2.example/generated.png")));

        PersistenceDtos.UploadedMediaResponse response = service.storeGeneratedImageItem(1L, imageItem(sourceUrl), null, null, 0).block();

        Assertions.assertNotNull(response);
        Assertions.assertEquals("https://r2.example/generated.png", response.url());
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));

    }

    /**
     * 验证开启开关时HTTP图片转存到默认对象存储。
     *
     * @return void 无返回值
     */
    @Test
    void shouldUploadHttpImageResultToObjectStorageWhenEnabled() {
        String sourceUrl = "http://provider.example/generated.png";
        GeneratedBinary binary = new GeneratedBinary(new byte[] {1, 2, 3}, "image/png");
        properties.getAi().getImage().setUploadHttpResultToObjectStorage(true);
        when(aiHttpClient.downloadRemoteBinary(sourceUrl, "image/png")).thenReturn(Mono.just(binary));
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq(AiTaskTypes.IMAGE), eq("generated.png"), eq("image/png"), eq(binary.data()), eq(null), eq(null), eq(0)))
                .thenReturn(Mono.just(mediaResponse("https://cos.example/generated.png")));

        PersistenceDtos.UploadedMediaResponse response = service.storeGeneratedImageItem(1L, imageItem(sourceUrl), null, null, 0).block();

        Assertions.assertNotNull(response);
        Assertions.assertEquals("https://cos.example/generated.png", response.url());
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
    }

    /**
     * 验证开启开关后下载失败会直接使生成结果失败。
     *
     * @return void 无返回值
     */
    @Test
    void shouldFailHttpImageResultWhenRemoteDownloadFails() {
        String sourceUrl = "http://provider.example/generated.png";
        properties.getAi().getImage().setUploadHttpResultToObjectStorage(true);
        when(aiHttpClient.downloadRemoteBinary(sourceUrl, "image/png"))
                .thenReturn(Mono.error(new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "下载图片失败")));

        Assertions.assertThrows(BusinessException.class, () -> service.storeGeneratedImageItem(1L, imageItem(sourceUrl), null, null, 0).block());

        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
        verify(persistenceService, never()).storeGeneratedMediaForUser(any(), anyString(), anyString(), anyString(), any(), any(), any(), any());
    }

    /**
     * 验证开启开关后对象存储上传失败会直接使生成结果失败。
     *
     * @return void 无返回值
     */
    @Test
    void shouldFailHttpImageResultWhenObjectStorageUploadFails() {
        String sourceUrl = "http://provider.example/generated.png";
        GeneratedBinary binary = new GeneratedBinary(new byte[] {1, 2, 3}, "image/png");
        properties.getAi().getImage().setUploadHttpResultToObjectStorage(true);
        when(aiHttpClient.downloadRemoteBinary(sourceUrl, "image/png")).thenReturn(Mono.just(binary));
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq(AiTaskTypes.IMAGE), eq("generated.png"), eq("image/png"), eq(binary.data()), eq(null), eq(null), eq(0)))
                .thenReturn(Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR, "对象存储上传失败")));

        Assertions.assertThrows(BusinessException.class, () -> service.storeGeneratedImageItem(1L, imageItem(sourceUrl), null, null, 0).block());

        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
    }

    /**
     * 验证HTTPS图片同样转存对象存储。
     *
     * @return void 无返回值
     */
    @Test
    void shouldStoreHttpsImageResult() {
        String sourceUrl = "https://provider.example/generated.png";
        properties.getAi().getImage().setUploadHttpResultToObjectStorage(true);
        when(aiHttpClient.downloadRemoteBinary(sourceUrl, "image/png")).thenReturn(Mono.just(new GeneratedBinary(new byte[]{1}, "image/png")));
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq("image"), eq("generated.png"), eq("image/png"), any(byte[].class), eq(null), eq(null), eq(0)))
                .thenReturn(Mono.just(mediaResponse("https://r2.example/generated.png")));

        PersistenceDtos.UploadedMediaResponse response = service.storeGeneratedImageItem(1L, imageItem(sourceUrl), null, null, 0).block();

        Assertions.assertNotNull(response);
        Assertions.assertEquals("https://r2.example/generated.png", response.url());
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
    }

    /**
     * 验证Base64图片结果仍直接保存到默认对象存储。
     *
     * @return void 无返回值
     */
    @Test
    void shouldStoreBase64ImageResultWithoutRemoteDownload() {
        JSONObject item = new JSONObject();
        item.put("b64_json", Base64.getEncoder().encodeToString(new byte[] {1, 2, 3}));
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq(AiTaskTypes.IMAGE), eq("generated.png"), eq("image/png"), any(byte[].class), eq(null), eq(null), eq(0)))
                .thenReturn(Mono.just(mediaResponse("https://cos.example/generated.png")));

        PersistenceDtos.UploadedMediaResponse response = service.storeGeneratedImageItem(1L, item, null, null, 0).block();

        Assertions.assertNotNull(response);
        Assertions.assertEquals("https://cos.example/generated.png", response.url());
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
    }

    /**
     * 验证url字段返回base64 data URL时应直接解码并转存，不能走远程下载。
     *
     * @return void 无返回值
     */
    @Test
    void shouldStoreDataUrlImageResultWithoutRemoteDownload() {
        byte[] expected = new byte[] {1, 2, 3};
        String dataUrl = "data:image/png;base64," + Base64.getEncoder().encodeToString(expected);
        when(persistenceService.storeGeneratedMediaForUser(eq(1L), eq(AiTaskTypes.IMAGE), eq("generated.png"), eq("image/png"),
                org.mockito.ArgumentMatchers.argThat((byte[] data) -> Arrays.equals(expected, data)), eq(null), eq(null), eq(0)))
                .thenReturn(Mono.just(mediaResponse("https://cos.example/generated.png")));

        PersistenceDtos.UploadedMediaResponse response = service.storeGeneratedImageItem(1L, imageItem(dataUrl), null, null, 0).block();

        Assertions.assertNotNull(response);
        Assertions.assertEquals("https://cos.example/generated.png", response.url());
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
        verify(persistenceService, never()).registerRemoteMediaForUser(any(), any(PersistenceDtos.RegisterRemoteMediaRequest.class));
    }

    /** 参考媒体解析应拒绝任意非HTTP或data协议。 */
    @Test
    void shouldRejectUnsafeReferenceUrlProtocol() {
        AiTaskDtos.AiTaskMediaReference reference = new AiTaskDtos.AiTaskMediaReference(
                "reference-1", "参考", "image/png", "", " javascript:alert(1) ");

        Assertions.assertThrows(BusinessException.class, () -> service.resolveReferenceUrl(1L, reference).block());
        verify(persistenceService, never()).getMediaInfoForUser(any(), anyString());
    }

    /** 参考媒体解析应去除HTTP地址首尾空白。 */
    @Test
    void shouldTrimSafeReferenceUrl() {
        AiTaskDtos.AiTaskMediaReference reference = new AiTaskDtos.AiTaskMediaReference(
                "reference-1", "参考", "image/png", "", " https://example.com/reference.png ");

        Assertions.assertEquals("https://example.com/reference.png", service.resolveReferenceUrl(1L, reference).block());
    }

    /** 存储媒体查询为空时，参考解析应返回明确资源错误。 */
    @Test
    void shouldRejectMissingStoredReference() {
        when(persistenceService.getMediaInfoForUser(eq(1L), eq("image:missing"))).thenReturn(Mono.empty());
        AiTaskDtos.AiTaskMediaReference reference = new AiTaskDtos.AiTaskMediaReference(
                "reference-1", "参考", "image/png", "image:missing", null);

        BusinessException exception = Assertions.assertThrows(BusinessException.class, () -> service.resolveReferenceUrl(1L, reference).block());

        Assertions.assertTrue(exception.getMessage().contains("不存在或不属于当前用户"));
    }

    /**
     * 创建图片接口结果项。
     *
     * @param url String 图片地址
     * @return JSONObject 图片接口结果项
     */
    private JSONObject imageItem(String url) {
        JSONObject item = new JSONObject();
        item.put("url", url);
        item.put("mimeType", "image/png");
        return item;
    }

    /**
     * 创建媒体响应。
     *
     * @param url String 媒体访问地址
     * @return UploadedMediaResponse 媒体响应
     */
    private PersistenceDtos.UploadedMediaResponse mediaResponse(String url) {
        return new PersistenceDtos.UploadedMediaResponse("image:test", url, 12L, "image/png", null, null, 0, null);
    }
}


