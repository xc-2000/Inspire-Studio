package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.NewApiDtos.*;
import com.inspirestudio.security.RequireRole;
import com.inspirestudio.service.NewApiService;
import jakarta.validation.Valid;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api/v1/admin/newapi")
@RequiredArgsConstructor
public class NewApiController {
    private final NewApiService service;
    @GetMapping("/plugins") @RequireRole("admin")
    public Mono<ApiResponse<List<TaskPlugin>>> plugins() { return service.plugins().map(ApiResponse::ok); }
    @GetMapping("/status") @RequireRole("admin")
    public Mono<ApiResponse<Status>> status() { return service.status().map(ApiResponse::ok); }
    @GetMapping("/channels") @RequireRole("admin")
    public Mono<ApiResponse<Page<Channel>>> channels(@RequestParam(defaultValue="1") int page,
            @RequestParam(defaultValue="20") int pageSize, @RequestParam(defaultValue="") String keyword) {
        return service.channels(page, pageSize, keyword).map(ApiResponse::ok);
    }
    @PostMapping("/channels/save") @RequireRole("admin")
    public Mono<ApiResponse<String>> save(@Valid @RequestBody SaveChannel input) { return service.save(input).map(ApiResponse::ok); }
    @PostMapping("/channels/models") @RequireRole("admin")
    public Mono<ApiResponse<List<String>>> fetch(@Valid @RequestBody FetchModels input) { return service.fetchModels(input).map(ApiResponse::ok); }
    @PostMapping("/channels/status") @RequireRole("admin")
    public Mono<ApiResponse<String>> enabled(@Valid @RequestBody StatusRequest input) { return service.setStatus(input).map(ApiResponse::ok); }
    @PostMapping("/channels/delete") @RequireRole("admin")
    public Mono<ApiResponse<String>> delete(@Valid @RequestBody IdRequest input) { return service.delete(input.id()).map(ApiResponse::ok); }
    @GetMapping("/models") @RequireRole("admin")
    public Mono<ApiResponse<List<CatalogModel>>> models() { return service.catalog().map(ApiResponse::ok); }
    @GetMapping("/model-routes") @RequireRole("admin")
    public Mono<ApiResponse<List<ModelRoute>>> routes() { return service.modelRoutes().map(ApiResponse::ok); }
    @PostMapping("/model-routes/select") @RequireRole("admin")
    public Mono<ApiResponse<String>> selectRoute(@Valid @RequestBody SelectRoute input) { return service.selectRoute(input).map(ApiResponse::ok); }
    @PostMapping("/models/sync") @RequireRole("admin")
    public Mono<ApiResponse<SyncResult>> sync(@Valid @RequestBody SyncRequest input) { return service.sync(input).map(ApiResponse::ok); }
    @GetMapping("/importable") @RequireRole("admin")
    public Mono<ApiResponse<List<Importable>>> importable() { return service.importable().map(ApiResponse::ok); }
    @PostMapping("/import") @RequireRole("admin")
    public Mono<ApiResponse<String>> migrate(@Valid @RequestBody ImportRequest input) { return service.migrate(input.channelId(), false).map(ApiResponse::ok); }
    @PostMapping("/restore") @RequireRole("admin")
    public Mono<ApiResponse<String>> restore(@Valid @RequestBody ImportRequest input) { return service.migrate(input.channelId(), true).map(ApiResponse::ok); }
}
