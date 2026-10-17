package com.inspirestudio.service;

import com.inspirestudio.agent.workflow.VideoWorkflowRegistry;
import com.inspirestudio.dto.SkillDtos;
import com.inspirestudio.entity.SkillRecords;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.repository.SkillRepository;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import java.time.OffsetDateTime;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SkillServiceTest {
    @Test void userCatalogIncludesSkillsBeyondFirstHundred() {
        var repository = mock(SkillRepository.class);
        var service = new SkillService(repository, mock(VideoWorkflowRegistry.class));
        when(repository.countSkills(any(), eq(true))).thenReturn(Mono.just(241L));
        when(repository.listSkills(any(), eq(true))).thenAnswer(invocation -> {
            SkillDtos.SkillListRequest request = invocation.getArgument(0);
            return Flux.range(1, Math.min(241, request.pageSize())).map(id -> {
                var record = new SkillRecords.SkillRecord();
                record.setId((long) id);
                record.setName("Skill " + id);
                record.setTargetType("image");
                return record;
            });
        });
        StepVerifier.create(service.listUserSkills("image"))
                .expectNextMatches(response -> response.skills().size() == 241
                        && response.skills().getLast().id() == 241L)
                .verifyComplete();
    }

    @Test void detailPreservesCompletePromptAndAllThreeCategories() {
        var repository = mock(SkillRepository.class);
        var registry = mock(VideoWorkflowRegistry.class);
        when(registry.resolveWorkflowType(anyString())).thenReturn(Optional.empty());
        var service = new SkillService(repository, registry);
        String completePrompt = "用户约束\n### 文件：references/lighting.md\n" + "逐字保留完整参考资料。".repeat(40000) + "\n末尾约束必须保留";
        for (String type : java.util.List.of("image", "video", "canvasSettingGraph")) {
            var record = record(type, completePrompt);
            when(repository.findEnabledById(7L)).thenReturn(Mono.just(record));
            StepVerifier.create(service.getUserSkill(7L, type))
                    .assertNext(detail -> {
                        assertEquals(type, detail.targetType());
                        assertEquals(completePrompt, detail.systemPrompt());
                        assertEquals("9:16", detail.aspectRatio());
                        assertEquals("skill", detail.name());
                    }).verifyComplete();
        }
    }

    @Test void detailKeepsRegisteredWorkflowMetadata() {
        var repository = mock(SkillRepository.class);
        var registry = mock(VideoWorkflowRegistry.class);
        var record = record("video", "workflow: first-last-frame\n保留首尾帧确认步骤");
        when(repository.findEnabledById(7L)).thenReturn(Mono.just(record));
        when(registry.resolveWorkflowType(record.getSystemPrompt())).thenReturn(Optional.of("first-last-frame"));
        StepVerifier.create(new SkillService(repository, registry).getUserSkill(7L, null))
                .assertNext(detail -> assertEquals("first-last-frame", detail.workflowType())).verifyComplete();
    }

    @Test void detailRejectsDisabledDeletedMissingAndWrongCategory() {
        var repository = mock(SkillRepository.class);
        var service = new SkillService(repository, mock(VideoWorkflowRegistry.class));
        var disabled = record("image", "hidden"); disabled.setStatus(0);
        var deleted = record("image", "hidden"); deleted.setDeletedAt(OffsetDateTime.now());
        for (var record : java.util.List.of(disabled, deleted, record("video", "different category"))) {
            when(repository.findEnabledById(7L)).thenReturn(Mono.just(record));
            StepVerifier.create(service.getUserSkill(7L, "image"))
                    .expectErrorSatisfies(error -> assertEquals(ErrorCode.RESOURCE_NOT_FOUND, ((BusinessException) error).getCode())).verify();
        }
        when(repository.findEnabledById(7L)).thenReturn(Mono.empty());
        StepVerifier.create(service.getUserSkill(7L, "image"))
                .expectErrorSatisfies(error -> assertEquals(ErrorCode.RESOURCE_NOT_FOUND, ((BusinessException) error).getCode())).verify();
    }

    @Test void detailRejectsInvalidIdAndTypeBeforeQueryingRepository() {
        var repository = mock(SkillRepository.class);
        var service = new SkillService(repository, mock(VideoWorkflowRegistry.class));
        StepVerifier.create(service.getUserSkill(0L, null)).expectError(BusinessException.class).verify();
        StepVerifier.create(service.getUserSkill(null, "image")).expectError(BusinessException.class).verify();
        StepVerifier.create(service.getUserSkill(7L, "all")).expectError(BusinessException.class).verify();
        verifyNoInteractions(repository);
    }

    @Test void imageAndVideoCatalogsRemainLightweight() {
        var repository = mock(SkillRepository.class);
        var registry = mock(VideoWorkflowRegistry.class);
        when(registry.resolveWorkflowType(anyString())).thenReturn(Optional.empty());
        var service = new SkillService(repository, registry);
        when(repository.countSkills(any(), eq(true))).thenReturn(Mono.just(1L));
        for (String type : java.util.List.of("image", "video")) {
            when(repository.listSkills(any(), eq(true))).thenReturn(Flux.just(record(type, "full prompt must be read on demand")));
            StepVerifier.create(service.listUserSkills(type)).assertNext(response -> assertNull(response.skills().getFirst().systemPrompt())).verifyComplete();
        }
        when(repository.listSkills(any(), eq(true))).thenReturn(Flux.just(record("canvasSettingGraph", "existing snapshot compatibility")));
        StepVerifier.create(service.listUserSkills("canvasSettingGraph"))
                .assertNext(response -> assertEquals("existing snapshot compatibility", response.skills().getFirst().systemPrompt())).verifyComplete();
    }

    private static SkillRecords.SkillRecord record(String type, String prompt) {
        var record = new SkillRecords.SkillRecord();
        record.setId(7L); record.setName("skill"); record.setDescription("description");
        record.setTargetType(type); record.setSystemPrompt(prompt); record.setAspectRatio("9:16");
        record.setCoverUrl(""); record.setStatus(1); record.setSortOrder(100);
        return record;
    }
}
