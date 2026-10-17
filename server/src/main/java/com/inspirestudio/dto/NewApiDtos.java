package com.inspirestudio.dto;

import jakarta.validation.constraints.*;
import java.util.List;

public final class NewApiDtos {
    private NewApiDtos() {}
    public record Status(boolean connected, String message) {}
    public record Page<T>(List<T> items, int total) {}
    public record Channel(int id, String name, int type, String baseUrl, List<String> models,
                          int status, int priority, int weight, String modelMapping, String tag, String pluginKey) {}
    public record TaskPlugin(String key, String name, List<String> models) {}
    public record SaveChannel(Integer id, @NotBlank @Size(max=100) String name, @NotNull Integer type,
            @NotBlank @Size(max=2048) String baseUrl, @Size(max=65536) String apiKey,
            @NotEmpty @Size(max=2000) List<@NotBlank @Size(max=200) String> models,
            @Min(0) @Max(1000) int priority, @Min(1) @Max(1000) int weight,
            @Size(max=20000) String modelMapping, @Size(max=30) String pluginKey) {
        public SaveChannel(Integer id, String name, Integer type, String baseUrl, String apiKey,
                List<String> models, int priority, int weight, String modelMapping) {
            this(id, name, type, baseUrl, apiKey, models, priority, weight, modelMapping, null);
        }
    }
    public record FetchModels(Integer id, Integer type, String baseUrl, String apiKey, String pluginKey) {}
    public record IdRequest(@Min(1) int id) {}
    public record StatusRequest(@Min(1) int id, boolean enabled) {}
    public record RouteOption(int channelId, String channelName, int channelStatus, boolean active) {}
    public record ModelRoute(String model, List<RouteOption> channels, List<String> modelTypes) {}
    public record SelectRoute(@NotBlank @Size(max=200) String model, @Min(1) int channelId) {}
    public record CatalogModel(String id, List<String> connectedTypes) {}
    public record Importable(String id, String name, String apiFormat, int modelCount,
                             boolean supported, boolean migrated, String reason) {}
    public record ImportRequest(@NotBlank String channelId) {}
    public record SyncRequest(@NotEmpty @Size(max=100) List<@NotBlank String> models,
            @Pattern(regexp="text|image|video|audio") @NotNull String modelType,
            @NotEmpty List<String> capabilities, @NotNull @Min(0) Integer creditCost,
            List<String> resolutions, boolean setDefault) {}
    public record SyncResult(int added, int retained) {}
}
