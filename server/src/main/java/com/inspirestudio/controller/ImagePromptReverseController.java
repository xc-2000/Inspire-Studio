package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.ImagePromptReverseDtos;
import com.inspirestudio.service.ImagePromptReverseService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/** 图片反推复用现有 AI 异步任务、鉴权和计费链路。 */
@RestController
@RequestMapping("/api/v1/ai/prompt")
@RequiredArgsConstructor
public class ImagePromptReverseController {
    private final ImagePromptReverseService service;

    @GetMapping("/reverseImageModels")
    public Mono<ApiResponse<AiTaskDtos.AiModelListResponse>> listModels() {
        return service.listModels().map(ApiResponse::ok);
    }

    @PostMapping("/reverseImage")
    public Mono<ApiResponse<AiTaskDtos.AiGenerationTaskResponse>> reverseImage(
            @Valid @RequestBody ImagePromptReverseDtos.ReverseImageRequest request) {
        return service.reverseImage(request).map(ApiResponse::ok);
    }
}
