package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.PromptOptimizationDtos;
import com.inspirestudio.service.PromptOptimizationService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * 图片与视频生成提示词优化接口。
 *
 * @date     2026-07-17 00:00
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/ai/prompt")
@RequiredArgsConstructor
public class PromptOptimizationController {

    /** 提示词优化服务 */
    private final PromptOptimizationService promptOptimizationService;

    /**
     * 根据图片或视频生成场景优化用户提示词。
     *
     * @param request OptimizePromptRequest 提示词优化请求
     * @return Mono<ApiResponse<AiGenerationTaskResponse>> 已创建的优化任务
     */
    @PostMapping("/optimizePrompt")
    public Mono<ApiResponse<AiTaskDtos.AiGenerationTaskResponse>> optimizePrompt(
            @Valid @RequestBody PromptOptimizationDtos.OptimizePromptRequest request) {
        log.info("AI提示词优化请求: url=/api/v1/ai/prompt/optimizePrompt, generationType={}, prompt={}", request.generationType(), request.prompt());
        return promptOptimizationService.optimizePrompt(request)
                .doOnNext(task -> log.info("AI提示词优化任务创建成功: taskId={}, model={}", task.id(), task.model()))
                .map(ApiResponse::ok);
    }
}
