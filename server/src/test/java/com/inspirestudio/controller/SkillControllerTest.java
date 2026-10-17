package com.inspirestudio.controller;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.common.GlobalExceptionHandler;
import com.inspirestudio.dto.SkillDtos;
import com.inspirestudio.security.AdminGuard;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.service.SkillService;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Mono;

class SkillControllerTest {
    private static WebTestClient client(SkillController controller) {
        return WebTestClient.bindToController(controller).controllerAdvice(new GlobalExceptionHandler())
                .configureClient().codecs(codecs -> codecs.defaultCodecs().maxInMemorySize(2 * 1024 * 1024)).build();
    }

    @Test void detailRequiresLoginBeforeReadingPrompt() {
        var service = mock(SkillService.class);
        var admin = mock(AdminGuard.class);
        client(new SkillController(service, admin, new CurrentUserProvider()))
                .get().uri("/api/v1/skill/getSkill?id=7").exchange().expectStatus().isUnauthorized();
        verifyNoInteractions(service, admin);
    }

    @Test void ordinaryUserCanReadFullPromptWithoutAdminPermission() {
        var service = mock(SkillService.class);
        var admin = mock(AdminGuard.class);
        var users = mock(CurrentUserProvider.class);
        when(users.currentUserId()).thenReturn(Mono.just(19L));
        String full = "完整技能与内嵌参考资料。".repeat(40000) + "末尾不可省略";
        when(service.getUserSkill(7L, "image")).thenReturn(Mono.just(new SkillDtos.SkillDetail(7L, "skill", "summary", "image", "", null, full, "16:9")));
        client(new SkillController(service, admin, users)).get().uri("/api/v1/skill/getSkill?id=7&targetType=image")
                .exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.data.systemPrompt").isEqualTo(full).jsonPath("$.data.targetType").isEqualTo("image")
                .jsonPath("$.data.status").doesNotExist().jsonPath("$.data.deletedAt").doesNotExist();
        verifyNoInteractions(admin);
        verify(service).getUserSkill(7L, "image");
    }

    @Test void unavailableDetailReturnsNotFoundAndInvalidIdReturnsBadRequest() {
        var service = mock(SkillService.class);
        var users = mock(CurrentUserProvider.class);
        when(users.currentUserId()).thenReturn(Mono.just(19L));
        when(service.getUserSkill(7L, null)).thenReturn(Mono.error(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND, "技能不存在或已停用")));
        var client = client(new SkillController(service, mock(AdminGuard.class), users));
        client.get().uri("/api/v1/skill/getSkill?id=7").exchange().expectStatus().isNotFound();
        client.get().uri("/api/v1/skill/getSkill?id=invalid").exchange().expectStatus().isBadRequest();
        client.get().uri("/api/v1/skill/getSkill").exchange().expectStatus().isBadRequest();
    }

    @Test void detailEndpointDoesNotOpenAdminCatalog() {
        var service = mock(SkillService.class);
        var users = mock(CurrentUserProvider.class);
        var admin = mock(AdminGuard.class);
        when(users.currentUserId()).thenReturn(Mono.just(19L));
        when(admin.requireAdmin()).thenReturn(Mono.error(new BusinessException(ErrorCode.PERMISSION_DENIED, "需要管理员权限")));
        when(service.listAdminSkills(any())).thenReturn(Mono.just(new SkillDtos.SkillListResponse(List.of(), 0)));
        client(new SkillController(service, admin, users)).get().uri("/api/v1/admin/skill/listSkills")
                .exchange().expectStatus().isForbidden();
        verify(admin).requireAdmin();
    }
}
