package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.RegistrationEmailDtos.Policy;
import com.inspirestudio.dto.RegistrationEmailDtos.Settings;
import com.inspirestudio.security.AdminGuard;
import com.inspirestudio.security.RequireRole;
import com.inspirestudio.service.RegistrationEmailPolicyService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

@RestController
@RequiredArgsConstructor
public class RegistrationEmailController {
    private final RegistrationEmailPolicyService service;
    private final AdminGuard adminGuard;

    @GetMapping("/api/v1/config/getRegistrationEmailPolicy")
    public Mono<ResponseEntity<ApiResponse<Policy>>> getPolicy() {
        return service.getPolicy().map(policy -> ResponseEntity.ok()
                .cacheControl(CacheControl.noStore()).body(ApiResponse.ok(policy)));
    }

    @RequireRole("admin")
    @GetMapping("/api/v1/admin/user/getRegistrationEmailSettings")
    public Mono<ApiResponse<Settings>> getSettings() {
        return adminGuard.requireAdmin().then(Mono.defer(service::getSettings)).map(ApiResponse::ok);
    }

    @RequireRole("admin")
    @PostMapping("/api/v1/admin/user/updateRegistrationEmailSettings")
    public Mono<ApiResponse<Settings>> updateSettings(@Valid @RequestBody Settings settings) {
        return adminGuard.requireAdmin().then(Mono.defer(() -> service.save(settings))).map(ApiResponse::ok);
    }
}

