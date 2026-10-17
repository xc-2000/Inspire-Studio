package com.inspirestudio.payment;

import com.wechat.pay.java.core.RSAPublicKeyConfig;
import com.wechat.pay.java.core.notification.NotificationParser;
import com.wechat.pay.java.core.notification.RequestParam;
import com.wechat.pay.java.service.payments.nativepay.NativePayService;
import com.wechat.pay.java.service.payments.nativepay.model.*;
import com.wechat.pay.java.service.payments.model.Transaction;
import java.time.Instant;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import lombok.RequiredArgsConstructor;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** Official SDK signs requests, verifies responses and verifies/decrypts notifications. */
@Component
@RequiredArgsConstructor
public class WechatGateway {
    private final WechatPayProperties properties;
    private volatile RSAPublicKeyConfig config;
    private synchronized RSAPublicKeyConfig config() {
        if (config == null) {
            properties.validate();
            config = new RSAPublicKeyConfig.Builder().merchantId(properties.getMerchantId())
                    .privateKeyFromPath(properties.getPrivateKeyPath()).merchantSerialNumber(properties.getMerchantSerialNumber())
                    .publicKeyFromPath(properties.getPublicKeyPath()).publicKeyId(properties.getPublicKeyId())
                    .apiV3Key(properties.getApiV3Key()).build();
        }
        return config;
    }
    public boolean ready() {
        try { config(); return !properties.packages().isEmpty(); }
        catch (Exception e) { return false; }
    }
    public boolean credentialsReady() {
        try { config(); return true; } catch (Exception e) { return false; }
    }
    private NativePayService client() { return new NativePayService.Builder().config(config()).build(); }
    public Mono<String> prepay(PaymentRepository.Order order) {
        return Mono.fromCallable(() -> {
            var request = new PrepayRequest();
            request.setAppid(properties.getAppId()); request.setMchid(properties.getMerchantId());
            request.setDescription(order.description()); request.setOutTradeNo(order.orderNo());
            request.setNotifyUrl(properties.getNotifyUrl()); request.setTimeExpire(order.expiresAt().toString());
            var amount = new Amount(); amount.setTotal(order.amountFen()); amount.setCurrency("CNY");
            request.setAmount(amount);
            String url = client().prepay(request).getCodeUrl();
            if (url == null || !url.startsWith("weixin://wxpay/")) throw new IllegalStateException("无效支付二维码");
            return url;
        }).subscribeOn(Schedulers.boundedElastic());
    }
    public Mono<Transaction> query(String orderNo) {
        return Mono.fromCallable(() -> {
            var request = new QueryOrderByOutTradeNoRequest();
            request.setMchid(properties.getMerchantId()); request.setOutTradeNo(orderNo);
            return client().queryOrderByOutTradeNo(request);
        }).subscribeOn(Schedulers.boundedElastic());
    }
    public Mono<Void> close(String orderNo) {
        return Mono.fromRunnable(() -> {
            var request = new CloseOrderRequest(); request.setMchid(properties.getMerchantId()); request.setOutTradeNo(orderNo);
            client().closeOrder(request);
        }).subscribeOn(Schedulers.boundedElastic()).then();
    }
    public Mono<Transaction> notification(HttpHeaders headers, String body) {
        return Mono.fromCallable(() -> {
            String timestamp = headers.getFirst("Wechatpay-Timestamp");
            if (timestamp == null || Math.abs(Instant.now().getEpochSecond() - Long.parseLong(timestamp)) > 300)
                throw new IllegalArgumentException("通知时间戳无效");
            var param = new RequestParam.Builder().serialNumber(headers.getFirst("Wechatpay-Serial"))
                    .nonce(headers.getFirst("Wechatpay-Nonce")).signature(headers.getFirst("Wechatpay-Signature"))
                    .timestamp(timestamp).body(body).build();
            return new NotificationParser(config()).parse(param, Transaction.class);
        }).subscribeOn(Schedulers.boundedElastic());
    }
}
