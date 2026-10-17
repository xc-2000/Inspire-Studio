package com.inspirestudio.service;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.RegistrationEmailDtos.Settings;
import com.inspirestudio.repository.RegistrationEmailRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RegistrationEmailPolicyServiceTest {
    private final RegistrationEmailRepository repository = mock(RegistrationEmailRepository.class);
    private final RegistrationEmailPolicyService service = new RegistrationEmailPolicyService(repository);

    @Test
    void exactDomainIsCaseInsensitiveAndNormalizesWhitespace() {
        when(repository.get()).thenReturn(Mono.just(new Settings(true, List.of("qq.com"), 1)));
        StepVerifier.create(service.validateRegistration(" User+tag@QQ.COM ")).verifyComplete();
    }

    @ParameterizedTest
    @ValueSource(strings = {"u@evilqq.com", "u@qq.com.evil", "u@vip.qq.com", "u@qq.com.", "u@@qq.com",
            "u @qq.com", ".u@qq.com", "u..s@qq.com", "u.@qq.com", "u@-qq.com", "u@qq..com", "u@qq_com"})
    void refusesUnopenedDomainsAndMalformedEmails(String email) {
        when(repository.get()).thenReturn(Mono.just(new Settings(true, List.of("qq.com"), 0)));
        StepVerifier.create(service.validateRegistration(email)).expectError(BusinessException.class).verify();
    }

    @Test
    void missingSettingsFailClosed() {
        when(repository.get()).thenReturn(Mono.empty());
        StepVerifier.create(service.validateRegistration("u@qq.com")).expectErrorMessage("注册设置暂不可用，请稍后重试").verify();
    }

    @Test
    void emptySelectionClosesRegistration() {
        when(repository.get()).thenReturn(Mono.just(new Settings(true, List.of(), 0)));
        StepVerifier.create(service.validateRegistration("u@qq.com")).expectErrorMessage("暂未开放邮箱注册，请联系管理员").verify();
    }

    @Test
    void disabledRestrictionAllowsValidDomainsButStillValidatesSyntax() {
        when(repository.get()).thenReturn(Mono.just(new Settings(false, List.of("qq.com"), 2)));
        StepVerifier.create(service.validateRegistration("person@company.co.uk")).verifyComplete();
        StepVerifier.create(service.validateRegistration("a..b@company.co.uk")).expectError(BusinessException.class).verify();
        StepVerifier.create(service.validateRegistration("a".repeat(65) + "@qq.com")).expectError(BusinessException.class).verify();
    }

    @Test
    void savesNormalizedDeduplicatedDomains() {
        Settings normalized = new Settings(true, List.of("qq.com", "163.com"), 4);
        when(repository.save(normalized)).thenReturn(Mono.just(true));
        when(repository.get()).thenReturn(Mono.just(new Settings(true, normalized.allowedDomains(), 5)));
        StepVerifier.create(service.save(new Settings(true, List.of(" QQ.COM ", "@163.com", "qq.com"), 4)))
                .assertNext(saved -> assertEquals(5, saved.version())).verifyComplete();
        verify(repository).save(normalized);
    }

    @ParameterizedTest
    @ValueSource(strings = {"*", "*.qq.com", "https://qq.com", "u@qq.com", "qq.com/path", "qq.com.", "", "qq..com", "-qq.com"})
    void rejectsInvalidSettings(String domain) {
        StepVerifier.create(service.save(new Settings(true, List.of(domain), 0)))
                .expectError(BusinessException.class).verify();
        verifyNoInteractions(repository);
    }

    @Test
    void rejectsConflictingAdminWrites() {
        Settings settings = new Settings(true, List.of(), 1);
        when(repository.save(settings)).thenReturn(Mono.just(false));
        StepVerifier.create(service.save(settings)).expectErrorMessage("注册设置已被其他管理员修改，请刷新后重试").verify();
        verify(repository, never()).get();
    }

    @Test
    void readsCurrentPolicyForEveryAttempt() {
        when(repository.get()).thenReturn(Mono.just(new Settings(true, List.of("qq.com"), 1)),
                Mono.just(new Settings(true, List.of("163.com"), 2)));
        StepVerifier.create(service.validateRegistration("u@qq.com")).verifyComplete();
        StepVerifier.create(service.validateRegistration("u@qq.com")).expectError(BusinessException.class).verify();
    }
}
