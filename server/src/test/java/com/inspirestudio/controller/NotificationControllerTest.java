package com.inspirestudio.controller;

import static org.mockito.Mockito.*;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.NotificationDtos;
import com.inspirestudio.security.AdminGuard;
import com.inspirestudio.service.NotificationService;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class NotificationControllerTest {
    @Test
    void nonAdminCannotStartDeletion() {
        var service = mock(NotificationService.class);
        var guard = mock(AdminGuard.class);
        when(guard.requireAdmin()).thenReturn(Mono.error(new BusinessException(ErrorCode.PERMISSION_DENIED, "权限不足")));
        var controller = new NotificationController(service, guard);
        StepVerifier.create(controller.deleteNotification(new NotificationDtos.DeleteNotificationRequest(12L)))
                .expectError(BusinessException.class).verify();
        verifyNoInteractions(service);
    }

    @Test
    void adminCanDelete() {
        var service = mock(NotificationService.class);
        var guard = mock(AdminGuard.class);
        when(guard.requireAdmin()).thenReturn(Mono.empty());
        when(service.deleteNotification(12L)).thenReturn(Mono.empty());
        var controller = new NotificationController(service, guard);
        StepVerifier.create(controller.deleteNotification(new NotificationDtos.DeleteNotificationRequest(12L)))
                .expectNextCount(1).verifyComplete();
        verify(service).deleteNotification(12L);
    }
}
