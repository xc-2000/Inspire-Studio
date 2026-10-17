package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.HomepageShowcaseDtos;
import com.inspirestudio.security.AdminGuard;
import com.inspirestudio.security.RequireRole;
import com.inspirestudio.service.HomepageShowcaseService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * 首页精选内容接口。
 *
 * @date 2026-07-18 12:00:00
 */
@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class HomepageShowcaseController {

    private final HomepageShowcaseService service;
    private final AdminGuard adminGuard;

    /** 公开查询首页精选内容。 */
    @GetMapping("/homepage/listShowcases")
    public Mono<ApiResponse<HomepageShowcaseDtos.ShowcaseListResponse>> listPublic(@RequestParam(required = false) Integer limit,
                                                                                @RequestParam(required = false) Integer page,
                                                                                @RequestParam(required = false) Integer pageSize,
                                                                                @RequestParam(required = false) String category) {
        // 保留旧版 limit 调用；分页与分类请求使用完整公开列表。
        if (page == null && pageSize == null && category == null) return service.listPublic(limit).map(ApiResponse::ok);
        return service.listPublicPage(page, pageSize, category).map(ApiResponse::ok);
    }

    /** 管理员查询首页精选内容。 */
    @GetMapping("/admin/homepage/listShowcases")
    @RequireRole("admin")
    public Mono<ApiResponse<HomepageShowcaseDtos.ShowcaseListResponse>> listAdmin() {
        return adminGuard.requireAdmin().then(service.listAdmin()).map(ApiResponse::ok);
    }

    /** 管理员创建首页精选内容。 */
    @PostMapping("/admin/homepage/createShowcase")
    @RequireRole("admin")
    public Mono<ApiResponse<String>> create(@Valid @RequestBody HomepageShowcaseDtos.CreateShowcaseRequest request) {
        return adminGuard.requireAdmin().then(service.create(request)).thenReturn(ApiResponse.ok("ok"));
    }

    /** 管理员更新首页精选内容。 */
    @PostMapping("/admin/homepage/updateShowcase")
    @RequireRole("admin")
    public Mono<ApiResponse<String>> update(@Valid @RequestBody HomepageShowcaseDtos.UpdateShowcaseRequest request) {
        return adminGuard.requireAdmin().then(service.update(request)).thenReturn(ApiResponse.ok("ok"));
    }

    /** 管理员更新首页精选内容状态。 */
    @PostMapping("/admin/homepage/updateShowcaseStatus")
    @RequireRole("admin")
    public Mono<ApiResponse<String>> updateStatus(@Valid @RequestBody HomepageShowcaseDtos.UpdateShowcaseStatusRequest request) {
        return adminGuard.requireAdmin().then(service.updateStatus(request)).thenReturn(ApiResponse.ok("ok"));
    }

    /** 管理员删除首页精选内容。 */
    @PostMapping("/admin/homepage/deleteShowcases")
    @RequireRole("admin")
    public Mono<ApiResponse<String>> delete(@Valid @RequestBody HomepageShowcaseDtos.DeleteShowcasesRequest request) {
        return adminGuard.requireAdmin().then(service.delete(request)).thenReturn(ApiResponse.ok("ok"));
    }
}
