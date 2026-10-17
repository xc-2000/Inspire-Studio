package com.inspirestudio.payment;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.security.AdminGuard;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.Map;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

@RestController
@RequiredArgsConstructor
public class PaymentController {
    private final PaymentService service;
    private final WechatGateway gateway;
    private final AdminGuard admin;
    private final PaymentPackageService packages;
    @GetMapping("/api/v1/admin/payment/packages")
    public Mono<ApiResponse<PaymentPackageService.Settings>> packages() {
        return admin.requireAdmin().then(Mono.defer(packages::get)).map(ApiResponse::ok);
    }
    @PostMapping("/api/v1/admin/payment/packages")
    public Mono<ApiResponse<PaymentPackageService.Settings>> savePackages(@RequestBody PaymentPackageService.Settings request) {
        return admin.requireAdmin().then(Mono.defer(()->packages.save(request))).map(ApiResponse::ok);
    }
    public record CreateOrder(@NotBlank @Size(max=64) String packageId,@NotNull UUID requestId) {}
    @GetMapping("/api/v1/payment/catalog")
    public Mono<ApiResponse<PaymentService.Catalog>> catalog() { return service.catalog().map(ApiResponse::ok); }
    public record CollectionRequest(@NotNull Boolean enabled) {}
    @GetMapping("/api/v1/admin/payment/settings")
    public Mono<ApiResponse<PaymentService.CollectionSettings>> settings() {
        return admin.requireAdmin().then(Mono.defer(service::settings)).map(ApiResponse::ok);
    }
    @PostMapping("/api/v1/admin/payment/settings")
    public Mono<ApiResponse<PaymentService.CollectionSettings>> saveSettings(@Valid @RequestBody CollectionRequest request) {
        return admin.requireAdmin().then(Mono.defer(()->service.saveSettings(request.enabled()))).map(ApiResponse::ok);
    }
    @PostMapping("/api/v1/payment/orders")
    public Mono<ApiResponse<PaymentRepository.Order>> create(@Valid @RequestBody CreateOrder request) {
        return service.create(request.packageId(),request.requestId()).map(ApiResponse::ok);
    }
    @GetMapping("/api/v1/payment/orders/{no}")
    public Mono<ApiResponse<PaymentRepository.Order>> get(@PathVariable String no) { return service.get(no).map(ApiResponse::ok); }
    @GetMapping("/api/v1/payment/orders")
    public Mono<ApiResponse<PaymentService.OrderPage>> list(@RequestParam(defaultValue="1") int page,@RequestParam(defaultValue="20") int pageSize) {
        return service.list(page,pageSize,false).map(ApiResponse::ok);
    }
    @GetMapping("/api/v1/admin/payment/orders")
    public Mono<ApiResponse<PaymentService.OrderPage>> adminList(@RequestParam(defaultValue="1") int page,@RequestParam(defaultValue="20") int pageSize) {
        return admin.requireAdmin().then(Mono.defer(()->service.list(page,pageSize,true))).map(ApiResponse::ok);
    }
    @PostMapping({"/api/v1/payment/wechat/notify", "/api/v1/payment/webhook/wxpay"})
    public Mono<ResponseEntity<Map<String,String>>> notify(@RequestHeader HttpHeaders headers,@RequestBody String body) {
        return gateway.notification(headers,body).flatMap(service::settle)
                .thenReturn(ResponseEntity.ok(Map.of("code","SUCCESS","message","成功")))
                .onErrorResume(e->Mono.just(ResponseEntity.status(500).body(Map.of("code","FAIL","message","通知处理失败"))));
    }
}
