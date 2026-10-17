package com.inspirestudio.controller;

import static org.mockito.Mockito.*;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.UserDtos;
import com.inspirestudio.security.AdminGuard;
import com.inspirestudio.service.UserService;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class AdminUserDeletionTest {
    @Test void deniedRequestDoesNotReachUserService() {
        var guard = mock(AdminGuard.class);
        var service = mock(UserService.class);
        when(guard.requireAdmin()).thenReturn(Mono.error(new BusinessException(ErrorCode.PERMISSION_DENIED, "权限不足")));
        var controller = new AdminUserController(service, guard);
        StepVerifier.create(controller.deleteUser(new UserDtos.DeleteUserRequest(2L))).expectError(BusinessException.class).verify();
        verifyNoInteractions(service);
    }
}
