package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.EcommerceDtos;
import com.inspirestudio.dto.EcommerceSkillDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.repository.EcommerceRepository;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import reactor.core.publisher.Mono;

class EcommerceServiceTest {
    EcommerceRepository repository;
    PersistenceService media;
    AiTaskService tasks;
    EcommerceService service;
    EcommerceSkillService skills;
    AtomicReference<AiTaskDtos.CreateAiTaskRequest> created;

    @BeforeEach void setup() {
        repository = mock(EcommerceRepository.class);
        media = mock(PersistenceService.class);
        tasks = mock(AiTaskService.class);
        var users = mock(CurrentUserProvider.class);
        when(users.currentUserId()).thenReturn(Mono.just(7L));
        skills = mock(EcommerceSkillService.class);
        when(skills.resolveForGeneration(any(), any(), anyString(), anyString(), anyString())).thenAnswer(call ->
                Mono.just(new EcommerceSkillDtos.Skill("skill", 3, "商品技能", "说明", "text", List.of(call.getArgument(2, String.class)),
                        List.of(call.getArgument(3, String.class)), "当前所选技能的专用执行正文", 1, 0, "now", "now")));
        when(repository.saveSkillSnapshot(anyLong(), anyString(), any())).thenAnswer(call -> {
            EcommerceSkillDtos.Skill skill = call.getArgument(2);
            return Mono.just(new EcommerceDtos.Job(call.getArgument(1), null, "copy", "", "taobao", "now", skill.id(), skill.name(), skill.revision()));
        });
        service = new EcommerceService(repository, users, media, tasks, skills);
        created = new AtomicReference<>();
        when(repository.attachTask(anyLong(), anyString(), anyString())).thenReturn(Mono.empty());
        when(repository.markFailed(anyLong(), anyString(), anyString())).thenReturn(Mono.empty());
        when(tasks.listModels()).thenReturn(Mono.just(new AiTaskDtos.AiModelListResponse(List.of(
                new AiTaskDtos.AiModelOption("c::text", "Text", "text", "Test", "openai", true, 0),
                new AiTaskDtos.AiModelOption("c::image", "Image", "image", "Test", "openai", true, 1),
                new AiTaskDtos.AiModelOption("c::video", "Video", "video", "Test", "openai", true, 1, "generation", List.of("image-to-video"), null, null)
        ), List.of(), List.of(), List.of())));
        when(tasks.createTaskForUser(eq(7L), any(), any())).thenAnswer(call -> {
            created.set(call.getArgument(1));
            Function<AiTaskDtos.AiGenerationTaskResponse, Mono<Void>> attach = call.getArgument(2);
            return attach.apply(task()).thenReturn(task());
        });
        for (String key : List.of("owned-a", "owned-b")) {
            when(media.getMediaInfoForUser(7L, key)).thenReturn(Mono.just(new PersistenceDtos.UploadedMediaResponse(
                    key, "https://media.example.test/" + key + ".png", 123L, "image/png", 100, 100, null, null)));
        }
    }

    @Test void clampsPaginationAndPassesOnlyAuthenticatedOwner() {
        when(repository.listProjects(7L, 1, 100, "jd", "杯")).thenReturn(Mono.just(new EcommerceDtos.ProjectPage(List.of(), 0, 1, 100)));
        var result = service.listProjects(new EcommerceDtos.ListProjectsRequest(0, 9999, "jd", " 杯 ")).block();
        assertEquals(1, result.page()); assertEquals(100, result.pageSize());
        verify(repository).listProjects(7L, 1, 100, "jd", "杯");
    }

    @Test void savingCanonicalizesReferencesAndRetainsEditableData() {
        var data = product(true); data.put("draft", "编辑的正文"); data.put("imageGenerationMode", "text-to-image");
        var captured = new AtomicReference<EcommerceDtos.SaveProjectRequest>();
        when(repository.saveProject(eq(7L), any())).thenAnswer(call -> {
            EcommerceDtos.SaveProjectRequest request = call.getArgument(1); captured.set(request);
            return Mono.just(new EcommerceDtos.Project(request.id(), request.platform(), request.title(), request.data(), 1, "now", "now"));
        });
        service.saveProject(new EcommerceDtos.SaveProjectRequest(null, null, "jd", " 水杯 ", data)).block();
        assertEquals("水杯", captured.get().title());
        assertEquals("编辑的正文", captured.get().data().getString("draft"));
        assertEquals("text-to-image", captured.get().data().getString("imageGenerationMode"));
        var image = captured.get().data().getJSONArray("references").getJSONObject(0);
        assertEquals("image/png", image.getString("mimeType"));
        assertEquals("https://media.example.test/owned-a.png", image.getString("url"));
    }

    @ParameterizedTest @ValueSource(strings = {"taobao", "jd", "pinduoduo", "douyin", "xiaohongshu"})
    void textTaskUsesSavedFactsAndPlatformRules(String platform) {
        reserve(platform, "copy", false);
        var result = service.generate(request("copy", null, Map.of())).block();
        assertEquals("task", result.job().taskId());
        assertEquals("skill", result.job().skillId());
        assertEquals("商品技能", result.job().skillName());
        assertEquals(3, result.job().skillRevision());
        assertTrue(created.get().prompt().contains("当前所选技能的专用执行正文"));
        assertTrue(created.get().parameters().get("systemPrompt").toString().contains("当前所选技能的专用执行正文"));
        assertEquals("text", created.get().taskType());
        assertEquals("ecommerce", created.get().generationSource());
        assertTrue(created.get().prompt().contains("轻便水杯"));
        assertTrue(created.get().prompt().contains("不编造") || created.get().prompt().contains("不得编造"));
        assertTrue(created.get().prompt().contains("Markdown"));
        assertTrue(created.get().prompt().contains(switch(platform) {
            case "taobao" -> "淘宝/天猫"; case "jd" -> "京东"; case "pinduoduo" -> "拼多多"; case "douyin" -> "抖音"; default -> "小红书";
        }));
        assertEquals(List.of(), created.get().references());
        verify(repository).attachTask(7L, "job", "task");
    }

    @Test void switchingExistingProjectToTextToImagePreservesUnchangedExpiredReferences() {
        var current = project("taobao", false);
        current.data().put("references", JSON.parseArray("[{\"id\":\"old\",\"name\":\"product.png\",\"mimeType\":\"image/png\",\"storageKey\":\"expired\",\"url\":\"https://media.example.test/expired.png\"}]"));
        var submitted = JSON.parseObject(current.data().toJSONString());
        submitted.put("imageGenerationMode", "text-to-image");
        submitted.getJSONArray("references").getJSONObject(0).put("url", "https://untrusted.example.test/replacement.png");
        when(repository.getProject(7L, "project")).thenReturn(Mono.just(current));
        var captured = new AtomicReference<EcommerceDtos.SaveProjectRequest>();
        when(repository.saveProject(eq(7L), any())).thenAnswer(call -> {
            EcommerceDtos.SaveProjectRequest request = call.getArgument(1); captured.set(request);
            return Mono.just(new EcommerceDtos.Project(request.id(), request.platform(), request.title(), request.data(), 2, "now", "now"));
        });
        var saved = service.saveProject(new EcommerceDtos.SaveProjectRequest("project", 1, "taobao", "水杯", submitted)).block();
        assertEquals(2, saved.revision());
        assertEquals("text-to-image", captured.get().data().getString("imageGenerationMode"));
        var reference = captured.get().data().getJSONArray("references").getJSONObject(0);
        assertEquals("expired", reference.getString("storageKey"));
        assertEquals("https://media.example.test/expired.png", reference.getString("url"));
        verifyNoInteractions(media);
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void savingTextToImageStillValidatesNewOrChangedReferenceOwnership(boolean appended) {
        var current = project("taobao", true);
        var submitted = JSON.parseObject(current.data().toJSONString());
        submitted.put("imageGenerationMode", "text-to-image");
        if (appended) submitted.getJSONArray("references").add(JSONObject.of("id", "foreign", "name", "foreign.png", "mimeType", "image/png", "storageKey", "foreign-key"));
        else submitted.getJSONArray("references").getJSONObject(0).put("storageKey", "foreign-key");
        when(repository.getProject(7L, "project")).thenReturn(Mono.just(current));
        when(media.getMediaInfoForUser(7L, "foreign-key")).thenReturn(Mono.error(new BusinessException(4001, "媒体不存在")));
        assertThrows(BusinessException.class, () -> service.saveProject(new EcommerceDtos.SaveProjectRequest("project", 1, "taobao", "水杯", submitted)).block());
        verify(media).getMediaInfoForUser(7L, "foreign-key");
        verify(repository, never()).saveProject(anyLong(), any());
    }

    @Test void staleProjectRevisionCannotReuseSavedReferencesWhenSwitchingToTextToImage() {
        var current = project("taobao", true);
        var submitted = JSON.parseObject(current.data().toJSONString());
        submitted.put("imageGenerationMode", "text-to-image");
        when(repository.getProject(7L, "project")).thenReturn(Mono.just(current));
        var error = assertThrows(BusinessException.class, () -> service.saveProject(new EcommerceDtos.SaveProjectRequest("project", 2, "taobao", "水杯", submitted)).block());
        assertTrue(error.getMessage().contains("项目已被其他页面更新"));
        verify(repository, never()).saveProject(anyLong(), any());
        verifyNoInteractions(media);
    }

    @Test void videoUsesOneCanonicalFirstFrameAndExistingTaskMode() {
        reserve("douyin", "video", true);
        service.generate(request("video", null, Map.of("seconds", "5", "resolution", "720p", "watermark", false))).block();
        assertEquals("video", created.get().taskType());
        assertEquals("image-to-video", created.get().videoGenerationMode());
        assertEquals(1, created.get().references().size());
        var reference = created.get().references().getFirst();
        assertEquals("owned-a", reference.storageKey()); assertNull(reference.url());
        assertEquals("image/png", reference.mimeType()); assertEquals("first_frame", reference.role());
        assertEquals(5, created.get().parameters().get("seconds"));
        assertEquals(false, created.get().parameters().get("watermark"));
        assertEquals("9:16", created.get().parameters().get("size"));
        assertTrue(created.get().prompt().contains("不生成海报或脚本文本"));
    }

    @Test void explicitImageToImageRequiresOwnedProductReferencesBeforeTaskCreation() {
        reserve("taobao", "image", false);
        var error = assertThrows(BusinessException.class, () -> service.generate(imageRequest("hero", "image-to-image")).block());
        assertTrue(error.getMessage().contains("商品参考图"));
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any());
        verify(repository).markFailed(eq(7L), eq("job"), contains("商品参考图"));
    }

    @ParameterizedTest @ValueSource(strings = {"hero", "scene", "detail"})
    void explicitTextToImageUsesProductTextAndOverridesReferenceBasedSkillRequirements(String variant) {
        reserve("taobao", "image", false);
        when(skills.resolveForGeneration(any(), any(), anyString(), anyString(), anyString())).thenReturn(Mono.just(
                new EcommerceSkillDtos.Skill("skill", 3, "商品摄影", "说明", "image", List.of("taobao"), List.of(variant),
                        "必须上传商品参考图；严格保留参考图中实物外观；没有参考图时先要求补图。", 1, 0, "now", "now")));
        service.generate(imageRequest(variant, "text-to-image")).block();
        assertEquals("image", created.get().taskType());
        assertEquals(List.of(), created.get().references());
        assertEquals("ecommerce", created.get().generationSource());
        assertFalse(created.get().parameters().containsKey("imageGenerationMode"));
        assertEquals("1:1", created.get().parameters().get("size"));
        assertEquals(false, created.get().parameters().get("watermark"));
        String prompt = created.get().prompt();
        assertTrue(prompt.contains("轻便水杯"));
        assertTrue(prompt.contains("本次模式为文生图"));
        assertTrue(prompt.contains("优先于通用技能中与本次模式冲突的要求及示例"));
        assertTrue(prompt.contains("不得因此拒绝生成或要求补图"));
        assertTrue(prompt.contains("非事实性外观设计"));
        assertTrue(prompt.contains("不得虚构品牌、品牌标识、认证、价格或功能"));
        assertTrue(prompt.contains(switch (variant) {
            case "scene" -> "商品场景概念图"; case "detail" -> "商品细节概念图"; default -> "商品主图概念图";
        }));
        assertFalse(prompt.contains("保留真实商品上的品牌标识"));
        assertFalse(prompt.contains("缺失事实标为待补充"));
        verifyNoInteractions(media);
    }

    @Test void explicitTextToImageOverridesSavedModeAndNeverParsesOrResolvesSavedReferences() {
        var project = project("taobao", true);
        project.data().put("imageGenerationMode", "image-to-image");
        project.data().put("references", "malformed-or-expired-attachments");
        reserve(project, "image");
        service.generate(imageRequest("hero", "text-to-image")).block();
        assertEquals(List.of(), created.get().references());
        assertEquals("malformed-or-expired-attachments", project.data().get("references"));
        verifyNoInteractions(media);
    }

    @Test void explicitTextToImageDoesNotSendValidSavedProductImages() {
        reserve("taobao", "image", true);
        service.generate(imageRequest("hero", "text-to-image")).block();
        assertEquals(List.of(), created.get().references());
        verifyNoInteractions(media);
    }

    @Test void legacyRequestWithoutImagesAutomaticallyUsesTextToImage() {
        reserve("taobao", "image", false);
        service.generate(request("image", "hero", Map.of())).block();
        assertTrue(created.get().prompt().contains("本次模式为文生图"));
        assertEquals(List.of(), created.get().references());
        verifyNoInteractions(media);
    }

    @Test void legacyRequestWithImagesRetainsImageToImageBehavior() {
        reserve("taobao", "image", true);
        service.generate(request("image", "hero", Map.of())).block();
        assertTrue(created.get().prompt().contains("本次模式为图生图"));
        assertTrue(created.get().prompt().contains("保留真实商品上的品牌标识"));
        assertEquals(List.of("owned-a", "owned-b"), created.get().references().stream().map(AiTaskDtos.AiTaskMediaReference::storageKey).toList());
        assertTrue(created.get().references().stream().allMatch(ref -> ref.url() == null));
        verify(media).getMediaInfoForUser(7L, "owned-a");
        verify(media).getMediaInfoForUser(7L, "owned-b");
    }

    @Test void savedTextToImageModeIsUsedWhenRequestDoesNotSpecifyMode() {
        var project = project("taobao", true);
        project.data().put("imageGenerationMode", "text-to-image");
        project.data().put("references", "malformed-saved-attachments");
        reserve(project, "image");
        service.generate(request("image", "detail", Map.of())).block();
        assertEquals(List.of(), created.get().references());
        assertTrue(created.get().prompt().contains("商品细节概念图"));
        verifyNoInteractions(media);
    }

    @Test void savedImageToImageModeRequiresReferencesAndExplicitModeCanOverrideIt() {
        var project = project("taobao", false);
        project.data().put("imageGenerationMode", "image-to-image");
        reserve(project, "image");
        assertThrows(BusinessException.class, () -> service.generate(request("image", "hero", Map.of())).block());
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any());
        service.generate(imageRequest("hero", "text-to-image")).block();
        assertEquals(List.of(), created.get().references());
    }

    @Test void explicitImageToImageOverridesSavedTextToImageMode() {
        var project = project("taobao", true);
        project.data().put("imageGenerationMode", "text-to-image");
        reserve(project, "image");
        service.generate(imageRequest("scene", "image-to-image")).block();
        assertEquals(2, created.get().references().size());
        assertTrue(created.get().prompt().contains("同一商品"));
        assertFalse(created.get().parameters().containsKey("imageGenerationMode"));
    }

    @ParameterizedTest @ValueSource(strings = {"text-to-image", "image-to-image"})
    void defaultImageModelSelectionRespectsDeclaredModeCapabilities(String mode) {
        reserve("taobao", "image", true);
        String oppositeMode = "text-to-image".equals(mode) ? "image-to-image" : "text-to-image";
        when(tasks.listModels()).thenReturn(Mono.just(new AiTaskDtos.AiModelListResponse(List.of(
                imageModel("wrong-default", true, List.of(oppositeMode)), imageModel("compatible", false, List.of(mode))
        ), List.of(), List.of(), List.of())));
        service.generate(imageRequest("hero", mode)).block();
        assertEquals("compatible", created.get().model());
    }

    @ParameterizedTest @ValueSource(strings = {"text-to-image", "image-to-image"})
    void explicitlySelectedUnsupportedImageModeFailsBeforeTaskCreation(String mode) {
        reserve("taobao", "image", true);
        String oppositeMode = "text-to-image".equals(mode) ? "image-to-image" : "text-to-image";
        when(tasks.listModels()).thenReturn(Mono.just(new AiTaskDtos.AiModelListResponse(List.of(
                imageModel("unsupported", true, List.of(oppositeMode)), imageModel("compatible", false, List.of(mode))
        ), List.of(), List.of(), List.of())));
        assertThrows(BusinessException.class, () -> service.generate(new EcommerceDtos.GenerateRequest(
                "project", "request", "image", "hero", "unsupported", Map.of(), null, null, mode)).block());
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any());
    }

    @Test void videoStillRequiresReferencesRegardlessOfSavedImageMode() {
        var project = project("douyin", false);
        project.data().put("imageGenerationMode", "text-to-image");
        reserve(project, "video");
        var error = assertThrows(BusinessException.class, () -> service.generate(request("video", null, Map.of())).block());
        assertTrue(error.getMessage().contains("商品参考图"));
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any());
    }

    @Test void textTasksStillResolveSavedReferencesRegardlessOfSavedImageMode() {
        var project = project("taobao", true);
        project.data().put("imageGenerationMode", "text-to-image");
        reserve(project, "copy");
        service.generate(request("copy", null, Map.of())).block();
        assertEquals(List.of(), created.get().references());
        assertFalse(created.get().prompt().contains("本次模式为文生图"));
        verify(media).getMediaInfoForUser(7L, "owned-a");
        verify(media).getMediaInfoForUser(7L, "owned-b");
    }

    @Test void crossUserReferenceCannotCreateOrChargeTask() {
        reserve("taobao", "image", true);
        when(media.getMediaInfoForUser(7L, "owned-a")).thenReturn(Mono.error(new BusinessException(4001, "媒体不存在")));
        assertThrows(BusinessException.class, () -> service.generate(request("image", "hero", Map.of())).block());
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any());
    }

    @Test void mediaUsesCompactVisualRulesInsteadOfCopyFormattingInstructions() {
        reserve("douyin", "video", true);
        service.generate(request("video", null, Map.of("seconds", 5, "resolution", "720p"))).block();
        assertTrue(created.get().prompt().length() < 2500);
        assertFalse(created.get().prompt().contains("Markdown"));
        assertFalse(created.get().prompt().contains("详情文案任务"));
        assertTrue(created.get().prompt().contains("品牌标识"));
    }

    @Test void oversizedVideoInputIsRejectedBeforeCreatingPaidTask() {
        var project = project("douyin", true);
        project.data().getJSONObject("product").put("sellingPoints", "事实".repeat(2500));
        when(repository.reserveJob(eq(7L), any(), any())).thenAnswer(call -> Mono.just(new EcommerceRepository.Reservation(
                project, new EcommerceRepository.StoredJob(new EcommerceDtos.Job("job", null, "video", "", "douyin", "now"), call.getArgument(2), null), true)));
        var error = assertThrows(BusinessException.class, () -> service.generate(request("video", null, Map.of("seconds", 5, "resolution", "720p"))).block());
        assertTrue(error.getMessage().contains("精简卖点"));
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any());
        verify(repository).markFailed(eq(7L), eq("job"), contains("5000"));
    }

    @Test void repeatedRequestReturnsOriginalTaskWithoutCreatingAgain() {
        var request = request("copy", null, Map.of());
        var fingerprint = JSONObject.from(EcommerceService.normalizeGenerate(request));
        var original = new EcommerceDtos.Job("job", "task", "copy", "", "jd", "now");
        when(repository.reserveJob(eq(7L), any(), any())).thenReturn(Mono.just(new EcommerceRepository.Reservation(
                project("jd", false), new EcommerceRepository.StoredJob(original, fingerprint, null), false)));
        when(tasks.getTaskForUser(7L, "task")).thenReturn(Mono.just(task()));
        assertEquals("task", service.generate(request).block().task().id());
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any()); verifyNoInteractions(media, skills);
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void legacyImageRetryAcceptsAbsentOrNullModeInStoredFingerprint(boolean storesNull) {
        var request = request("image", "hero", Map.of());
        var fingerprint = JSONObject.from(EcommerceService.normalizeGenerate(request));
        if (storesNull) fingerprint.put("imageGenerationMode", null); else fingerprint.remove("imageGenerationMode");
        var project = project("taobao", false);
        project.data().put("imageGenerationMode", "text-to-image");
        var original = new EcommerceDtos.Job("job", "task", "image", "hero", "taobao", "now");
        when(repository.reserveJob(eq(7L), any(), any())).thenReturn(Mono.just(new EcommerceRepository.Reservation(
                project, new EcommerceRepository.StoredJob(original, fingerprint, null), false)));
        when(tasks.getTaskForUser(7L, "task")).thenReturn(Mono.just(task()));
        assertEquals("task", service.generate(request).block().task().id());
        verify(tasks, never()).createTaskForUser(anyLong(), any(), any());
        verifyNoInteractions(media, skills);
    }

    @Test void changingImageModeUnderSameRequestIdIsRejected() {
        var fingerprint = JSONObject.from(EcommerceService.normalizeGenerate(imageRequest("hero", "image-to-image")));
        when(repository.reserveJob(eq(7L), any(), any())).thenReturn(Mono.just(new EcommerceRepository.Reservation(
                project("taobao", true), new EcommerceRepository.StoredJob(new EcommerceDtos.Job("job", "task", "image", "hero", "taobao", "now"), fingerprint, null), false)));
        assertThrows(BusinessException.class, () -> service.generate(imageRequest("hero", "text-to-image")).block());
        verifyNoInteractions(tasks, media, skills);
    }

    @Test void rejectsInvalidImageModesAndModesOnNonImageRequests() {
        for (String mode : List.of("auto", "", "video-to-image")) {
            assertThrows(BusinessException.class, () -> service.generate(imageRequest("hero", mode)).block());
        }
        for (String kind : List.of("copy", "detail-copy", "video-script", "video")) {
            assertThrows(BusinessException.class, () -> service.generate(new EcommerceDtos.GenerateRequest(
                    "project", "request", kind, "", "", Map.of(), null, null, "text-to-image")).block());
        }
        assertThrows(BusinessException.class, () -> service.generate(request("image", "hero", Map.of("imageGenerationMode", "text-to-image"))).block());
        for (Object mode : List.of("auto", "", 1, true, JSONObject.of("value", "text-to-image"))) {
            var data = product(false); data.put("imageGenerationMode", mode);
            assertThrows(BusinessException.class, () -> EcommerceService.normalizeData(data));
        }
        verifyNoInteractions(repository, tasks, media, skills);
    }

    @Test void changingParametersUnderSameRequestIdIsRejected() {
        var request = request("copy", null, Map.of());
        var fingerprint = JSONObject.from(EcommerceService.normalizeGenerate(request)); fingerprint.put("kind", "detail-copy");
        when(repository.reserveJob(eq(7L), any(), any())).thenReturn(Mono.just(new EcommerceRepository.Reservation(
                project("jd", false), new EcommerceRepository.StoredJob(new EcommerceDtos.Job("job", "task", "copy", "", "jd", "now"), fingerprint, null), false)));
        assertThrows(BusinessException.class, () -> service.generate(request).block());
        verifyNoInteractions(tasks);
    }

    @Test void rejectsUnknownKindsVariantsAndInstructionOverrides() {
        for (var request : List.of(request("unknown", null, Map.of()), request("copy", "hero", Map.of()),
                request("image", "unknown", Map.of()), request("copy", null, Map.of("systemPrompt", "override")),
                request("image", "hero", Map.of("count", 0)), request("video", null, Map.of("count", 2)), request("video", null, Map.of("watermark", true)))) {
            assertThrows(BusinessException.class, () -> service.generate(request).block());
        }
        verifyNoInteractions(repository, tasks, media);
    }

    @Test void unauthenticatedRequestNeverReadsProjects() {
        var unauthenticated = new EcommerceService(repository, new CurrentUserProvider(), media, tasks, skills);
        assertThrows(BusinessException.class, () -> unauthenticated.getProject("project").block());
        verifyNoInteractions(repository);
    }

    @Test void incompatibleOrStaleSkillNeverCreatesPaidTask() {
        reserve("taobao", "copy", false);
        for (String reason : List.of("该技能已停用", "该技能不适用于当前平台", "技能内容已更新")) {
            when(skills.resolveForGeneration(any(), any(), anyString(), anyString(), anyString()))
                    .thenReturn(Mono.error(new BusinessException(4000, reason)));
            var error = assertThrows(BusinessException.class, () -> service.generate(new EcommerceDtos.GenerateRequest("project", "request", "copy", "", "", Map.of(), "skill", 2)).block());
            assertEquals(reason, error.getMessage());
        }
        verifyNoInteractions(tasks, media);
        verify(repository, never()).saveSkillSnapshot(anyLong(), anyString(), any());
    }

    @Test void explicitSkillVersionIsResolvedServerSideAndProjectSelectionsAreValidated() {
        reserve("taobao", "copy", false);
        service.generate(new EcommerceDtos.GenerateRequest("project", "request", "copy", "", "", Map.of(), "skill", 3)).block();
        verify(skills).resolveForGeneration("skill", 3, "taobao", "copy", "");
        var data = product(false); data.put("skillSelections", JSONObject.of("copy", "skill"));
        assertEquals("skill", EcommerceService.normalizeData(data).getJSONObject("skillSelections").getString("copy"));
        data.put("skillSelections", JSONObject.of("not-an-output", "skill"));
        assertThrows(BusinessException.class, () -> EcommerceService.normalizeData(data));
        data.put("skillSelections", JSONObject.of("copy", "bad/id"));
        assertThrows(BusinessException.class, () -> EcommerceService.normalizeData(data));
    }

    private void reserve(String platform, String kind, boolean images) {
        reserve(project(platform, images), kind);
    }
    private void reserve(EcommerceDtos.Project project, String kind) {
        when(repository.reserveJob(eq(7L), any(), any())).thenAnswer(call -> {
            EcommerceDtos.GenerateRequest request = call.getArgument(1);
            var job = new EcommerceDtos.Job("job", null, kind, request.variant(), project.platform(), "now");
            return Mono.just(new EcommerceRepository.Reservation(project, new EcommerceRepository.StoredJob(job, call.getArgument(2), null), true));
        });
    }
    private static EcommerceDtos.GenerateRequest imageRequest(String variant, String mode) {
        return new EcommerceDtos.GenerateRequest("project", "request", "image", variant, null, Map.of(), null, null, mode);
    }
    private static AiTaskDtos.AiModelOption imageModel(String value, boolean defaultModel, List<String> capabilities) {
        return new AiTaskDtos.AiModelOption(value, value, "image", "Test", "custom", defaultModel, 1, "generation", capabilities, null, null);
    }
    private static EcommerceDtos.GenerateRequest request(String kind, String variant, Map<String, Object> parameters) {
        return new EcommerceDtos.GenerateRequest("project", "request", kind, variant, null, parameters);
    }
    private static EcommerceDtos.Project project(String platform, boolean images) {
        return new EcommerceDtos.Project("project", platform, "水杯", product(images), 1, "now", "now");
    }
    private static JSONObject product(boolean images) {
        return JSON.parseObject("{\"product\":{\"name\":\"轻便水杯\",\"brand\":\"真实品牌\",\"sellingPoints\":\"便于携带\"},\"references\":" + (images
                ? "[{\"id\":\"a\",\"name\":\"a.png\",\"mimeType\":\"video/mp4\",\"storageKey\":\"owned-a\",\"url\":\"http://localhost/private\"},{\"id\":\"b\",\"name\":\"b.png\",\"storageKey\":\"owned-b\"}]"
                : "[]") + "}");
    }
    private static AiTaskDtos.AiGenerationTaskResponse task() {
        return new AiTaskDtos.AiGenerationTaskResponse("task", "text", "model", "Test", "pending", 0, new JSONObject(), new JSONObject(), "", null, null, "now", "now");
    }
}
