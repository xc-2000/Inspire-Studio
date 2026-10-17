package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.EcommerceDtos;
import com.inspirestudio.service.EcommerceService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api/v1/ecommerce")
@RequiredArgsConstructor
public class EcommerceController {
    private final EcommerceService service;

    @PostMapping("/listProjects")
    public Mono<ApiResponse<EcommerceDtos.ProjectPage>> listProjects(@RequestBody EcommerceDtos.ListProjectsRequest request) {
        return service.listProjects(request).map(ApiResponse::ok);
    }

    @GetMapping("/getProject")
    public Mono<ApiResponse<EcommerceDtos.Project>> getProject(@RequestParam String id) {
        return service.getProject(id).map(ApiResponse::ok);
    }

    @PostMapping("/saveProject")
    public Mono<ApiResponse<EcommerceDtos.Project>> saveProject(@RequestBody EcommerceDtos.SaveProjectRequest request) {
        return service.saveProject(request).map(ApiResponse::ok);
    }

    @PostMapping("/deleteProject")
    public Mono<ApiResponse<String>> deleteProject(@RequestBody EcommerceDtos.DeleteProjectRequest request) {
        return service.deleteProject(request).thenReturn(ApiResponse.ok("ok"));
    }

    @PostMapping("/generate")
    public Mono<ApiResponse<EcommerceDtos.GenerateResponse>> generate(@RequestBody EcommerceDtos.GenerateRequest request) {
        return service.generate(request).map(ApiResponse::ok);
    }

    @GetMapping("/listJobs")
    public Mono<ApiResponse<EcommerceDtos.JobList>> listJobs(@RequestParam String projectId) {
        return service.listJobs(projectId).map(ApiResponse::ok);
    }
}
