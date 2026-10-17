package com.inspirestudio.security;

import com.inspirestudio.common.GlobalExceptionHandler;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class AuthenticationRateLimitServiceTest {
    @Test void blockedRequestDoesNotInvokeMailAndReturnsRetryAfter() {
        var redis = mock(ReactiveStringRedisTemplate.class);
        var resolver = mock(ClientAddressResolver.class);
        var request = MockServerHttpRequest.post("/api/v1/auth/sendEmailCode").build();
        when(resolver.resolve(request)).thenReturn("203.0.113.1");
        when(redis.execute(eq(AuthenticationRateLimitService.EMAIL_CODE_SCRIPT), anyList(), anyList())).thenReturn(Flux.just(-42L));
        var service = new AuthenticationRateLimitService(redis, resolver);
        StepVerifier.create(service.sendEmailCode(request, "user@example.com", () -> { fail("Mail must not be sent"); return Mono.empty(); }))
                .expectErrorSatisfies(error -> {
                    var response = new GlobalExceptionHandler().handleRateLimit((AuthenticationRateLimitException) error);
                    assertEquals(429, response.getStatusCode().value());
                    assertEquals("42", response.getHeaders().getFirst("Retry-After"));
                }).verify();
        verify(redis, never()).execute(eq(AuthenticationRateLimitService.RELEASE_EMAIL_CODE_SCRIPT), anyList(), anyList());
    }

    @Test void failedMailReleasesOnlyItsReservationAndKeepsOriginalError() {
        var redis = mock(ReactiveStringRedisTemplate.class);
        var resolver = mock(ClientAddressResolver.class);
        var request = MockServerHttpRequest.post("/api").build();
        when(resolver.resolve(request)).thenReturn("203.0.113.1");
        when(redis.execute(eq(AuthenticationRateLimitService.EMAIL_CODE_SCRIPT), anyList(), anyList())).thenReturn(Flux.just(1L));
        when(redis.execute(eq(AuthenticationRateLimitService.RELEASE_EMAIL_CODE_SCRIPT), anyList(), anyList())).thenReturn(Flux.just(1L));
        StepVerifier.create(new AuthenticationRateLimitService(redis, resolver).sendEmailCode(request, "USER@example.com", () -> Mono.error(new IllegalStateException("SMTP unavailable"))))
                .expectErrorMessage("SMTP unavailable").verify();
        verify(redis).execute(eq(AuthenticationRateLimitService.RELEASE_EMAIL_CODE_SCRIPT), anyList(), anyList());
    }
}
