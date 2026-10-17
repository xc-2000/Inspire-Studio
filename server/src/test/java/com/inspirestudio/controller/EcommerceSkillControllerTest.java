package com.inspirestudio.controller;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.inspirestudio.common.GlobalExceptionHandler;
import com.inspirestudio.dto.EcommerceSkillDtos;
import com.inspirestudio.repository.EcommerceSkillRepository;
import com.inspirestudio.security.*;
import com.inspirestudio.service.EcommerceSkillService;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

class EcommerceSkillControllerTest {
    private WebTestClient client(EcommerceSkillRepository repository, CurrentUserProvider users) {
        return WebTestClient.bindToController(new EcommerceSkillController(new EcommerceSkillService(repository, users, new AdminGuard(users))))
                .controllerAdvice(new GlobalExceptionHandler()).build();
    }
    @Test void loginAndAdminGatesProtectCatalogAndEveryMutation() {
        var repository = mock(EcommerceSkillRepository.class);
        client(repository, new CurrentUserProvider()).get().uri("/api/v1/ecommerce/skills?platform=taobao&outputType=copy")
                .exchange().expectStatus().isUnauthorized();
        var users = mock(CurrentUserProvider.class);
        when(users.currentUser()).thenReturn(Mono.just(new CurrentUser(9L, "user@example.test", "user", 1)));
        for (String operation : List.of("list", "save", "status", "delete")) {
            client(repository, users).post().uri("/api/v1/admin/ecommerce-skills/" + operation)
                    .contentType(MediaType.APPLICATION_JSON).bodyValue("{}").exchange().expectStatus().isForbidden();
        }
        verifyNoInteractions(repository);
    }
    @Test void compatibleSkillListContainsSelectableMetadataAndCompleteInstructions() {
        var repository = mock(EcommerceSkillRepository.class);
        var users = mock(CurrentUserProvider.class);
        when(users.currentUserId()).thenReturn(Mono.just(7L));
        when(repository.listEnabled("douyin", "video", "商品")).thenReturn(Flux.just(new EcommerceSkillDtos.Skill("video-skill", 4, "商品展示", "说明", "video",
                List.of("douyin"), List.of("video"), "完整视频正文", 1, 1, "now", "now")));
        client(repository, users).get().uri(uri -> uri.path("/api/v1/ecommerce/skills").queryParam("platform", "douyin").queryParam("outputType", "video").queryParam("keyword", "商品").build())
                .exchange().expectStatus().isOk().expectBody().jsonPath("$.data.skills[0].revision").isEqualTo(4)
                .jsonPath("$.data.skills[0].systemPrompt").isEqualTo("完整视频正文");
    }
}
