package com.inspirestudio.service;

import com.alibaba.fastjson2.JSON;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.AiTaskDtos;

/** Explicitly gate mask editing before charging; unsupported adapters must never ignore it. */
public final class ImageEditMaskSupport {
    private ImageEditMaskSupport() {}
    public static void validate(AiTaskDtos.CreateAiTaskRequest request, String apiFormat, boolean custom) {
        if (!"image".equals(request.taskType()) || custom || !"openai".equals(apiFormat)) invalid("当前渠道不支持局部蒙版，请选择支持 images/edits 蒙版的 OpenAI 兼容图片渠道");
        if (request.references() == null || request.references().size() != 1) invalid("蒙版编辑需要且仅支持一张参考图片");
        try {
            var mask = JSON.parseObject(JSON.toJSONString(request.parameters().get("editMask")), AiTaskDtos.AiTaskMediaReference.class);
            if (mask == null || !"image/png".equals(mask.mimeType()) || mask.storageKey() == null || mask.storageKey().isBlank()) invalid("蒙版必须先上传为 PNG 图片");
        } catch (BusinessException e) { throw e; }
        catch (Exception e) { invalid("蒙版参数无效"); }
    }
    private static void invalid(String message) { throw new BusinessException(ErrorCode.PARAM_INVALID, message); }
}
