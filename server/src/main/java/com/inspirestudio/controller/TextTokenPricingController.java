package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.security.AdminGuard;
import com.inspirestudio.service.TextTokenBillingService;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api/v1/admin/model/tokenPricing")
@RequiredArgsConstructor
public class TextTokenPricingController {
    private final AdminGuard admin;
    private final TextTokenBillingService billing;
    @GetMapping public Mono<ApiResponse<List<TextTokenBillingService.Price>>> list(){return admin.requireAdmin().then(billing.list().collectList()).map(ApiResponse::ok);}
    @GetMapping("/catalog") public Mono<ApiResponse<List<TextTokenBillingService.OfficialRate>>> catalog(){return admin.requireAdmin().thenReturn(ApiResponse.ok(TextTokenBillingService.officialRates()));}
    @PostMapping public Mono<ApiResponse<TextTokenBillingService.Price>> save(@RequestBody TextTokenBillingService.Price price){return admin.requireAdmin().then(Mono.defer(()->billing.save(price))).map(ApiResponse::ok);}
}
