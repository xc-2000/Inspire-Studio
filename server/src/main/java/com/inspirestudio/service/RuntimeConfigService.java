package com.inspirestudio.service;

import com.inspirestudio.ai.AiTaskPollingSupport;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.RuntimeConfigDtos;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * 服务端运行时配置服务。
 *
 * @date     2026-08-13 12:00:00
 */
@Service
@RequiredArgsConstructor
public class RuntimeConfigService {

    /** 服务配置。 */
    private final InspireProperties properties;

    /**
     * 获取用户端任务状态轮询配置。
     *
     * @return RuntimeConfigDtos.RuntimeConfigResponse 运行时配置
     * @throws IllegalStateException 轮询间隔配置无效时抛出
     */
    public RuntimeConfigDtos.RuntimeConfigResponse getRuntimeConfig() {
        return new RuntimeConfigDtos.RuntimeConfigResponse(AiTaskPollingSupport.pollingIntervalSeconds(properties));
    }
}
