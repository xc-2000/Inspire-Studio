package com.inspirestudio.service;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.inspirestudio.agent.AgentTaskOrchestrator;
import com.inspirestudio.ai.AiProviderAdapterRegistry;
import com.inspirestudio.ai.provider.CustomProviderAdapter;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.repository.AiTaskRepository;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.task.AiTaskEventPublisher;
import com.inspirestudio.task.AiTaskQueue;
import com.inspirestudio.task.ModelTaskExecutionDispatcher;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.reactive.TransactionalOperator;

/**
 * AI模型目录访问权限测试。
 *
 * @date     2026-07-24 23:09
 */
class AiTaskModelAccessTest {

    /**
     * 未登录用户查询模型目录时应被拒绝，并且不得读取平台模型配置。
     *
     * @return void 无返回值
     */
    @Test
    void shouldRejectModelCatalogRequestWithoutAuthenticatedUser() {
        PersistenceService persistenceService = mock(PersistenceService.class);
        AiTaskService service = new AiTaskService(
                mock(AiTaskRepository.class),
                new CurrentUserProvider(),
                mock(InspireProperties.class),
                persistenceService,
                mock(AiTaskEventPublisher.class),
                mock(AiTaskQueue.class),
                mock(ModelTaskExecutionDispatcher.class),
                mock(AgentTaskOrchestrator.class),
                mock(AiProviderAdapterRegistry.class),
                mock(CustomProviderAdapter.class),
                mock(CreditService.class),
                mock(TransactionalOperator.class));

        BusinessException exception = Assertions.assertThrows(BusinessException.class,
                () -> service.listModels().block());

        Assertions.assertEquals(ErrorCode.TOKEN_INVALID, exception.getCode());
        verifyNoInteractions(persistenceService);
    }
}
