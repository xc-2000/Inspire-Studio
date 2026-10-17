package com.inspirestudio.ai;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.AiTaskDtos;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

/**
 * @title        AiProviderAdapterRegistryTest.java
 * @description  AI渠道适配器注册表测试
 * @createTime   2026-06-24 22:36:00
 */
class AiProviderAdapterRegistryTest {

    @Test
    void gatewayVideosAlwaysUseUnifiedAdapterWhileDirectRoutesKeepTheirAdapter() {
        AiProviderAdapter unified = new StubAdapter("newapi", List.of(AiTaskTypes.VIDEO));
        for (String format : List.of("minimax", "openai", "muse", "autodl-comfyui", "dola", "openai-video-json")) {
            AiProviderAdapter original = new StubAdapter(format, List.of(AiTaskTypes.VIDEO, AiTaskTypes.IMAGE));
            var registry = new AiProviderAdapterRegistry(List.of(unified, original));
            var migrated = new AiTaskDtos.AiChannelConfig("c", "test", "http://newapi:3000/v1/", "key", format, List.of("video"));
            Assertions.assertSame(unified, registry.resolve(migrated, AiTaskTypes.VIDEO));
            Assertions.assertTrue(registry.supports(migrated, AiTaskTypes.VIDEO));
            var direct = new AiTaskDtos.AiChannelConfig("c", "test", "https://supplier.example/v1", "key", format, List.of("video"));
            Assertions.assertSame(original, registry.resolve(direct, AiTaskTypes.VIDEO));
            Assertions.assertSame(original, registry.resolve(migrated, AiTaskTypes.IMAGE));
        }
    }

    /**
     * 测试空调用格式默认匹配OpenAI适配器。
     *
     * @return void 无返回值
     */
    @Test
    void shouldResolveDefaultOpenAiAdapter() {
        // 构造注册表并验证空apiFormat会按OpenAI兼容格式处理。
        AiProviderAdapter openAiAdapter = new StubAdapter("openai", List.of(AiTaskTypes.IMAGE));
        AiProviderAdapterRegistry registry = new AiProviderAdapterRegistry(List.of(openAiAdapter));
        AiTaskDtos.AiChannelConfig channel = new AiTaskDtos.AiChannelConfig("c1", "默认渠道", "https://example.com", "key", "", List.of("model"));

        Assertions.assertSame(openAiAdapter, registry.resolve(channel, AiTaskTypes.IMAGE));
    }

    /**
     * 测试不支持的任务类型会抛出业务异常。
     *
     * @return void 无返回值
     */
    @Test
    void shouldRejectUnsupportedTaskType() {
        // 只注册图片能力，文本任务必须明确失败，避免静默兜底到错误渠道。
        AiProviderAdapterRegistry registry = new AiProviderAdapterRegistry(List.of(new StubAdapter("agnes", List.of(AiTaskTypes.IMAGE))));
        AiTaskDtos.AiChannelConfig channel = new AiTaskDtos.AiChannelConfig("c1", "Agnes", "https://example.com", "key", "agnes", List.of("model"));

        Assertions.assertThrows(BusinessException.class, () -> registry.resolve(channel, AiTaskTypes.TEXT));
    }

    /**
     * 测试未知调用格式会抛出业务异常。
     *
     * @return void 无返回值
     */
    @Test
    void shouldRejectUnknownApiFormat() {
        // 未注册的apiFormat必须明确报错，便于后续新增适配器时显式接入。
        AiProviderAdapterRegistry registry = new AiProviderAdapterRegistry(List.of(new StubAdapter("openai", List.of(AiTaskTypes.IMAGE))));
        AiTaskDtos.AiChannelConfig channel = new AiTaskDtos.AiChannelConfig("c1", "未知", "https://example.com", "key", "unknown", List.of("model"));

        Assertions.assertThrows(BusinessException.class, () -> registry.resolve(channel, AiTaskTypes.IMAGE));
    }

    /**
     * @title        StubAdapter
     * @description  测试用AI渠道适配器
     * @createTime   2026-06-24 22:36:00
     */
    private static final class StubAdapter implements AiProviderAdapter {

        /** 调用格式 */
        private final String apiFormat;

        /** 支持的任务类型 */
        private final List<String> taskTypes;

        /**
         * 创建测试用AI渠道适配器。
         *
         * @param apiFormat String 调用格式
         * @param taskTypes List<String> 支持的任务类型
         */
        private StubAdapter(String apiFormat, List<String> taskTypes) {
            this.apiFormat = apiFormat;
            this.taskTypes = taskTypes;
        }

        /**
         * 获取调用格式。
         *
         * @return String 调用格式
         */
        @Override
        public String apiFormat() {
            return apiFormat;
        }

        /**
         * 判断是否支持任务类型。
         *
         * @param taskType String 任务类型
         * @return boolean 是否支持
         */
        @Override
        public boolean supports(String taskType) {
            return taskTypes.contains(taskType);
        }

        /**
         * 执行测试任务。
         *
         * @param context AiTaskExecutionContext AI任务执行上下文
         * @return Mono<JSONObject> 空结果
         */
        @Override
        public Mono<JSONObject> execute(AiTaskExecutionContext context) {
            return Mono.just(new JSONObject());
        }
    }
}
