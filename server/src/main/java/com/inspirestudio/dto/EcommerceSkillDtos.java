package com.inspirestudio.dto;

import java.util.List;

/** Administrator-owned commerce instruction catalog. */
public final class EcommerceSkillDtos {
    private EcommerceSkillDtos() {}
    public record Skill(String id, int revision, String name, String description, String type,
                        List<String> platforms, List<String> outputTypes, String systemPrompt,
                        int status, int sortOrder, String createdAt, String updatedAt) {}
    public record SkillList(List<Skill> skills) {}
    public record SkillPage(List<Skill> items, long total) {}
    public record ListRequest(String keyword, String type, Integer status, Integer page, Integer pageSize) {}
    public record SaveRequest(String id, Integer revision, String name, String description, String type,
                              List<String> platforms, List<String> outputTypes, String systemPrompt,
                              Integer status, Integer sortOrder) {}
    public record StatusRequest(String id, Integer revision, Integer status) {}
    public record DeleteRequest(String id, Integer revision) {}
}
