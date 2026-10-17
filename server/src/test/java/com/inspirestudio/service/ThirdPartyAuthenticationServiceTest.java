package com.inspirestudio.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.inspirestudio.entity.User;
import com.inspirestudio.entity.UserIdentityBinding;
import com.inspirestudio.repository.OAuth2IdentityRepository;
import com.inspirestudio.repository.UserRepository;
import com.inspirestudio.security.oauth2.ThirdPartyOAuth2Provider;
import com.inspirestudio.security.oauth2.ThirdPartyOAuth2ProviderRegistry;
import com.inspirestudio.security.oauth2.ThirdPartyUserIdentity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

/**
 * 第三方认证账号服务测试
 *
 * @date     2026-07-15 00:00
 */
class ThirdPartyAuthenticationServiceTest {

    /**
     * 验证已有绑定始终使用原本本地用户。
     */
    @Test
    @DisplayName("已有第三方绑定时使用绑定用户并刷新资料快照")
    void shouldUseExistingBinding() {
        TestContext context = testContext();
        UserIdentityBinding binding = new UserIdentityBinding();
        binding.setId(6L);
        binding.setUserId(8L);
        User user = normalUser(8L);
        when(context.identityRepository.findBinding("linuxDo", "12345")).thenReturn(Mono.just(binding));
        when(context.identityRepository.updateBindingProfile(6L, context.identity)).thenReturn(Mono.empty());
        when(context.userRepository.findById(8L)).thenReturn(Mono.just(user));

        StepVerifier.create(context.service.authenticate("linuxDo", context.oidcUser)).expectNext(user).verifyComplete();

        verify(context.identityRepository).updateBindingProfile(6L, context.identity);
        org.mockito.Mockito.verifyNoInteractions(context.registrationEmailPolicyService);
    }

    /**
     * 验证新身份按可信邮箱创建用户并建立绑定。
     */
    @Test
    @DisplayName("新第三方身份按可信邮箱创建并绑定本地用户")
    void shouldCreateAndBindUserByTrustedEmail() {
        TestContext context = testContext();
        User user = normalUser(8L);
        when(context.identityRepository.findBinding("linuxDo", "12345")).thenReturn(Mono.empty());
        when(context.identityRepository.resolveUserByTrustedEmail(eq(context.identity), anyString(), isNull())).thenReturn(Mono.just(new OAuth2IdentityRepository.ResolvedOAuthUser(user, true)));
        when(context.identityRepository.upsertBinding(8L, context.identity)).thenReturn(Mono.just(8L));
        when(context.creditService.initializeAccount(8L)).thenReturn(Mono.empty());
        when(context.transactionalOperator.transactional(any(Mono.class))).thenAnswer(invocation -> invocation.getArgument(0));

        StepVerifier.create(context.service.authenticate("linuxDo", context.oidcUser)).expectNext(user).verifyComplete();

        verify(context.identityRepository).upsertBinding(8L, context.identity);
    }

    /**
     * 验证邀请奖励只在第三方首次创建本地用户时发放。
     */
    @Test
    @DisplayName("第三方首次创建本地用户时向邀请人发放奖励")
    void shouldGrantInvitationRewardOnlyForCreatedUser() {
        TestContext context = testContext();
        User user = normalUser(8L);
        when(context.identityRepository.findBinding("linuxDo", "12345")).thenReturn(Mono.empty());
        when(context.identityRepository.resolveUserByTrustedEmail(eq(context.identity), anyString(), eq(5L)))
                .thenReturn(Mono.just(new OAuth2IdentityRepository.ResolvedOAuthUser(user, true)));
        when(context.identityRepository.upsertBinding(8L, context.identity)).thenReturn(Mono.just(8L));
        when(context.creditService.initializeAccount(8L)).thenReturn(Mono.empty());
        when(context.creditService.grantInvitationReward(5L, 8L)).thenReturn(Mono.empty());
        when(context.transactionalOperator.transactional(any(Mono.class))).thenAnswer(invocation -> invocation.getArgument(0));

        StepVerifier.create(context.service.authenticate("linuxDo", context.oidcUser, 5L)).expectNext(user).verifyComplete();

        verify(context.creditService).grantInvitationReward(5L, 8L);
    }

    /**
     * 可信邮箱已经存在时只绑定第三方身份，不记录邀请关系或发放奖励。
     */
    @Test
    @DisplayName("已有本地账号首次绑定第三方身份时不发邀请奖励")
    void shouldNotGrantInvitationRewardForExistingEmail() {
        TestContext context = testContext();
        User user = normalUser(8L);
        when(context.userRepository.findByEmail(context.identity.email())).thenReturn(Mono.just(user));
        when(context.identityRepository.findBinding("linuxDo", "12345")).thenReturn(Mono.empty());
        when(context.identityRepository.resolveUserByTrustedEmail(eq(context.identity), anyString(), eq(5L)))
                .thenReturn(Mono.just(new OAuth2IdentityRepository.ResolvedOAuthUser(user, false)));
        when(context.identityRepository.upsertBinding(8L, context.identity)).thenReturn(Mono.just(8L));
        when(context.transactionalOperator.transactional(any(Mono.class))).thenAnswer(invocation -> invocation.getArgument(0));

        StepVerifier.create(context.service.authenticate("linuxDo", context.oidcUser, 5L)).expectNext(user).verifyComplete();

        verify(context.creditService, never()).initializeAccount(8L);
        verify(context.creditService, never()).grantInvitationReward(5L, 8L);
        org.mockito.Mockito.verifyNoInteractions(context.registrationEmailPolicyService);
    }

    /**
     * 创建测试依赖上下文。
     *
     * @return TestContext 测试依赖上下文
     */
    private TestContext testContext() {
        ThirdPartyOAuth2ProviderRegistry registry = mock(ThirdPartyOAuth2ProviderRegistry.class);
        ThirdPartyOAuth2Provider provider = mock(ThirdPartyOAuth2Provider.class);
        OAuth2IdentityRepository identityRepository = mock(OAuth2IdentityRepository.class);
        UserRepository userRepository = mock(UserRepository.class);
        CreditService creditService = mock(CreditService.class);
        InvitationService invitationService = mock(InvitationService.class);
        TransactionalOperator transactionalOperator = mock(TransactionalOperator.class);
        OidcUser oidcUser = mock(OidcUser.class);
        ThirdPartyUserIdentity identity = new ThirdPartyUserIdentity("linuxDo", "12345", "user@example.com", "tester", "");
        when(registry.requireEnabled("linuxDo")).thenReturn(provider);
        when(provider.resolveIdentity(oidcUser)).thenReturn(identity);
        when(invitationService.generateInvitationCode()).thenReturn("INVITATIONCODE01");
        RegistrationEmailPolicyService registrationEmailPolicyService = mock(RegistrationEmailPolicyService.class);
        when(registrationEmailPolicyService.validateRegistration(any())).thenReturn(Mono.empty());
        when(userRepository.findByEmail(identity.email())).thenReturn(Mono.empty());
        ThirdPartyAuthenticationService service = new ThirdPartyAuthenticationService(registry, identityRepository, userRepository, creditService, invitationService, transactionalOperator, registrationEmailPolicyService);
        return new TestContext(service, identityRepository, userRepository, creditService, transactionalOperator, oidcUser, identity, registrationEmailPolicyService);
    }

    @Test
    void shouldRejectNewOAuthAccountBeforeWritingUser() {
        TestContext context = testContext();
        when(context.identityRepository.findBinding("linuxDo", "12345")).thenReturn(Mono.empty());
        when(context.registrationEmailPolicyService.validateRegistration(context.identity.email()))
                .thenReturn(Mono.error(new com.inspirestudio.common.BusinessException(
                        com.inspirestudio.common.ErrorCode.PARAM_INVALID, "邮箱未开放")));
        when(context.transactionalOperator.transactional(any(Mono.class))).thenAnswer(invocation -> invocation.getArgument(0));
        StepVerifier.create(context.service.authenticate("linuxDo", context.oidcUser))
                .expectErrorMatches(error -> error instanceof com.inspirestudio.security.oauth2.OAuth2LoginException oauth
                        && "registrationEmailNotAllowed".equals(oauth.getErrorCode()))
                .verify();
        verify(context.identityRepository, never()).resolveUserByTrustedEmail(any(), anyString(), any());
        org.mockito.Mockito.verifyNoInteractions(context.creditService);
    }

    /**
     * 创建正常状态用户。
     *
     * @param userId Long 用户ID
     * @return User 正常状态用户
     */
    private User normalUser(Long userId) {
        User user = new User();
        user.setId(userId);
        user.setStatus(UserService.STATUS_NORMAL);
        return user;
    }

    /**
     * 第三方认证服务测试上下文。
     *
     * @param service 第三方认证服务
     * @param identityRepository 第三方身份仓储
     * @param userRepository 用户仓储
     * @param transactionalOperator 响应式事务操作器
     * @param oidcUser OpenID Connect用户
     * @param identity 标准化第三方身份
     */
    private record TestContext(ThirdPartyAuthenticationService service,
                               OAuth2IdentityRepository identityRepository,
                               UserRepository userRepository,
                               CreditService creditService,
                               TransactionalOperator transactionalOperator,
                               OidcUser oidcUser,
                               ThirdPartyUserIdentity identity,
                               RegistrationEmailPolicyService registrationEmailPolicyService) {
    }
}
