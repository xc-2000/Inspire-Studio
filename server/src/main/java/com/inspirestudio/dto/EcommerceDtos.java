package com.inspirestudio.dto;

import com.alibaba.fastjson2.JSONObject;
import java.util.List;
import java.util.Map;

/** Independent commerce projects and their durable generation jobs. */
public final class EcommerceDtos {
    private EcommerceDtos() {}

    public record ListProjectsRequest(Integer page, Integer pageSize, String platform, String keyword) {}
    public record SaveProjectRequest(String id, Integer revision, String platform, String title, JSONObject data) {}
    public record DeleteProjectRequest(String id, Integer revision) {}
    public record Project(String id, String platform, String title, JSONObject data, int revision,
                          String createdAt, String updatedAt) {}
    public record ProjectPage(List<Project> items, long total, int page, int pageSize) {}
    public record GenerateRequest(String projectId, String requestId, String kind, String variant,
                                  String model, Map<String, Object> parameters, String skillId, Integer skillRevision,
                                  String imageGenerationMode) {
        public GenerateRequest(String projectId, String requestId, String kind, String variant, String model, Map<String, Object> parameters) {
            this(projectId, requestId, kind, variant, model, parameters, null, null, null);
        }
        public GenerateRequest(String projectId, String requestId, String kind, String variant, String model, Map<String, Object> parameters,
                               String skillId, Integer skillRevision) {
            this(projectId, requestId, kind, variant, model, parameters, skillId, skillRevision, null);
        }
    }
    public record Job(String id, String taskId, String kind, String variant, String platform, String createdAt,
                      String skillId, String skillName, Integer skillRevision) {
        public Job(String id, String taskId, String kind, String variant, String platform, String createdAt) {
            this(id, taskId, kind, variant, platform, createdAt, null, null, null);
        }
    }
    public record GenerateResponse(Job job, AiTaskDtos.AiGenerationTaskResponse task) {}
    public record JobList(List<Job> jobs) {}
}
