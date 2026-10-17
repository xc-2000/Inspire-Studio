package com.inspirestudio.task;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/** 从已下载的本地视频抽取真实封面，复用服务端的视频工具配置。 */
@Component
@RequiredArgsConstructor
public class VideoCoverMediaProcessor {
    private static final int MAXIMUM_OUTPUT_CHARACTERS = 8192;
    private static final String SINGLE_FILE_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,flv,ogg";
    private final InspireProperties properties;

    /** 封面最长边为640像素，返回原视频与封面的实际尺寸。调用者须在boundedElastic调度器执行。 */
    public CoverResult extract(Path source, Path output) {
        return extract(source, output, false);
    }

    /** 连续镜头使用接近视频末尾的真实画面，失败时不得拿首帧冒充尾帧。 */
    public CoverResult extractTail(Path source, Path output) {
        return extract(source, output, true);
    }

    private CoverResult extract(Path source, Path output, boolean tail) {
        JSONObject probe;
        try {
            probe = JSON.parseObject(run(List.of(
                    executable(properties.getAi().getVideoComposition().getFfprobeExecutable(), "ffprobe"),
                    "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", SINGLE_FILE_FORMATS,
                    "-select_streams", "v:0",
                    "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration", "-of", "json",
                    source.toAbsolutePath().toString())));
        } catch (BusinessException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无法读取视频画面信息");
        }
        JSONArray streams = probe == null ? null : probe.getJSONArray("streams");
        JSONObject stream = streams == null || streams.isEmpty() ? null : streams.getJSONObject(0);
        int width = stream == null ? 0 : stream.getIntValue("width");
        int height = stream == null ? 0 : stream.getIntValue("height");
        if (width < 1 || height < 1) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "该媒体没有有效的视频画面");
        }
        if (isQuarterTurn(stream)) { int originalWidth = width; width = height; height = originalWidth; }
        JSONObject format = probe.getJSONObject("format");
        double duration = parseNumber(format == null ? null : format.getString("duration"));
        if (tail && (!Double.isFinite(duration) || duration <= 0)) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无法确定视频时长，不能提取衔接尾帧");
        }
        double seekSeconds = tail ? Math.max(0, duration - 1)
                : Double.isFinite(duration) && duration > 0 ? Math.min(1, duration / 2) : 0;
        extractFrame(source, output, seekSeconds, tail);
        // 极短或时间戳不完整的视频可能无法精确seek，回退首个可解码画面。
        if (!hasOutput(output) && seekSeconds > 0 && !tail) extractFrame(source, output, 0, false);
        try {
            BufferedImage cover = hasOutput(output) ? ImageIO.read(output.toFile()) : null;
            if (cover == null) throw new BusinessException(ErrorCode.BUSINESS_ERROR, "视频没有可用的封面画面");
            return new CoverResult(width, height, cover.getWidth(), cover.getHeight());
        } catch (IOException exception) {
            throw new BusinessException(ErrorCode.BUSINESS_ERROR, "读取视频封面失败");
        }
    }

    private void extractFrame(Path source, Path output, double seconds, boolean tail) {
        List<String> command = new ArrayList<>(List.of(
                executable(properties.getAi().getVideoComposition().getFfmpegExecutable(), "ffmpeg"),
                "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1",
                "-protocol_whitelist", "file", "-format_whitelist", SINGLE_FILE_FORMATS,
                "-ss", String.format(Locale.ROOT, "%.3f", seconds),
                "-i", source.toAbsolutePath().toString(), "-map", "0:v:0", "-an"));
        // Decode the last second and overwrite the still: the final decoded frame wins,
        // including low-frame-rate and one-frame clips where seeking near EOF yields nothing.
        if (!tail) command.addAll(List.of("-frames:v", "1"));
        command.addAll(List.of("-vf", tail ? "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease" : "scale=640:640:force_original_aspect_ratio=decrease", "-threads", "1",
                "-q:v", "3", "-update", "1", output.toAbsolutePath().toString()));
        run(command);
    }

    private boolean hasOutput(Path output) {
        try { return Files.isRegularFile(output) && Files.size(output) > 0; }
        catch (IOException exception) { return false; }
    }

    private boolean isQuarterTurn(JSONObject stream) {
        JSONObject tags = stream.getJSONObject("tags");
        double rotation = parseNumber(tags == null ? null : tags.getString("rotate"));
        JSONArray sideData = stream.getJSONArray("side_data_list");
        if (sideData != null) {
            for (int index = 0; index < sideData.size(); index++) {
                JSONObject item = sideData.getJSONObject(index);
                if (item != null && item.containsKey("rotation")) rotation = parseNumber(item.getString("rotation"));
            }
        }
        return Math.abs(Math.round(rotation)) % 180 == 90;
    }

    private double parseNumber(String value) {
        try { return value == null ? 0 : Double.parseDouble(value); }
        catch (NumberFormatException exception) { return 0; }
    }

    /** 参数直接传入ProcessBuilder，视频解析只允许本地文件协议，输出与运行时间均有上限。 */
    private String run(List<String> command) {
        Process process;
        try { process = new ProcessBuilder(command).redirectErrorStream(true).start(); }
        catch (IOException exception) {
            throw new BusinessException(ErrorCode.BUSINESS_ERROR, "视频封面工具不可用，请检查FFmpeg和FFprobe配置");
        }
        StringBuilder output = new StringBuilder();
        Thread reader = Thread.ofVirtual().start(() -> drain(process.getInputStream(), output));
        try {
            int timeout = Math.min(60, Math.max(1, properties.getAi().getVideoComposition().getExecutionTimeoutSeconds()));
            if (!process.waitFor(timeout, TimeUnit.SECONDS)) {
                throw new BusinessException(ErrorCode.BUSINESS_ERROR, "视频封面处理超时");
            }
            reader.join(2000);
            if (process.exitValue() != 0) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "无法解析视频或提取封面画面");
            }
            return output.toString();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new BusinessException(ErrorCode.BUSINESS_ERROR, "视频封面处理已中断");
        } finally {
            if (process.isAlive()) process.destroyForcibly();
            try {
                process.waitFor(5, TimeUnit.SECONDS);
                reader.join(2000);
            } catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
        }
    }

    private void drain(InputStream input, StringBuilder output) {
        try (input) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.length() < MAXIMUM_OUTPUT_CHARACTERS) {
                    String chunk = new String(buffer, 0, count, StandardCharsets.UTF_8);
                    output.append(chunk, 0, Math.min(chunk.length(), MAXIMUM_OUTPUT_CHARACTERS - output.length()));
                }
            }
        } catch (IOException ignored) { /* 进程终止时输出流关闭。 */ }
    }

    private String executable(String configured, String fallback) {
        return StringUtils.hasText(configured) ? configured.trim() : fallback;
    }

    public record CoverResult(int width, int height, int coverWidth, int coverHeight) { }
}
