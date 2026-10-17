package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.dto.ImagePromptReverseDtos;
import com.inspirestudio.dto.PersistenceDtos;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

class ImagePromptReverseServiceTest {
    AiTaskService tasks;
    PersistenceService persistence;
    CurrentUserProvider users;
    ImagePromptReverseService service;

    @BeforeEach
    void setup() {
        tasks = mock(AiTaskService.class);
        persistence = mock(PersistenceService.class);
        users = mock(CurrentUserProvider.class);
        when(users.currentUserId()).thenReturn(Mono.just(7L));
        service = new ImagePromptReverseService(tasks, persistence, users);
    }

    @Test
    void createsBilingualTaskWithCanonicalOwnedImageAndFullRules() {
        var reference = new AiTaskDtos.AiTaskMediaReference("id", "input.png", "video/mp4", "owned", "http://localhost/private");
        when(persistence.getMediaInfoForUser(7L, "owned")).thenReturn(Mono.just(new PersistenceDtos.UploadedMediaResponse("owned", "https://media.example.test/input.png", 123L, "image/png", 100, 100, null, null)));
        configureModels();
        AtomicReference<AiTaskDtos.CreateAiTaskRequest> captured = new AtomicReference<>();
        when(tasks.createTaskForUser(eq(7L), any(), any())).thenAnswer(call -> { captured.set(call.getArgument(1)); return Mono.empty(); });

        service.reverseImage(new ImagePromptReverseDtos.ReverseImageRequest(reference, null, null)).block();

        var task = captured.get();
        assertEquals("text", task.taskType());
        assertEquals("image-prompt-reverse", task.generationSource());
        assertEquals("channel::vision-model", task.model());
        assertEquals("image/png", task.references().get(0).mimeType());
        assertNull(task.references().get(0).url());
        assertEquals("owned", task.references().get(0).storageKey());
        assertTrue(task.prompt().contains("450—700"));
        assertTrue(task.prompt().contains("非可信视觉数据"));
        assertTrue(task.prompt().contains("3—5"));
        assertTrue(task.prompt().contains("画风指纹"));
        assertTrue(task.prompt().contains("10—15"));
        assertTrue(task.prompt().contains("promptEn"));
    }

    @Test
    void excludesModelsWithoutExplicitVisionAndUnsupportedOrCustomModels() {
        configureModels();
        var result = service.listModels().block();
        assertEquals(List.of("channel::vision-model"), result.textModels());
        assertEquals(1, result.models().size());
        assertFalse(com.alibaba.fastjson2.JSON.toJSONString(result).contains("apiKey"));
        assertThrows(BusinessException.class, () -> ImagePromptReverseService.selectModel(result.models(), "channel::text-model"));
    }

    @Test
    void rejectsMissingAndBrowserOnlyImagesBeforeReadingModelsOrCreatingTask() {
        assertError(null, "选择");
        assertError(new AiTaskDtos.AiTaskMediaReference("i", "x", "image/png", null, "blob:temporary"), "blob");
        assertError(new AiTaskDtos.AiTaskMediaReference("i", "x", "image/png", null, "http://127.0.0.1/private"), "先上传");
        verifyNoInteractions(tasks, persistence);
    }

    @Test
    void rejectsForeignMediaAndNonImagesBeforeCreatingTask() {
        when(persistence.getMediaInfoForUser(7L, "foreign")).thenReturn(Mono.empty());
        assertError(new AiTaskDtos.AiTaskMediaReference("i", "x", "image/png", "foreign", null), "不属于");
        when(persistence.getMediaInfoForUser(7L, "video")).thenReturn(Mono.just(new PersistenceDtos.UploadedMediaResponse("video", "https://media.example.test/video", 12L, "video/mp4", 10, 10, null, null)));
        assertError(new AiTaskDtos.AiTaskMediaReference("i", "x", "image/png", "video", null), "格式");
        verifyNoInteractions(tasks);
    }

    @Test
    void noVisionModelsFailsClearlyAndLanguageIsValidated() {
        assertThrows(BusinessException.class, () -> ImagePromptReverseService.selectModel(List.of(), null));
        BusinessException error = assertThrows(BusinessException.class, () -> service.reverseImage(new ImagePromptReverseDtos.ReverseImageRequest(
                new AiTaskDtos.AiTaskMediaReference("i", "x", "image/png", "owned", null), null, "unknown")).block());
        assertTrue(error.getMessage().contains("输出语言"));
        assertTrue(ImagePromptReverseService.languageInstruction("en").contains("promptZh为空字符串"));
        assertTrue(ImagePromptReverseService.languageInstruction("zh").contains("promptEn为空字符串"));
    }

    private void assertError(AiTaskDtos.AiTaskMediaReference image, String message) {
        BusinessException error = assertThrows(BusinessException.class, () -> service.reverseImage(new ImagePromptReverseDtos.ReverseImageRequest(image, null, null)).block());
        assertTrue(error.getMessage().contains(message), error.getMessage());
    }

    private void configureModels() {
        var vision = new AiTaskDtos.AiModelOption("channel::vision-model", "Vision", "text", "Test", "openai", false, 1, "generation", List.of("vision"), null, null);
        var text = new AiTaskDtos.AiModelOption("channel::text-model", "Text", "text", "Test", "openai", true, 1, "generation");
        var custom = new AiTaskDtos.AiModelOption("channel::custom-model", "Custom", "text", "Test", "custom", false, 1, "generation", List.of("vision"), null, null);
        when(tasks.listModels()).thenReturn(Mono.just(new AiTaskDtos.AiModelListResponse(List.of(vision, text, custom), List.of(), List.of(), List.of(vision.value(), text.value(), custom.value()))));
        when(persistence.getPlatformModelConfigs()).thenReturn(Mono.just(List.of(
                new PersistenceDtos.ModelConfig("v", "channel", "vision-model", "text", List.of("vision"), false, 1, 1, false, "high"),
                new PersistenceDtos.ModelConfig("t", "channel", "text-model", "text", List.of(), true, 0, 1, false, "high"),
                new PersistenceDtos.ModelConfig("c", "channel", "custom-model", "text", List.of("vision"), false, 2, 1, false, "high"))));
    }
}
