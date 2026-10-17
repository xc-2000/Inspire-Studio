package com.inspirestudio.agent.dto;

/**
 * 主Agent请求状态查询结果。
 *
 * @param status String 请求状态：queued、running、success、failed、canceled或interrupted
 * @param message String 终态说明，运行中为空
 * @date     2026-08-26 00:00
 */
public record AgentRequestStatusResponse(String status, String message) {
}
