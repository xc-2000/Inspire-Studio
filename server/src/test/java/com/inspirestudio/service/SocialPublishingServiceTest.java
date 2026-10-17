package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.inspirestudio.common.JsonData;
import com.inspirestudio.common.SensitiveDataCrypto;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.SocialPublishingDtos;
import com.inspirestudio.entity.SocialPublishingRecords;
import com.inspirestudio.repository.SocialPublishingRepository;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.Map;
import java.util.List;
import static org.mockito.ArgumentMatchers.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class SocialPublishingServiceTest {

    @Test
    void taskStatusLookupIsScopedToCurrentUserAndDeduplicatesIds() {
        var task = new SocialPublishingRecords.TaskRecord();
        task.setId("task-1");
        task.setStatus("success");
        task.setResultData("{\"message\":\"发布成功\"}");
        when(repository.findTaskStatuses(42L, List.of("task-1", "missing")))
                .thenReturn(reactor.core.publisher.Flux.just(task));
        var result = service.taskStatuses(List.of("task-1", " task-1 ", "missing")).block();
        assertEquals(1, result.size());
        assertEquals("success", result.getFirst().status());
        assertEquals("发布成功", result.getFirst().resultData().get("message"));
        verify(repository).findTaskStatuses(42L, List.of("task-1", "missing"));
    }

    @Test
    void taskStatusLookupRejectsUnboundedRequests() {
        StepVerifier.create(service.taskStatuses(java.util.Collections.nCopies(101, "task-1")))
                .expectErrorMatches(error -> error.getMessage().contains("100"))
                .verify();
        verify(repository, never()).findTaskStatuses(anyLong(), anyList());
    }

    private PublisherClient publisherClient;
    private SocialPublishingService service;
    private SocialPublishingRepository repository;
    private InspireProperties properties;

    @BeforeEach
    void setUp() {
        repository = mock(SocialPublishingRepository.class);
        CurrentUserProvider currentUserProvider = mock(CurrentUserProvider.class);
        publisherClient = mock(PublisherClient.class);
        when(currentUserProvider.currentUserId()).thenReturn(Mono.just(42L));
        properties = new InspireProperties();
        properties.getApp().setSecretKey("test-secret");
        service = new SocialPublishingService(repository, currentUserProvider, properties,
                publisherClient, new JsonData());
    }

    @Test
    void expiredSessionIsSavedAsInvalidInsteadOfSuccess() {
        prepareAccount();
        when(publisherClient.check("wechat_channels", "test-credentials"))
                .thenReturn(Mono.just(Map.of("ok", false, "status", "invalid", "message", "登录过期，请重新扫码")));
        when(repository.updateAccountCheck(42L, 4L, "invalid", "登录过期，请重新扫码")).thenReturn(Mono.empty());
        service.checkAccount(4L).block();
        verify(repository).updateAccountCheck(42L, 4L, "invalid", "登录过期，请重新扫码");
    }

    @Test
    void transportFailureIsSavedAsUnknownAndUnwrapsMessage() {
        prepareAccount();
        when(publisherClient.check("wechat_channels", "test-credentials"))
                .thenReturn(Mono.error(new RuntimeException("{\"detail\":\"连接失败，请重试\"}")));
        when(repository.updateAccountCheck(42L, 4L, "error", "连接失败，请重试")).thenReturn(Mono.empty());
        StepVerifier.create(service.checkAccount(4L)).expectError(RuntimeException.class).verify();
        verify(repository).updateAccountCheck(42L, 4L, "error", "连接失败，请重试");
    }

    private void prepareAccount() {
        var account = new SocialPublishingRecords.AccountRecord();
        account.setId(4L);
        account.setPlatform("wechat_channels");
        account.setCredentialsEncrypted(SensitiveDataCrypto.encrypt("test-credentials", properties.getApp().getSecretKey()));
        when(repository.findAccount(42L, 4L)).thenReturn(Mono.just(account));
    }

    @Test
    void startingNewQrLoginCancelsAndInvalidatesPreviousUserSession() {
        when(publisherClient.startQrLogin("douyin"))
                .thenReturn(Mono.just(qrSession("first-session")), Mono.just(qrSession("second-session")));
        when(publisherClient.cancelQrLogin("first-session")).thenReturn(Mono.empty());
        var request = new SocialPublishingDtos.QrLoginStartRequest("douyin", null, "抖音账号", true);

        assertEquals("first-session", service.startQrLogin(request).block().sessionId());
        assertEquals("second-session", service.startQrLogin(request).block().sessionId());

        verify(publisherClient).cancelQrLogin("first-session");
        StepVerifier.create(service.qrLoginStatus("first-session"))
                .expectErrorMatches(error -> error.getMessage().contains("扫码会话不存在或已过期"))
                .verify();
        verify(publisherClient, never()).qrLoginStatus("first-session");
    }

    private Map<String, Object> qrSession(String sessionId) {
        return Map.of(
                "sessionId", sessionId,
                "platform", "douyin",
                "status", "waiting",
                "message", "请使用抖音扫码",
                "qrCodeDataUrl", "data:image/png;base64,test",
                "expiresAt", System.currentTimeMillis() + 300_000);
    }

    @Test
    void toutiaoQrUsesExistingUserOwnedAccountFlow() {
        when(publisherClient.startQrLogin("toutiao")).thenReturn(Mono.just(Map.of(
                "sessionId", "toutiao-session", "platform", "toutiao", "status", "waiting",
                "message", "请用今日头条扫码", "qrCodeDataUrl", "data:image/png;base64,test",
                "expiresAt", System.currentTimeMillis() + 180_000)));
        var response = service.startQrLogin(new SocialPublishingDtos.QrLoginStartRequest("toutiao", null, "头条账号", true)).block();
        assertEquals("toutiao", response.platform());
        assertEquals("waiting", response.status());
    }

    @Test
    void toutiaoRejectsInvalidTitlesAndVisibilityBeforeCreatingTask() {
        var account = new SocialPublishingRecords.AccountRecord();
        account.setId(4L); account.setPlatform("toutiao"); account.setEnabled(true);
        when(repository.findAccount(42L, 4L)).thenReturn(Mono.just(account));
        for (var request : List.of(toutiaoRequest("短", "public"), toutiaoRequest("雨夜中的纸飞机", "private"))) {
            StepVerifier.create(service.createTask(request)).expectError(com.inspirestudio.common.BusinessException.class).verify();
        }
        verify(repository, never()).createTask(any());
    }

    @Test
    void toutiaoDraftPersistsAndSubmitsOnceWithDraftMode() {
        var account = new SocialPublishingRecords.AccountRecord();
        account.setId(4L); account.setPlatform("toutiao"); account.setEnabled(true);
        account.setCredentialsEncrypted(SensitiveDataCrypto.encrypt("test-credentials", properties.getApp().getSecretKey()));
        when(repository.findAccount(42L, 4L)).thenReturn(Mono.just(account));
        when(repository.createTask(any())).thenAnswer(invocation -> Mono.just(invocation.getArgument(0)));
        when(repository.markTaskRunning(anyString())).thenReturn(Mono.empty());
        when(repository.finishTask(anyString(), anyString(), any(), any())).thenReturn(Mono.empty());
        when(publisherClient.publish(eq("toutiao"), eq("test-credentials"), eq("video"), anyString(), anyString(),
                anyList(), isNull(), anyList(), eq("draft"), eq("public"), eq(false), eq(false)))
                .thenReturn(Mono.just(Map.of("ok", true, "draft", true)));
        var result = service.createTask(toutiaoRequest("雨夜中的纸飞机", "public")).block();
        assertEquals("toutiao", result.platform());
        assertEquals("draft", result.publishMode());
        verify(publisherClient).publish(eq("toutiao"), eq("test-credentials"), eq("video"), eq("雨夜中的纸飞机"), eq(""),
                anyList(), isNull(), anyList(), eq("draft"), eq("public"), eq(false), eq(false));
        verify(repository).finishTask(anyString(), eq("success"), anyString(), isNull());
    }

    private SocialPublishingDtos.CreateTaskRequest toutiaoRequest(String title, String visibility) {
        return new SocialPublishingDtos.CreateTaskRequest(4L, "video", title, "",
                List.of("https://example.invalid/video.mp4"), null, List.of(), "draft", visibility, false, false);
    }
}
