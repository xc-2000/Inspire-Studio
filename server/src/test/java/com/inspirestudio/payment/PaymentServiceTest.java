package com.inspirestudio.payment;

import com.inspirestudio.repository.CreditRepository;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.task.AiTaskEventPublisher;
import com.wechat.pay.java.service.payments.model.Transaction;
import com.wechat.pay.java.service.payments.model.TransactionAmount;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;

class PaymentServiceTest {
    final PaymentRepository orders=mock(PaymentRepository.class);
    final CreditRepository credits=mock(CreditRepository.class);
    final WechatGateway gateway=mock(WechatGateway.class);
    final CurrentUserProvider users=mock(CurrentUserProvider.class);
    final AiTaskEventPublisher events=mock(AiTaskEventPublisher.class);
    final TransactionalOperator tx=mock(TransactionalOperator.class);
    final WechatPayProperties properties=new WechatPayProperties();
    final PaymentPackageService packages=mock(PaymentPackageService.class);
    PaymentService service;
    final OffsetDateTime now=OffsetDateTime.now();
    PaymentRepository.Order order(String status,String transactionId) {
        return new PaymentRepository.Order("WXtest",1L,"basic","积分",100,20,status,"weixin://wxpay/test",transactionId,now.plusMinutes(1),null,now);
    }
    PaymentRepository.Order expiredOrder() {
        var o=order("PENDING",null);
        return new PaymentRepository.Order(o.orderNo(),o.userId(),o.packageId(),o.description(),o.amountFen(),o.credits(),
                o.status(),o.codeUrl(),null,now.minusSeconds(1),null,now.minusSeconds(61));
    }
    void queryReturns(Transaction.TradeStateEnum state) {
        when(orders.claimCheck("WXtest")).thenReturn(Mono.just(true));
        var t=transaction();t.setTradeState(state);
        when(gateway.query("WXtest")).thenReturn(Mono.just(t));
    }
    Transaction transaction() {
        var t=new Transaction(); t.setAppid("app");t.setMchid("merchant");t.setOutTradeNo("WXtest");t.setTransactionId("wx-tx");
        t.setTradeState(Transaction.TradeStateEnum.SUCCESS);t.setSuccessTime(now.toString());
        var amount=new TransactionAmount();amount.setTotal(100);amount.setCurrency("CNY");t.setAmount(amount);return t;
    }
    @BeforeEach void setup() {
        properties.setAppId("app");properties.setMerchantId("merchant");
        when(tx.transactional(any(Mono.class))).thenAnswer(i->i.getArgument(0));
        when(orders.collectionEnabled(anyBoolean())).thenReturn(Mono.just(true));
        when(packages.active()).thenReturn(Mono.just(java.util.List.of()));
        service=new PaymentService(properties,gateway,orders,credits,users,tx,events,packages);
    }
    @Test void wrongAmountCannotCredit() {
        var t=transaction();t.getAmount().setTotal(1);
        when(orders.find("WXtest",true)).thenReturn(Mono.just(order("PENDING",null)));
        StepVerifier.create(service.settle(t)).expectError(IllegalArgumentException.class).verify();verifyNoInteractions(credits);
    }
    @Test void wrongMerchantAndCurrencyRejected() {
        var t=transaction();t.setMchid("other");assertThrows(IllegalArgumentException.class,()->PaymentService.validatePayment(order("PENDING",null),t,"app","merchant"));
        t.setMchid("merchant");t.getAmount().setCurrency("USD");assertThrows(IllegalArgumentException.class,()->PaymentService.validatePayment(order("PENDING",null),t,"app","merchant"));
    }
    @Test void duplicatePaidNotificationDoesNotCreditAgain() {
        when(orders.find("WXtest",true)).thenReturn(Mono.just(order("PAID","wx-tx")));
        StepVerifier.create(service.settle(transaction())).verifyComplete();verifyNoInteractions(credits);
    }
    @Test void nonSuccessCannotCredit() {
        var t=transaction();t.setTradeState(Transaction.TradeStateEnum.NOTPAY);
        StepVerifier.create(service.settle(t)).verifyComplete();verifyNoInteractions(orders,credits);
    }
    @Test void settlementUsesSnapshotAndWritesLedger() {
        when(orders.find("WXtest",true)).thenReturn(Mono.just(order("PENDING",null)));
        when(credits.changeBalance(1L,20)).thenReturn(Mono.just(120));
        when(credits.createTransaction(1L,"wechat_pay",null,20,120,"微信支付充值 WXtest")).thenReturn(Mono.empty());
        when(orders.paid(eq("WXtest"),eq("wx-tx"),any())).thenReturn(Mono.empty());
        when(orders.find("WXtest",false)).thenReturn(Mono.just(order("PAID","wx-tx")));
        when(events.publish(eq(1L),any())).thenReturn(Mono.empty());
        StepVerifier.create(service.settle(transaction())).verifyComplete();verify(credits,times(1)).changeBalance(1L,20);verify(tx).transactional(any(Mono.class));
    }
    @Test void cannotReadAnotherUsersOrder() {
        when(users.currentUserId()).thenReturn(Mono.just(2L));when(orders.owned("WXtest",2L)).thenReturn(Mono.empty());
        StepVerifier.create(service.get("WXtest")).expectError().verify();verifyNoInteractions(gateway);
    }
    @Test void clientCannotChooseUnknownPackage() {
        when(gateway.credentialsReady()).thenReturn(true);properties.setPackagesJson("[]");
        StepVerifier.create(service.create("invented",UUID.randomUUID())).expectError().verify();verify(orders,never()).insert(any(),any(),any());
    }
    @Test void retryRetainsExistingOrderPriceAfterPackageEdit() {
        when(gateway.credentialsReady()).thenReturn(true);
        when(packages.active()).thenReturn(Mono.just(java.util.List.of(new WechatPayProperties.CreditPackage("basic","新价格",999,999))));
        when(users.currentUserId()).thenReturn(Mono.just(1L));when(orders.lockUser(1L)).thenReturn(Mono.empty());
        UUID requestId=UUID.randomUUID();
        when(orders.byRequest(1L,requestId)).thenReturn(Mono.just(order("PENDING",null)));
        StepVerifier.create(service.create("basic",requestId)).expectNextMatches(o->o.amountFen()==100 && o.credits()==20).verifyComplete();
        verify(orders,never()).insert(any(),any(),any());verify(gateway,never()).prepay(any());
    }
    @Test void disabledMerchantDoesNotCreateOrder() {
        StepVerifier.create(service.create("basic",UUID.randomUUID())).expectError().verify();verify(orders,never()).insert(any(),any(),any());
    }
    @Test void disabledDatabaseSwitchBlocksCatalogAndNewOrders() {
        when(orders.collectionEnabled(anyBoolean())).thenReturn(Mono.just(false));
        StepVerifier.create(service.catalog()).expectNextMatches(c->!c.enabled() && c.packages().isEmpty()).verifyComplete();
        StepVerifier.create(service.create("basic",UUID.randomUUID())).expectError().verify();
        verifyNoInteractions(gateway);verify(orders,never()).insert(any(),any(),any());
    }
    @Test void closingCollectionDoesNotStopExistingOrderReconciliation() {
        properties.setEnabled(false);
        when(orders.claimCheck("WXtest")).thenReturn(Mono.just(true));
        var t=transaction();t.setTradeState(Transaction.TradeStateEnum.NOTPAY);
        when(gateway.query("WXtest")).thenReturn(Mono.just(t));
        StepVerifier.create(service.refresh(order("PENDING",null))).verifyComplete();verify(gateway).query("WXtest");
    }
    @Test void savesSwitchWithCurrentAdministratorId() {
        when(users.currentUserId()).thenReturn(Mono.just(1L));
        when(orders.setCollectionEnabled(false,1L)).thenReturn(Mono.empty());
        when(orders.collectionEnabled(anyBoolean())).thenReturn(Mono.just(false));
        StepVerifier.create(service.saveSettings(false)).expectNextMatches(s->!s.enabled()).verifyComplete();
        verify(orders).setCollectionEnabled(false,1L);
    }
    @Test void packageValidationRejectsFreeOrDuplicatePlans() {
        properties.setPackagesJson("[{\"id\":\"free\",\"name\":\"Free\",\"amountFen\":0,\"credits\":100}]");
        assertThrows(IllegalStateException.class,properties::packages);
        properties.setPackagesJson("[{\"id\":\"a\",\"name\":\"A\",\"amountFen\":100,\"credits\":20}]");
        assertEquals(100,properties.packages().getFirst().amountFen());
    }
    @Test void expiredUnpaidOrderClosesAtProviderBeforeDatabase() {
        queryReturns(Transaction.TradeStateEnum.NOTPAY);
        var close=reactor.core.publisher.Sinks.<Void>empty();
        when(gateway.close("WXtest")).thenReturn(close.asMono());
        when(orders.closed("WXtest")).thenReturn(Mono.empty());
        StepVerifier.create(service.refresh(expiredOrder()))
                .then(()->verify(orders,never()).closed(anyString()))
                .then(()->close.tryEmitEmpty()).verifyComplete();
        verify(orders).closed("WXtest");verifyNoInteractions(credits);
    }
    @Test void unpaidOrderBeforeDeadlineIsNotClosed() {
        queryReturns(Transaction.TradeStateEnum.NOTPAY);
        StepVerifier.create(service.refresh(order("PENDING",null))).verifyComplete();
        verify(gateway,never()).close(anyString());verify(orders,never()).closed(anyString());
    }
    @Test void failedProviderCloseKeepsOrderPendingForRetry() {
        queryReturns(Transaction.TradeStateEnum.NOTPAY);
        when(gateway.close("WXtest")).thenReturn(Mono.error(new RuntimeException("provider unavailable")),Mono.empty());
        when(orders.closed("WXtest")).thenReturn(Mono.empty());
        StepVerifier.create(service.refresh(expiredOrder())).verifyComplete();
        verify(orders,never()).closed(anyString());
        StepVerifier.create(service.refresh(expiredOrder())).verifyComplete();
        verify(orders).closed("WXtest");
    }
    @Test void failedQueryCannotFalselyCancelAnOrder() {
        when(orders.claimCheck("WXtest")).thenReturn(Mono.just(true));
        when(gateway.query("WXtest")).thenReturn(Mono.error(new RuntimeException("network unavailable")));
        StepVerifier.create(service.refresh(expiredOrder())).verifyComplete();
        verify(gateway,never()).close(anyString());verify(orders,never()).closed(anyString());
    }
    @Test void providerAlreadyClosedIsReflectedLocally() {
        queryReturns(Transaction.TradeStateEnum.CLOSED);
        when(orders.closed("WXtest")).thenReturn(Mono.empty());
        StepVerifier.create(service.refresh(expiredOrder())).verifyComplete();
        verify(orders).closed("WXtest");verify(gateway,never()).close(anyString());
    }
    @Test void successfulPaymentAtDeadlineIsSettledInsteadOfCanceled() {
        queryReturns(Transaction.TradeStateEnum.SUCCESS);
        when(orders.find("WXtest",true)).thenReturn(Mono.just(expiredOrder()));
        when(credits.changeBalance(1L,20)).thenReturn(Mono.just(120));
        when(credits.createTransaction(eq(1L),eq("wechat_pay"),isNull(),eq(20),eq(120),anyString())).thenReturn(Mono.empty());
        when(orders.paid(eq("WXtest"),eq("wx-tx"),any())).thenReturn(Mono.empty());
        when(orders.find("WXtest",false)).thenReturn(Mono.just(order("PAID","wx-tx")));
        when(events.publish(eq(1L),any())).thenReturn(Mono.empty());
        StepVerifier.create(service.refresh(expiredOrder())).verifyComplete();
        verify(credits).changeBalance(1L,20);verify(gateway,never()).close(anyString());verify(orders,never()).closed(anyString());
    }
    @Test void backgroundReconciliationClosesExpiredOrdersWithoutBrowser() {
        when(gateway.credentialsReady()).thenReturn(true);
        when(orders.pending()).thenReturn(reactor.core.publisher.Flux.just(expiredOrder()));
        queryReturns(Transaction.TradeStateEnum.NOTPAY);
        when(gateway.close("WXtest")).thenReturn(Mono.empty());
        when(orders.closed("WXtest")).thenReturn(Mono.empty());
        service.reconcile();
        verify(orders).closed("WXtest");verifyNoInteractions(users);
    }
}
