package com.inspirestudio.service;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.inspirestudio.repository.NotificationRepository;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.security.CurrentUserProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

/**
 * 系统公告服务测试。
 *
 * @date     2026-07-19 16:10
 */
class NotificationServiceTest {

    /** 公告仓储 */
    private NotificationRepository notificationRepository;

    /** 当前用户提供器 */
    private CurrentUserProvider currentUserProvider;

    /** 待测试公告服务 */
    private NotificationService notificationService;

    /**
     * 初始化测试依赖。
     */
    @BeforeEach
    void setUp() {
        notificationRepository = mock(NotificationRepository.class);
        currentUserProvider = mock(CurrentUserProvider.class);
        notificationService = new NotificationService(notificationRepository, currentUserProvider);
    }

    /**
     * 批量已读应仅使用当前用户ID。
     */
    @Test
    void shouldMarkAllPublishedNotificationsReadForCurrentUser() {
        when(currentUserProvider.currentUserId()).thenReturn(Mono.just(8L));
        when(notificationRepository.markAllAsRead(8L)).thenReturn(Mono.empty());

        StepVerifier.create(notificationService.markAllAsRead()).verifyComplete();

        verify(notificationRepository).markAllAsRead(8L);
    }

    @Test
    void deletesExistingNotification() {
        when(notificationRepository.deleteNotification(12L)).thenReturn(Mono.just(1L));
        StepVerifier.create(notificationService.deleteNotification(12L)).verifyComplete();
    }

    @Test
    void missingNotificationDoesNotReportSuccess() {
        when(notificationRepository.deleteNotification(12L)).thenReturn(Mono.just(0L));
        StepVerifier.create(notificationService.deleteNotification(12L))
                .expectErrorMatches(error -> error instanceof BusinessException && error.getMessage().contains("已删除"))
                .verify();
    }

    @Test
    void databaseFailureIsNotReportedAsSuccessfulDeletion() {
        when(notificationRepository.deleteNotification(12L)).thenReturn(Mono.error(new IllegalStateException("database unavailable")));
        StepVerifier.create(notificationService.deleteNotification(12L)).expectError(IllegalStateException.class).verify();
    }
}
