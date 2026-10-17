package com.inspirestudio.agent.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * Agent 会话取消请求。
 *
 * @param sessionId String 待取消的 Agent 会话ID
 * @param requestId String 待取消的统一主Agent请求ID
 * @date     2026-07-18 22:20
 */
public record AgentCancelRequest(
        @NotBlank(message = "会话ID不能为空") String sessionId,
        @NotBlank(message = "请求ID不能为空") String requestId
) {
}
