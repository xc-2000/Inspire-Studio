package com.inspirestudio.dto;

import java.util.List;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;

/**
 * 视频合成的剪辑选项。
 *
 * @param clips 每段源视频的裁剪与静音
 * @param subtitles 烧录字幕
 * @param fontSize 字幕字号
 * @param audioTracks 叠加到成片上的独立音轨（配音、旁白），按成片时间轴定位
 * @param originalVolume 存在叠加音轨时源视频原声的音量倍数，默认 0.6 以突出配音
 */
public record VideoEditingOptions(List<Clip> clips, List<Subtitle> subtitles, Integer fontSize,
                                  List<AudioTrack> audioTracks, Double originalVolume) {
    public record Clip(long startMs, Long endMs, boolean muted) {}
    public record Subtitle(long startMs, long endMs, String text) {}
    /** 叠加音轨：audio 媒体存储键、在成片中的起始毫秒、音量倍数（默认1）。 */
    public record AudioTrack(String storageKey, long startMs, Double volume) {}

    /** 单次最多叠加的音轨数。 */
    public static final int MAXIMUM_AUDIO_TRACKS = 60;
    /** 有配音时原声默认音量。 */
    public static final double DEFAULT_DUCKED_ORIGINAL_VOLUME = 0.6;

    public VideoEditingOptions(List<Clip> clips, List<Subtitle> subtitles, Integer fontSize) {
        this(clips, subtitles, fontSize, List.of(), null);
    }

    public static VideoEditingOptions empty() { return new VideoEditingOptions(List.of(), List.of(), 36); }

    /** 不为空的叠加音轨列表。 */
    public List<AudioTrack> safeAudioTracks() { return audioTracks == null ? List.of() : audioTracks; }

    /** 有叠加音轨时原声音量；无叠加音轨时保持原声不变。 */
    public double effectiveOriginalVolume() {
        if (safeAudioTracks().isEmpty()) return 1.0;
        return originalVolume == null ? DEFAULT_DUCKED_ORIGINAL_VOLUME : originalVolume;
    }

    public void validate(int count) {
        if (clips != null && !clips.isEmpty() && clips.size() != count) invalid("剪辑片段数量与视频数量不一致");
        if (clips != null) for (Clip clip : clips) {
            if (clip == null || clip.startMs() < 0 || clip.startMs() > 3_600_000 || clip.endMs() != null && (clip.endMs() <= clip.startMs() || clip.endMs() > 3_600_000)) invalid("裁剪时间范围无效");
        }
        if (subtitles != null) {
            if (subtitles.size() > 500) invalid("单次最多 500 段字幕");
            for (Subtitle subtitle : subtitles) if (subtitle == null || subtitle.startMs() < 0 || subtitle.endMs() <= subtitle.startMs() || subtitle.endMs() > 3_600_000 || subtitle.text() == null || subtitle.text().length() > 1000) invalid("字幕内容或时间范围无效");
        }
        if (fontSize != null && (fontSize < 12 || fontSize > 120)) invalid("字幕字号应为 12–120");
        if (audioTracks != null) {
            if (audioTracks.size() > MAXIMUM_AUDIO_TRACKS) invalid("单次最多叠加 " + MAXIMUM_AUDIO_TRACKS + " 段音频");
            for (AudioTrack track : audioTracks) {
                if (track == null || track.storageKey() == null || track.storageKey().isBlank()) invalid("叠加音频缺少媒体存储键");
                if (track.startMs() < 0 || track.startMs() > 3_600_000) invalid("叠加音频起始时间无效");
                if (track.volume() != null && (!Double.isFinite(track.volume()) || track.volume() < 0 || track.volume() > 2)) invalid("叠加音频音量应为 0–2");
            }
        }
        if (originalVolume != null && (!Double.isFinite(originalVolume) || originalVolume < 0 || originalVolume > 2)) invalid("原声音量应为 0–2");
    }
    private static void invalid(String message) { throw new BusinessException(ErrorCode.PARAM_INVALID, message); }
}
