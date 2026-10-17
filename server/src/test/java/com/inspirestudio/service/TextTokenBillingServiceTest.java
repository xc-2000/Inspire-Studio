package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.ai.TextTokenUsage;
import com.inspirestudio.security.CurrentUserProvider;
import io.agentscope.core.model.*;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class TextTokenBillingServiceTest {
    private TextTokenBillingService.Price price(String input, String output, String multiplier, String currency, String fx) {
        return new TextTokenBillingService.Price("model", "official", new BigDecimal(input), new BigDecimal(output), new BigDecimal(multiplier), currency, new BigDecimal(fx), 1);
    }
    @Test void combinesInputAndOutputBeforeRoundingAndConvertsYuan() {
        var p = price("9", "27", "1", "CNY", "1");
        assertEquals(1, TextTokenBillingService.calculate(p, 100, 100));
        assertEquals(2, TextTokenBillingService.calculate(p, 1000, 100));
        assertEquals(3637, TextTokenBillingService.calculate(p, 1_000_000, 1_000_000));
        assertEquals(0, TextTokenBillingService.calculate(p, 0, 0));
    }
    @Test void supportsIndependentMultiplierAndExplicitDollarRate() {
        assertEquals(8485, TextTokenBillingService.calculate(price("2", "10", "1", "USD", "7"), 1_000_000, 1_000_000));
        assertEquals(16970, TextTokenBillingService.calculate(price("2", "10", "2", "USD", "7"), 1_000_000, 1_000_000));
        assertEquals(0, TextTokenBillingService.calculate(price("2", "10", "0", "USD", "7"), 1_000_000, 1_000_000));
    }
    @Test void rejectsInvalidAndOverflowingUsage() {
        assertThrows(RuntimeException.class, () -> TextTokenBillingService.calculate(price("9","27","1","CNY","1"), -1, 10));
        assertThrows(RuntimeException.class, () -> TextTokenBillingService.calculate(price("9","27","1","CNY","1"), Long.MAX_VALUE, Long.MAX_VALUE));
        assertThrows(RuntimeException.class, () -> TextTokenBillingService.validatePrice(new BigDecimal("-1")));
    }
    @Test void catalogContainsUniqueVerifiedPricesAndAllConfiguredBaselines() {
        var rates = TextTokenBillingService.officialRates();
        assertTrue(rates.size() >= 80);
        assertEquals(rates.size(), rates.stream().map(TextTokenBillingService.OfficialRate::id).distinct().count());
        for(var r : rates) {
            assertTrue(r.sourceUrl().startsWith("https://")); assertEquals("2026-09-19",r.checkedAt());
            assertTrue(r.inputPrice().signum()>=0 && r.outputPrice().signum()>=0);
            assertTrue(List.of("USD","CNY").contains(r.currency()));
        }
        assertEquals(new BigDecimal("20"), rates.stream().filter(r -> r.id().equals("kimi-k3")).findFirst().orElseThrow().inputPrice());
    }
    @Test void normalizesUsageWithoutCountingReasoningTwice() {
        var openai = TextTokenUsage.openAi(JSON.parseObject("{\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":80,\"completion_tokens_details\":{\"reasoning_tokens\":50}}}"));
        assertEquals(80,openai.getLongValue("outputTokens"));
        var gemini = TextTokenUsage.gemini(JSON.parseObject("{\"usageMetadata\":{\"promptTokenCount\":100,\"candidatesTokenCount\":30,\"thoughtsTokenCount\":50}}"));
        assertEquals(80,gemini.getLongValue("outputTokens"));
        var claude = TextTokenUsage.anthropic(JSON.parseObject("{\"input_tokens\":20,\"output_tokens\":30,\"cache_read_input_tokens\":100,\"cache_creation_input_tokens\":50}"));
        assertEquals(170,claude.getLongValue("inputTokens"));
        assertEquals(-1, TextTokenUsage.openAi(JSON.parseObject("{}")).getLongValue("inputTokens"));
    }
    private TextTokenBillingService service() {
        return spy(new TextTokenBillingService(mock(DatabaseClient.class),mock(CreditService.class),mock(CurrentUserProvider.class),mock(TransactionalOperator.class)));
    }
    @Test void streamSettlesCumulativeUsageOncePerCallAndKeepsCallsIndependent() {
        var service = service(); var free = price("0","0","1","CNY","1");
        doReturn(Mono.just(free)).when(service).price("model");
        doReturn(Mono.just(3)).when(service).settle(eq(1L),anyString(),eq(free),eq(100L),eq(30L));
        Model delegate = mock(Model.class);
        when(delegate.stream(anyList(),anyList(),any())).thenReturn(Flux.just(
                new ChatResponse("a",List.of(),new ChatUsage(100,5,0),null,null),
                new ChatResponse("a",List.of(),new ChatUsage(100,30,0),null,"stop")));
        var wrapped = service.wrap(delegate,"model",1L);
        StepVerifier.create(wrapped.stream(List.of(),List.of(),GenerateOptions.builder().build())).expectNextCount(2).verifyComplete();
        StepVerifier.create(wrapped.stream(List.of(),List.of(),GenerateOptions.builder().build())).expectNextCount(2).verifyComplete();
        var ids = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(service,times(2)).settle(eq(1L),ids.capture(),eq(free),eq(100L),eq(30L));
        assertNotEquals(ids.getAllValues().get(0),ids.getAllValues().get(1));
        assertEquals(6,TextTokenBillingService.chargedCredits(wrapped));
    }
    @Test void failedOrCancelledStreamDoesNotInventUsage() {
        var service = service(); var free = price("0","0","1","CNY","1");
        doReturn(Mono.just(free)).when(service).price("model");
        var delegate = mock(Model.class);
        when(delegate.stream(anyList(),anyList(),any())).thenReturn(Flux.error(new IllegalStateException("upstream failed")), Flux.never());
        var wrapped = service.wrap(delegate,"model",1L);
        StepVerifier.create(wrapped.stream(List.of(),List.of(),GenerateOptions.builder().build())).expectError(IllegalStateException.class).verify();
        StepVerifier.create(wrapped.stream(List.of(),List.of(),GenerateOptions.builder().build())).thenCancel().verify();
        verify(service,never()).settle(anyLong(),anyString(),any(),anyLong(),anyLong());
    }
    @Test void missingUsageOnPaidModelFailsExplicitly() {
        StepVerifier.create(service().settle(1L,"call",price("9","27","1","CNY","1"),-1,-1)).expectErrorMatches(e -> e.getMessage().contains("Token")).verify();
    }
}
