package com.inspirestudio.payment;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.repository.CreditRepository;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.task.AiTaskEventPublisher;
import com.wechat.pay.java.service.payments.model.Transaction;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

@Service
@RequiredArgsConstructor
@Slf4j
public class PaymentService {
    private final java.util.concurrent.atomic.AtomicBoolean reconciling = new java.util.concurrent.atomic.AtomicBoolean();
    private final WechatPayProperties properties;
    private final WechatGateway gateway;
    private final PaymentRepository orders;
    private final CreditRepository credits;
    private final CurrentUserProvider users;
    private final TransactionalOperator tx;
    private final AiTaskEventPublisher events;
    private final PaymentPackageService packages;
    public record Catalog(boolean enabled,List<WechatPayProperties.CreditPackage> packages) {}
    public record OrderPage(List<PaymentRepository.Order> items,long total) {}
    private BusinessException error(String message) { return new BusinessException(ErrorCode.BUSINESS_ERROR,message); }
    public record CollectionSettings(boolean enabled,boolean merchantConfigured,boolean packagesConfigured,boolean acceptingPayments) {}
    public Mono<CollectionSettings> settings() {
        return Mono.zip(orders.collectionEnabled(properties.isEnabled()),packages.active()).map(values -> {
            boolean enabled=values.getT1(),merchant=gateway.credentialsReady(),hasPackages=!values.getT2().isEmpty();
            return new CollectionSettings(enabled,merchant,hasPackages,enabled && merchant && hasPackages);
        });
    }
    public Mono<CollectionSettings> saveSettings(boolean enabled) {
        return users.currentUserId().flatMap(uid->orders.setCollectionEnabled(enabled,uid)).then(Mono.defer(this::settings));
    }
    public Mono<Catalog> catalog() {
        return orders.collectionEnabled(properties.isEnabled()).flatMap(enabled -> {
            if(!enabled || !gateway.credentialsReady())return Mono.just(new Catalog(false,List.of()));
            return packages.active().map(items->new Catalog(!items.isEmpty(),items));
        });
    }

    public Mono<PaymentRepository.Order> create(String packageId,UUID requestId) {
        return orders.collectionEnabled(properties.isEnabled()).flatMap(enabled -> {
            if (!enabled) return Mono.error(error("微信收款已关闭"));
            if (!gateway.credentialsReady()) return Mono.error(error("微信支付暂未开放"));
            return packages.active().flatMap(items -> {
            var pack=items.stream().filter(p->p.id().equals(packageId)).findFirst()
                    .orElseThrow(()->error("套餐不存在或已下架"));
            return users.currentUserId().flatMap(uid -> orders.lockUser(uid)
                    .then(orders.byRequest(uid,requestId)).switchIfEmpty(Mono.defer(()->orders.recentCount(uid)
                            .flatMap(count->count>=20?Mono.error(error("下单频繁，请稍后重试")):orders.insert(uid,requestId,pack))))
                    .as(tx::transactional))
                    .flatMap(order -> {
                        if (!order.packageId().equals(packageId)) return Mono.error(error("请求编号已用于其他套餐"));
                        if (!order.status().equals("PENDING") || order.codeUrl()!=null || order.expiresAt().isBefore(OffsetDateTime.now())) return Mono.just(order);
                        return gateway.prepay(order).flatMap(code->orders.setCode(order.orderNo(),code))
                                .then(orders.find(order.orderNo(),false))
                                .onErrorMap(e->error("暂时无法获取微信二维码，请稍后在订单记录中查询"));
                    });
            });
        });
    }
    public Mono<PaymentRepository.Order> get(String no) {
        return users.currentUserId().flatMap(uid->orders.owned(no,uid))
                .switchIfEmpty(Mono.error(error("订单不存在")))
                .flatMap(order->refresh(order).then(orders.find(no,false)));
    }
    public Mono<OrderPage> list(int page,int size,boolean admin) {
        if(page<1 || page>100000 || size<1 || size>100)return Mono.error(error("分页参数无效"));
        if(admin)return page(null,page,size);
        return users.currentUserId().flatMap(uid->page(uid,page,size));
    }
    private Mono<OrderPage> page(Long uid,int page,int size) {
        return Mono.zip(orders.list(uid,page,size).collectList(),orders.count(uid)).map(t->new OrderPage(t.getT1(),t.getT2()));
    }
    /** Snapshot amount and credit count always come from the server-side order. */
    public Mono<Void> settle(Transaction transaction) {
        return Mono.defer(()-> {
            if(transaction.getTradeState()!=Transaction.TradeStateEnum.SUCCESS) return Mono.empty();
            return orders.find(transaction.getOutTradeNo(),true).switchIfEmpty(Mono.error(error("支付订单不存在")))
                    .flatMap(order -> {
                        validatePayment(order,transaction,properties.getAppId(),properties.getMerchantId());
                        if(order.status().equals("PAID")) {
                            if(!transaction.getTransactionId().equals(order.transactionId())) return Mono.error(error("支付流水不匹配"));
                            return Mono.<Integer>empty();
                        }
                        return credits.changeBalance(order.userId(),order.credits()).switchIfEmpty(Mono.error(error("积分账户不存在")))
                                .flatMap(balance->credits.createTransaction(order.userId(),"wechat_pay",null,order.credits(),balance,"微信支付充值 "+order.orderNo())
                                        .then(orders.paid(order.orderNo(),transaction.getTransactionId(),OffsetDateTime.parse(transaction.getSuccessTime())))
                                        .thenReturn(balance));
                    }).as(tx::transactional)
                    // Notification of the committed balance is best-effort, never part of settlement.
                    .flatMap(balance->orders.find(transaction.getOutTradeNo(),false).flatMap(order->events.publish(order.userId(),
                            new AiTaskDtos.AiTaskEvent("credit-balance",null,null,balance))).onErrorResume(e->Mono.empty())).then();
        });
    }
    static void validatePayment(PaymentRepository.Order order,Transaction t,String appId,String merchantId) {
        if(!appId.equals(t.getAppid()) || !merchantId.equals(t.getMchid()) || !order.orderNo().equals(t.getOutTradeNo())
                || t.getAmount()==null || !Integer.valueOf(order.amountFen()).equals(t.getAmount().getTotal())
                || !"CNY".equals(t.getAmount().getCurrency()) || t.getTransactionId()==null || t.getTransactionId().isBlank()
                || t.getSuccessTime()==null) throw new IllegalArgumentException("支付订单金额或商户信息不匹配");
    }
    public Mono<Void> refresh(PaymentRepository.Order order) {
        if(!order.status().equals("PENDING")) return Mono.empty();
        return orders.claimCheck(order.orderNo()).flatMap(claimed->!claimed?Mono.empty():gateway.query(order.orderNo()).flatMap(t->{
            if(t.getTradeState()==Transaction.TradeStateEnum.SUCCESS)return settle(t);
            if(t.getTradeState()==Transaction.TradeStateEnum.CLOSED)return orders.closed(order.orderNo());
            if(t.getTradeState()==Transaction.TradeStateEnum.NOTPAY && !order.expiresAt().isAfter(OffsetDateTime.now()))
                return gateway.close(order.orderNo()).then(Mono.defer(()->orders.closed(order.orderNo())));
            return Mono.empty();
        })).onErrorResume(e->{
            if(e instanceof com.wechat.pay.java.core.exception.ServiceException apiError
                    && "ORDER_NOT_EXIST".equals(apiError.getErrorCode()) && !order.expiresAt().isAfter(OffsetDateTime.now()))
                return orders.closed(order.orderNo());
            log.warn("微信订单对账暂未完成: orderNo={}",order.orderNo());return Mono.empty();
        });
    }
    /** Callback loss and browser closure do not prevent eventual credit delivery. */
    @Scheduled(fixedDelay=1000,initialDelay=1000)
    public void reconcile() {
        if(gateway.credentialsReady() && reconciling.compareAndSet(false,true)) orders.pending().flatMap(this::refresh,5).then()
                .doFinally(signal->reconciling.set(false))
                .subscribe(null,e->log.warn("微信订单对账任务失败"));
    }
}
