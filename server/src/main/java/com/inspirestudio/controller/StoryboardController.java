package com.inspirestudio.controller;

import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.StoryboardDtos;
import com.inspirestudio.service.StoryboardAgentService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * 分镜脚本生成与中文提示词合成接口。
 *
 * @date     2026-08-08 00:00
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/ai/storyboard")
@RequiredArgsConstructor
public class StoryboardController {

    /** 分镜脚本业务服务。 */
    private final StoryboardAgentService storyboardAgentService;

    /**
     * 根据剧本文本和剧情描述生成分镜与资产清单。
     *
     * @param request GenerateStoryboardRequest 分镜生成请求
     * @param httpRequest ServerHttpRequest HTTP请求
     * @return Mono<ApiResponse<GenerateStoryboardResponse>> 分镜生成结果
     */
    @PostMapping("/generateStoryboard")
    public Mono<ApiResponse<StoryboardDtos.GenerateStoryboardResponse>> generateStoryboard(
            @Valid @RequestBody StoryboardDtos.GenerateStoryboardRequest request, ServerHttpRequest httpRequest) {
        log.info("分镜生成请求: url=/api/v1/ai/storyboard/generateStoryboard, requestId={}", httpRequest.getId());
        return storyboardAgentService.generateStoryboard(request)
                .doOnNext(response -> log.info("分镜生成完成: requestId={}", httpRequest.getId()))
                .map(ApiResponse::ok);
    }

    /**
     * 为当前镜头和资产一次性合成全部中文最终提示词。
     *
     * @param request ComposePromptsRequest 提示词合成请求
     * @param httpRequest ServerHttpRequest HTTP请求
     * @return Mono<ApiResponse<ComposePromptsResponse>> 提示词合成结果
     */
    @PostMapping("/composePrompts")
    public Mono<ApiResponse<StoryboardDtos.ComposePromptsResponse>> composePrompts(
            @Valid @RequestBody StoryboardDtos.ComposePromptsRequest request, ServerHttpRequest httpRequest) {
        log.info("分镜提示词合成请求: url=/api/v1/ai/storyboard/composePrompts, requestId={}", httpRequest.getId());
        return storyboardAgentService.composePrompts(request)
                .doOnNext(response -> log.info("分镜提示词合成完成: requestId={}", httpRequest.getId()))
                .map(ApiResponse::ok);
    }

    /**
     * 为单个分镜资产创建图片生成任务，提示词由服务端按资产类别模板渲染。
     *
     * @param request CreateAssetImageTaskRequest 资产图片任务请求
     * @param httpRequest ServerHttpRequest HTTP请求
     * @return Mono<ApiResponse<AiGenerationTaskResponse>> 已入队的AI任务
     */
    @PostMapping("/createAssetImageTask")
    public Mono<ApiResponse<AiTaskDtos.AiGenerationTaskResponse>> createAssetImageTask(
            @Valid @RequestBody StoryboardDtos.CreateAssetImageTaskRequest request, ServerHttpRequest httpRequest) {
        log.info("分镜资产图片任务请求: url=/api/v1/ai/storyboard/createAssetImageTask, requestId={}", httpRequest.getId());
        return storyboardAgentService.createAssetImageTask(request)
                .doOnNext(response -> log.info("分镜资产图片任务完成: requestId={}", httpRequest.getId()))
                .map(ApiResponse::ok);
    }
}
