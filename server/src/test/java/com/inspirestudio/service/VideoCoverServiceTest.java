package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.entity.PersistenceRecords;
import com.inspirestudio.repository.PersistenceRepository;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.task.VideoCoverMediaProcessor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

@ExtendWith(MockitoExtension.class)
class VideoCoverServiceTest {
    @Mock CurrentUserProvider currentUser;
    @Mock PersistenceRepository repository;
    @Mock PersistenceService persistence;
    @Mock VideoCoverMediaProcessor processor;
    private VideoCoverService service;
    private PersistenceRecords.MediaFileRecord source;

    @BeforeEach
    void setUp() {
        service = new VideoCoverService(currentUser, repository, persistence, processor);
        source = new PersistenceRecords.MediaFileRecord();
        source.setUserId(7L);
        source.setStorageKey("video:test");
        source.setKind("video");
        source.setObjectStorageKey("videos/original.mp4");
        source.setObjectStorageUrl("https://media.example/video.mp4");
        source.setBytes(647000L);
    }

    @Test
    void requiresAuthenticationBeforeMediaLookup() {
        when(currentUser.currentUserId()).thenReturn(Mono.error(new BusinessException(ErrorCode.TOKEN_INVALID, "请先登录")));
        BusinessException error = assertThrows(BusinessException.class, () -> service.getOrCreate("video:test").block());
        assertEquals(ErrorCode.TOKEN_INVALID, error.getCode());
        verifyNoInteractions(repository, persistence, processor);
    }

    @Test
    void doesNotUseOtherUsersSourceOrDerivedMedia() {
        when(currentUser.currentUserId()).thenReturn(Mono.just(8L));
        when(repository.getMedia(8L, "video:test")).thenReturn(Mono.empty());
        BusinessException error = assertThrows(BusinessException.class, () -> service.getOrCreate("video:test").block());
        assertEquals(ErrorCode.RESOURCE_NOT_FOUND, error.getCode());
        verify(repository).getMedia(8L, "video:test");
        verifyNoMoreInteractions(repository);
        verifyNoInteractions(persistence, processor);
    }

    @Test
    void rejectsNonVideoEvenWhenItsMimeClaimsVideo() {
        source.setKind("image");
        source.setMimeType("video/mp4");
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source));
        BusinessException error = assertThrows(BusinessException.class, () -> service.getOrCreate("video:test").block());
        assertEquals(ErrorCode.PARAM_INVALID, error.getCode());
        verifyNoInteractions(persistence, processor);
    }

    @Test
    void reusesStoredCoverAndReturnsOriginalVideoDimensions() {
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source));
        String coverKey = VideoCoverService.derivedStorageKey(7L, source);
        PersistenceRecords.MediaFileRecord cover = new PersistenceRecords.MediaFileRecord();
        cover.setObjectStorageUrl("https://media.example/cover.jpg");
        cover.setWidth(640);
        cover.setHeight(360);
        cover.setMetadata("{\"sourceWidth\":1920,\"sourceHeight\":1080}");
        when(repository.getMedia(7L, coverKey)).thenReturn(Mono.just(cover));
        var result = service.getOrCreate("video:test").block();
        assertEquals(new PersistenceDtos.VideoCoverResponse("https://media.example/cover.jpg", coverKey, 1920, 1080), result);
        verifyNoInteractions(persistence, processor);
    }

    @Test
    void concurrentRequestsShareExtractionEvenIfOneSubscriberCancels() throws Exception {
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source));
        String coverKey = VideoCoverService.derivedStorageKey(7L, source);
        when(repository.getMedia(7L, coverKey)).thenReturn(Mono.empty());
        Sinks.One<PersistenceService.DownloadedMediaFile> download = Sinks.one();
        CountDownLatch started = new CountDownLatch(1);
        AtomicReference<Path> input = new AtomicReference<>();
        when(persistence.downloadVideoMediaToFileForUser(eq(7L), eq("video:test"), any(), eq(Duration.ofSeconds(90)))).thenAnswer(invocation -> {
            input.set(invocation.getArgument(2));
            started.countDown();
            return download.asMono();
        });
        when(processor.extract(any(), any())).thenReturn(new VideoCoverMediaProcessor.CoverResult(1920, 1080, 640, 360));
        when(persistence.storeDerivedMediaFileForUser(eq(7L), eq(coverKey), eq("image"), eq("video-cover.jpg"),
                eq("image/jpeg"), any(), eq(640), eq(360), isNull(), any())).thenReturn(Mono.just(stored(coverKey)));

        var canceled = service.getOrCreate("video:test").subscribe();
        assertTrue(started.await(5, TimeUnit.SECONDS));
        var first = service.getOrCreate("video:test").toFuture();
        canceled.dispose();
        var second = service.getOrCreate("video:test").toFuture();
        download.tryEmitValue(new PersistenceService.DownloadedMediaFile("video:test", input.get(), "video/mp4", 647000L));
        assertEquals(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
        assertFalse(Files.exists(input.get().getParent()), "临时目录应在响应返回前清理");
        verify(persistence, times(1)).downloadVideoMediaToFileForUser(eq(7L), eq("video:test"), any(), eq(Duration.ofSeconds(90)));
        verify(processor, times(1)).extract(any(), any());
        ArgumentCaptor<JSONObject> metadata = ArgumentCaptor.forClass(JSONObject.class);
        verify(persistence, times(1)).storeDerivedMediaFileForUser(eq(7L), eq(coverKey), eq("image"), eq("video-cover.jpg"),
                eq("image/jpeg"), any(), eq(640), eq(360), isNull(), metadata.capture());
        assertEquals(1920, metadata.getValue().getIntValue("sourceWidth"));
        assertEquals(1080, metadata.getValue().getIntValue("sourceHeight"));
        verify(repository, never()).saveMedia(any());
    }

    @Test
    void failedExtractionCleansFilesAndCanBeRetriedWithoutChangingSource() {
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source));
        String coverKey = VideoCoverService.derivedStorageKey(7L, source);
        when(repository.getMedia(7L, coverKey)).thenReturn(Mono.empty());
        AtomicReference<Path> input = new AtomicReference<>();
        when(persistence.downloadVideoMediaToFileForUser(eq(7L), eq("video:test"), any(), eq(Duration.ofSeconds(90)))).thenAnswer(invocation -> {
            Path path = invocation.getArgument(2);
            input.set(path);
            Files.writeString(path, "invalid video");
            return Mono.just(new PersistenceService.DownloadedMediaFile("video:test", path, "video/mp4", 13L));
        });
        when(processor.extract(any(), any())).thenThrow(new BusinessException(ErrorCode.PARAM_INVALID, "损坏的视频"))
                .thenReturn(new VideoCoverMediaProcessor.CoverResult(1920, 1080, 640, 360));
        when(persistence.storeDerivedMediaFileForUser(eq(7L), eq(coverKey), eq("image"), eq("video-cover.jpg"),
                eq("image/jpeg"), any(), eq(640), eq(360), isNull(), any())).thenReturn(Mono.just(stored(coverKey)));
        assertThrows(BusinessException.class, () -> service.getOrCreate("video:test").block(Duration.ofSeconds(5)));
        assertFalse(Files.exists(input.get().getParent()));
        assertEquals(1920, service.getOrCreate("video:test").block(Duration.ofSeconds(5)).width());
        verify(processor, times(2)).extract(any(), any());
        verify(repository, never()).saveMedia(any());
        assertEquals("https://media.example/video.mp4", source.getObjectStorageUrl());
    }

    @Test
    void replacingSourceObjectInvalidatesCoverIdentity() {
        String original = VideoCoverService.derivedStorageKey(7L, source);
        assertEquals(original, VideoCoverService.derivedStorageKey(7L, source));
        assertNotEquals(original, VideoCoverService.derivedStorageKey(8L, source));
        source.setObjectStorageKey("videos/replaced.mp4");
        assertNotEquals(original, VideoCoverService.derivedStorageKey(7L, source));
    }

    @Test
    void tailRequiresAuthenticationBeforeAnySourceOrCacheLookup() {
        when(currentUser.currentUserId()).thenReturn(Mono.error(new BusinessException(ErrorCode.TOKEN_INVALID, "请先登录")));
        BusinessException error = assertThrows(BusinessException.class, () -> service.getOrCreateTail("video:test").block());
        assertEquals(ErrorCode.TOKEN_INVALID, error.getCode());
        verifyNoInteractions(repository, persistence, processor);
    }

    @Test
    void tailCannotUseAnotherUsersSourceOrAnExistingDerivedKey() {
        when(currentUser.currentUserId()).thenReturn(Mono.just(8L));
        when(repository.getMedia(8L, "video:test")).thenReturn(Mono.empty());
        BusinessException error = assertThrows(BusinessException.class, () -> service.getOrCreateTail("video:test").block());
        assertEquals(ErrorCode.RESOURCE_NOT_FOUND, error.getCode());
        verify(repository).getMedia(8L, "video:test");
        verifyNoMoreInteractions(repository);
        verifyNoInteractions(persistence, processor);
    }

    @Test
    void tailRechecksSourceOwnershipEvenAfterASuccessfulCachedRequest() {
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source), Mono.empty());
        String tailKey = VideoCoverService.derivedStorageKey(7L, source).replace("video-cover:", "video-tail:");
        when(repository.getMedia(7L, tailKey)).thenReturn(Mono.just(cachedFrame("https://media.example/tail.jpg")));
        assertEquals("https://media.example/tail.jpg", service.getOrCreateTail("video:test").block().coverUrl());
        BusinessException error = assertThrows(BusinessException.class, () -> service.getOrCreateTail("video:test").block());
        assertEquals(ErrorCode.RESOURCE_NOT_FOUND, error.getCode());
        verify(repository, times(2)).getMedia(7L, "video:test");
        verify(repository, times(1)).getMedia(7L, tailKey);
        verifyNoInteractions(persistence, processor);
    }

    @Test
    void normalCoverAndTailUseDifferentPersistentCacheEntries() {
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source));
        String coverKey = VideoCoverService.derivedStorageKey(7L, source);
        String tailKey = coverKey.replace("video-cover:", "video-tail:");
        assertNotEquals(coverKey, tailKey);
        when(repository.getMedia(7L, coverKey)).thenReturn(Mono.just(cachedFrame("https://media.example/cover.jpg")));
        when(repository.getMedia(7L, tailKey)).thenReturn(Mono.just(cachedFrame("https://media.example/tail.jpg")));
        assertEquals(new PersistenceDtos.VideoCoverResponse("https://media.example/cover.jpg", coverKey, 1920, 1080), service.getOrCreate("video:test").block());
        assertEquals(new PersistenceDtos.VideoCoverResponse("https://media.example/tail.jpg", tailKey, 1920, 1080), service.getOrCreateTail("video:test").block());
        verifyNoInteractions(persistence, processor);
    }

    @Test
    void missingTailInvokesTailExtractionAndPersistsItsPositionWithoutChangingSource() {
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source));
        String tailKey = VideoCoverService.derivedStorageKey(7L, source).replace("video-cover:", "video-tail:");
        when(repository.getMedia(7L, tailKey)).thenReturn(Mono.empty());
        AtomicReference<Path> input = new AtomicReference<>();
        when(persistence.downloadVideoMediaToFileForUser(eq(7L), eq("video:test"), any(), eq(Duration.ofSeconds(90)))).thenAnswer(invocation -> {
            Path path = invocation.getArgument(2);
            input.set(path);
            return Mono.just(new PersistenceService.DownloadedMediaFile("video:test", path, "video/mp4", 647000L));
        });
        when(processor.extractTail(any(), any())).thenReturn(new VideoCoverMediaProcessor.CoverResult(1920, 1080, 640, 360));
        when(persistence.storeDerivedMediaFileForUser(eq(7L), eq(tailKey), eq("image"), eq("video-cover.jpg"),
                eq("image/jpeg"), any(), eq(640), eq(360), isNull(), any())).thenReturn(Mono.just(stored(tailKey)));
        assertEquals(tailKey, service.getOrCreateTail("video:test").block(Duration.ofSeconds(5)).coverStorageKey());
        verify(processor).extractTail(any(), any());
        verify(processor, never()).extract(any(), any());
        ArgumentCaptor<JSONObject> metadata = ArgumentCaptor.forClass(JSONObject.class);
        verify(persistence).storeDerivedMediaFileForUser(eq(7L), eq(tailKey), eq("image"), eq("video-cover.jpg"),
                eq("image/jpeg"), any(), eq(640), eq(360), isNull(), metadata.capture());
        assertEquals("tail", metadata.getValue().getString("framePosition"));
        assertEquals("video:test", metadata.getValue().getString("sourceStorageKey"));
        assertFalse(Files.exists(input.get().getParent()), "尾帧完成后须清理下载文件");
        assertEquals("https://media.example/video.mp4", source.getObjectStorageUrl());
        verify(repository, never()).saveMedia(any());
    }

    @Test
    void tailRejectsNonVideoBeforeCacheAndExtraction() {
        source.setKind("image");
        source.setMimeType("video/mp4");
        when(currentUser.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.getMedia(7L, "video:test")).thenReturn(Mono.just(source));
        BusinessException error = assertThrows(BusinessException.class, () -> service.getOrCreateTail("video:test").block());
        assertEquals(ErrorCode.PARAM_INVALID, error.getCode());
        verify(repository).getMedia(7L, "video:test");
        verifyNoMoreInteractions(repository);
        verifyNoInteractions(persistence, processor);
    }

    private PersistenceRecords.MediaFileRecord cachedFrame(String url) {
        PersistenceRecords.MediaFileRecord frame = new PersistenceRecords.MediaFileRecord();
        frame.setObjectStorageUrl(url);
        frame.setWidth(640);
        frame.setHeight(360);
        frame.setMetadata("{\"sourceWidth\":1920,\"sourceHeight\":1080}");
        return frame;
    }

    private PersistenceDtos.UploadedMediaResponse stored(String key) {
        return new PersistenceDtos.UploadedMediaResponse(key, "https://media.example/cover.jpg", 1000L, "image/jpeg", 640, 360, null, null);
    }
}
