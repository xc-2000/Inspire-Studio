package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.EcommerceSkillDtos;
import com.inspirestudio.security.RequireRole;
import com.inspirestudio.service.EcommerceSkillService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class EcommerceSkillController {
    private final EcommerceSkillService service;

    @GetMapping("/ecommerce/skills")
    public Mono<ApiResponse<EcommerceSkillDtos.SkillList>> listSkills(@RequestParam(required = false) String platform,
            @RequestParam(required = false) String outputType, @RequestParam(required = false) String keyword) {
        return service.listUser(platform, outputType, keyword).map(ApiResponse::ok);
    }
    @PostMapping("/admin/ecommerce-skills/list")
    @RequireRole("admin")
    public Mono<ApiResponse<EcommerceSkillDtos.SkillPage>> listAdmin(@RequestBody EcommerceSkillDtos.ListRequest request) {
        return service.listAdmin(request).map(ApiResponse::ok);
    }
    @PostMapping("/admin/ecommerce-skills/save")
    @RequireRole("admin")
    public Mono<ApiResponse<EcommerceSkillDtos.Skill>> save(@RequestBody EcommerceSkillDtos.SaveRequest request) {
        return service.save(request).map(ApiResponse::ok);
    }
    @PostMapping("/admin/ecommerce-skills/status")
    @RequireRole("admin")
    public Mono<ApiResponse<EcommerceSkillDtos.Skill>> setStatus(@RequestBody EcommerceSkillDtos.StatusRequest request) {
        return service.setStatus(request).map(ApiResponse::ok);
    }
    @PostMapping("/admin/ecommerce-skills/delete")
    @RequireRole("admin")
    public Mono<ApiResponse<String>> delete(@RequestBody EcommerceSkillDtos.DeleteRequest request) {
        return service.delete(request).thenReturn(ApiResponse.ok("ok"));
    }
}
