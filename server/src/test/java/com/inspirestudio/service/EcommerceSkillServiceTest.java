package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.EcommerceSkillDtos;
import com.inspirestudio.repository.EcommerceSkillRepository;
import com.inspirestudio.security.*;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

class EcommerceSkillServiceTest {
    EcommerceSkillRepository repository;
    EcommerceSkillService service;
    CurrentUserProvider users;
    @BeforeEach void setup() {
        repository = mock(EcommerceSkillRepository.class);
        users = mock(CurrentUserProvider.class);
        when(users.currentUserId()).thenReturn(Mono.just(7L));
        when(users.currentUser()).thenReturn(Mono.just(new CurrentUser(7L, "admin@example.test", "admin", 1)));
        service = new EcommerceSkillService(repository, users, new AdminGuard(users));
    }
    @Test void userCatalogRequiresLoginAndOnlyQueriesEnabledMatchingScopes() {
        when(repository.listEnabled("taobao", "copy", "标题")).thenReturn(Flux.just(skill(1, 3, List.of("taobao"), List.of("copy"))));
        assertEquals(1, service.listUser("taobao", "copy", " 标题 ").block().skills().size());
        var unauthenticated = new EcommerceSkillService(repository, new CurrentUserProvider(), new AdminGuard(new CurrentUserProvider()));
        assertThrows(BusinessException.class, () -> unauthenticated.listUser(null, null, null).block());
        verify(repository, times(1)).listEnabled(anyString(), anyString(), anyString());
    }
    @Test void normalUserCannotReadOrMutateAdminCatalog() {
        when(users.currentUser()).thenReturn(Mono.just(new CurrentUser(8L, "user@example.test", "user", 1)));
        assertThrows(BusinessException.class, () -> service.listAdmin(new EcommerceSkillDtos.ListRequest(null, null, null, 1, 20)).block());
        assertThrows(BusinessException.class, () -> service.save(save("text", List.of("taobao"), List.of("copy"), "正文")).block());
        assertThrows(BusinessException.class, () -> service.setStatus(new EcommerceSkillDtos.StatusRequest("skill", 1, 0)).block());
        assertThrows(BusinessException.class, () -> service.delete(new EcommerceSkillDtos.DeleteRequest("skill", 1)).block());
        verifyNoInteractions(repository);
    }
    @Test void validationRejectsEmptyInvalidAndMismatchedScopesOrPrompts() {
        for (var invalid : List.of(save("text", List.of(), List.of("copy"), "正文"), save("text", List.of("taobao"), List.of(), "正文"),
                save("text", List.of("unknown"), List.of("copy"), "正文"), save("text", List.of("taobao"), List.of("hero"), "正文"),
                save("video", List.of("taobao"), List.of("video"), " "), save("video", List.of("taobao"), List.of("video"), "长".repeat(12001)))) {
            assertThrows(BusinessException.class, () -> service.save(invalid).block());
        }
        verifyNoInteractions(repository);
    }
    @Test void defaultSkillIsChosenFromOrderedCompatibleEnabledCatalog() {
        var expected = skill(1, 3, List.of("taobao"), List.of("copy"));
        when(repository.listEnabled("taobao", "copy", "")).thenReturn(Flux.just(expected));
        assertEquals(expected, service.resolveForGeneration(null, null, "taobao", "copy", "").block());
        when(repository.listEnabled("taobao", "copy", "")).thenReturn(Flux.empty());
        assertTrue(assertThrows(BusinessException.class, () -> service.resolveForGeneration(null, null, "taobao", "copy", "").block()).getMessage().contains("没有可用技能"));
    }
    @Test void explicitSelectionCannotFallBackWhenDisabledWrongScopeOrStale() {
        for (var unavailable : List.of(skill(0, 3, List.of("taobao"), List.of("copy")), skill(1, 3, List.of("jd"), List.of("copy")),
                skill(1, 3, List.of("taobao"), List.of("detail-copy")), skill(1, 4, List.of("taobao"), List.of("copy")))) {
            when(repository.get("skill")).thenReturn(Mono.just(unavailable));
            assertThrows(BusinessException.class, () -> service.resolveForGeneration("skill", 3, "taobao", "copy", "").block());
        }
        verify(repository, never()).listEnabled(anyString(), anyString(), anyString());
    }
    @Test void changedBodyAndRevisionAreReturnedWithoutClientOverrides() {
        var selected = skill(1, 3, List.of("taobao"), List.of("copy"));
        when(repository.get("skill")).thenReturn(Mono.just(selected));
        assertEquals("服务器保存的完整正文", service.resolveForGeneration("skill", 3, "taobao", "copy", "").block().systemPrompt());
        when(repository.listAdmin("", "", null, 1, 100)).thenReturn(Mono.just(new EcommerceSkillDtos.SkillPage(List.of(), 0)));
        service.listAdmin(new EcommerceSkillDtos.ListRequest(null, "all", null, 0, 1000)).block();
        verify(repository).listAdmin("", "", null, 1, 100);
    }
    static EcommerceSkillDtos.Skill skill(int status, int revision, List<String> platforms, List<String> outputs) {
        return new EcommerceSkillDtos.Skill("skill", revision, "商品文案", "说明", "text", platforms, outputs, "服务器保存的完整正文", status, 0, "now", "now");
    }
    private static EcommerceSkillDtos.SaveRequest save(String type, List<String> platforms, List<String> outputs, String prompt) {
        return new EcommerceSkillDtos.SaveRequest(null, null, "商品文案", "说明", type, platforms, outputs, prompt, 1, 0);
    }
}
