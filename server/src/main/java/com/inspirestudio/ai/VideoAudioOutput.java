package com.inspirestudio.ai;

import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** Enforce an explicit silent output even when an upstream ignores the sound parameter. */
public final class VideoAudioOutput {
    private VideoAudioOutput() {}

    public static boolean shouldMute(AiTaskDtos.CreateAiTaskRequest request) {
        if (request.audioReferences() != null && !request.audioReferences().isEmpty()) return false;
        Map<String, Object> parameters = request.parameters() == null ? Map.of() : request.parameters();
        Object value = parameters.getOrDefault("generate_audio", parameters.get("with_audio"));
        return "false".equalsIgnoreCase(String.valueOf(value)) || "0".equals(String.valueOf(value));
    }

    public static Mono<GeneratedBinary> apply(GeneratedBinary binary, AiTaskDtos.CreateAiTaskRequest request, InspireProperties properties) {
        if (!shouldMute(request)) return Mono.just(binary);
        return Mono.fromCallable(() -> mute(binary, properties)).subscribeOn(Schedulers.boundedElastic());
    }

    static GeneratedBinary mute(GeneratedBinary binary, InspireProperties properties) throws Exception {
        Path directory = Files.createTempDirectory("inspire-video-silent-");
        Path input = directory.resolve("input.mp4"), output = directory.resolve("silent.mp4");
        Path log = directory.resolve("ffmpeg.log");
        Process process = null;
        try {
            Files.write(input, binary.data());
            var configuration = properties.getAi().getVideoComposition();
            String executable = configuration.getFfmpegExecutable();
            if (executable == null || executable.isBlank()) executable = "ffmpeg";
            process = new ProcessBuilder(List.of(executable, "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
                    "-i", input.toString(), "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", output.toString()))
                    .redirectErrorStream(true).redirectOutput(log.toFile()).start();
            if (!process.waitFor(Math.max(1, configuration.getExecutionTimeoutSeconds()), TimeUnit.SECONDS)
                    || process.exitValue() != 0 || !Files.exists(output) || Files.size(output) == 0) {
                throw new IllegalStateException("视频已生成，静音处理未完成，请重试保存");
            }
            return new GeneratedBinary(Files.readAllBytes(output), "video/mp4");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw interrupted;
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
            for (Path path : List.of(input, output, log, directory)) {
                try { Files.deleteIfExists(path); } catch (java.io.IOException ignored) { /* Do not mask processing failure. */ }
            }
        }
    }
}
