package com.inspirestudio.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;

/** 内容发布接口数据结构。 */
public final class SocialPublishingDtos {

    private SocialPublishingDtos() {
    }

    public record AccountItem(Long id, String platform, String displayName, boolean enabled,
                              boolean credentialsConfigured, String lastCheckStatus,
                              String lastCheckMessage, String lastCheckedAt, String createdAt, String updatedAt) {
    }

    public record SaveAccountRequest(Long id,
                                     @NotBlank(message = "平台不能为空") String platform,
                                     @NotBlank(message = "账号名称不能为空") @Size(max = 80) String displayName,
                                     String credentials,
                                     Boolean enabled) {
    }

    public record AccountIdRequest(@NotNull(message = "账号ID不能为空") Long id) {
    }

    public record QrLoginStartRequest(@NotBlank(message = "平台不能为空") String platform,
                                      Long accountId,
                                      @Size(max = 80) String displayName,
                                      Boolean enabled) {
    }

    public record QrLoginSessionRequest(@NotBlank(message = "扫码会话不能为空") String sessionId) {
    }

    public record QrLoginActionRequest(@NotBlank String sessionId, @NotNull Map<String, Object> action) {
    }

    public record QrLoginResponse(String sessionId, String platform, String status, String message,
                                  String qrCodeDataUrl, Long expiresAt, AccountItem account) {
    }

    public record CreateTaskRequest(@NotNull(message = "账号ID不能为空") Long accountId,
                                    @NotBlank(message = "素材类型不能为空") String mediaType,
                                    @Size(max = 200) String title,
                                    @Size(max = 5000) String description,
                                    @Size(min = 1, max = 20, message = "请选择1至20个素材") List<String> mediaUrls,
                                    String coverUrl,
                                    List<String> topics,
                                    @NotBlank(message = "发布方式不能为空") String publishMode,
                                    String visibility,
                                    Boolean allowDownload,
                                    Boolean transcode) {
    }

    public record TaskItem(String id, Long accountId, String platform, String mediaType, String title,
                           String description, List<String> mediaUrls, String coverUrl, List<String> topics,
                           String publishMode, String status, Map<String, Object> resultData,
                           String errorMessage, String createdAt, String startedAt, String finishedAt) {
    }

    public record TaskListResponse(List<TaskItem> items, long total) {
    }

    public record TaskStatusItem(String id, String status, Map<String, Object> resultData,
                                 String errorMessage, String startedAt, String finishedAt) {
    }
}
