package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.SocialPublishingDtos;
import com.inspirestudio.service.SocialPublishingService;
import jakarta.validation.Valid;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/** 当前用户的社交平台内容发布接口。 */
@RestController
@RequestMapping("/api/v1/publishing")
@RequiredArgsConstructor
public class SocialPublishingController {

    private final SocialPublishingService service;

    @GetMapping("/accounts")
    public Mono<ApiResponse<List<SocialPublishingDtos.AccountItem>>> listAccounts() {
        return service.listAccounts().map(ApiResponse::ok);
    }

    @PostMapping("/accounts/save")
    public Mono<ApiResponse<SocialPublishingDtos.AccountItem>> saveAccount(
            @Valid @RequestBody SocialPublishingDtos.SaveAccountRequest request) {
        return service.saveAccount(request).map(ApiResponse::ok);
    }

    @PostMapping("/accounts/delete")
    public Mono<ApiResponse<String>> deleteAccount(@Valid @RequestBody SocialPublishingDtos.AccountIdRequest request) {
        return service.deleteAccount(request.id()).thenReturn(ApiResponse.ok("ok"));
    }

    @PostMapping("/accounts/check")
    public Mono<ApiResponse<SocialPublishingDtos.AccountItem>> checkAccount(
            @Valid @RequestBody SocialPublishingDtos.AccountIdRequest request) {
        return service.checkAccount(request.id()).map(ApiResponse::ok);
    }

    @PostMapping("/accounts/qr/start")
    public Mono<ApiResponse<SocialPublishingDtos.QrLoginResponse>> startQrLogin(
            @Valid @RequestBody SocialPublishingDtos.QrLoginStartRequest request) {
        return service.startQrLogin(request).map(ApiResponse::ok);
    }

    @PostMapping("/accounts/qr/status")
    public Mono<ApiResponse<SocialPublishingDtos.QrLoginResponse>> qrLoginStatus(
            @Valid @RequestBody SocialPublishingDtos.QrLoginSessionRequest request) {
        return service.qrLoginStatus(request.sessionId()).map(ApiResponse::ok);
    }

    @PostMapping("/accounts/qr/cancel")
    public Mono<ApiResponse<String>> cancelQrLogin(
            @Valid @RequestBody SocialPublishingDtos.QrLoginSessionRequest request) {
        return service.cancelQrLogin(request.sessionId()).thenReturn(ApiResponse.ok("ok"));
    }

    @PostMapping("/accounts/qr/action")
    public Mono<ApiResponse<String>> qrLoginAction(
            @Valid @RequestBody SocialPublishingDtos.QrLoginActionRequest request) {
        return service.qrLoginAction(request).thenReturn(ApiResponse.ok("ok"));
    }

    @PostMapping("/tasks")
    public Mono<ApiResponse<SocialPublishingDtos.TaskItem>> createTask(
            @Valid @RequestBody SocialPublishingDtos.CreateTaskRequest request) {
        return service.createTask(request).map(ApiResponse::ok);
    }

    @GetMapping("/tasks")
    public Mono<ApiResponse<SocialPublishingDtos.TaskListResponse>> listTasks(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int pageSize) {
        return service.listTasks(page, pageSize).map(ApiResponse::ok);
    }

    @GetMapping("/tasks/status")
    public Mono<ApiResponse<List<SocialPublishingDtos.TaskStatusItem>>> taskStatuses(@RequestParam List<String> ids) {
        return service.taskStatuses(ids).map(ApiResponse::ok);
    }
}
