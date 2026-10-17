package com.inspirestudio.service;
import com.inspirestudio.dto.AiTaskDtos;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class ImageEditMaskSupportTest {
    @Test void rejectsUnsupportedChannelsBeforeTaskCreation() {
        var request = new AiTaskDtos.CreateAiTaskRequest("image", "编辑", "model", Map.of("editMask", Map.of("storageKey","image:mask","mimeType","image/png")), List.of(new AiTaskDtos.AiTaskMediaReference("image","source","image/png","image:source",null)), List.of(),"canvas");
        assertDoesNotThrow(()->ImageEditMaskSupport.validate(request,"openai",false));
        assertThrows(RuntimeException.class,()->ImageEditMaskSupport.validate(request,"gemini",false));
        assertThrows(RuntimeException.class,()->ImageEditMaskSupport.validate(request,"openai",true));
    }
}
