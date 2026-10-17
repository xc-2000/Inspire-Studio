package com.inspirestudio.task;

import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.VideoEditingOptions;
import java.nio.file.*;
import java.util.List;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class VideoTimelineTest {
    public static void main(String[] args) throws Exception {
        var test = new VideoTimelineTest();
        test.dir = Files.createTempDirectory("canvas-timeline-test-");
        test.exportsRealSplitVideoWithBurnedChineseSubtitles();
        System.out.println("PASS: actual split export + Chinese subtitles + audio, duration 2s");
    }
    @TempDir Path dir;
    final VideoCompositionMediaProcessor processor = new VideoCompositionMediaProcessor(new InspireProperties());
    @Test void trimsAndMutesWithoutChangingSourceOrder() {
        var options = new VideoEditingOptions(List.of(new VideoEditingOptions.Clip(0, 2000L, true), new VideoEditingOptions.Clip(3000, 4500L, false)), List.of(), 36);
        var probe = new VideoCompositionMediaProcessor.VideoProbe(640, 360, "24", 5000, true);
        var edited = processor.editProbes(List.of(probe, probe), options);
        assertEquals(2000, edited.getFirst().durationMilliseconds());
        assertFalse(edited.getFirst().hasAudio());
        assertTrue(edited.getLast().hasAudio());
        var command = processor.buildFfmpegCommand(List.of(dir.resolve("v.mp4"), dir.resolve("v.mp4")), edited, dir.resolve("out.mp4"), options, null);
        assertEquals("0.000", command.get(command.indexOf("-ss") + 1));
        assertEquals("3.000", command.get(command.lastIndexOf("-ss") + 1));
        assertEquals("1.500", command.get(command.lastIndexOf("-t") + 1));
        assertThrows(RuntimeException.class, () -> processor.editProbes(List.of(probe), new VideoEditingOptions(List.of(new VideoEditingOptions.Clip(4500, 5500L, false)), List.of(), 36)));
    }
    @Test void mixesVoiceoverTracksAtTimelinePositionsOverDuckedOriginalAudio() {
        var tracks = List.of(new VideoEditingOptions.AudioTrack("audio:a", 1500, null), new VideoEditingOptions.AudioTrack("audio:b", 12000, 1.2));
        var options = new VideoEditingOptions(List.of(), List.of(), 36, tracks, null);
        var probe = new VideoCompositionMediaProcessor.VideoProbe(640, 360, "24", 10000, false);
        var command = processor.buildFfmpegCommand(List.of(dir.resolve("a.mp4"), dir.resolve("b.mp4")), List.of(probe, probe), dir.resolve("out.mp4"), options, null,
                List.of(dir.resolve("voice-a.mp3"), dir.resolve("voice-b.mp3")));
        String filter = command.get(command.indexOf("-filter_complex") + 1);
        assertTrue(command.contains(dir.resolve("voice-a.mp3").toAbsolutePath().toString()));
        assertTrue(filter.contains("[audio-output]volume=0.600[overlay-bed]"), filter);
        assertTrue(filter.contains("[2:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=1.000,adelay=1500|1500[overlay0]"), filter);
        assertTrue(filter.contains("[3:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=1.200,adelay=12000|12000[overlay1]"), filter);
        assertTrue(filter.endsWith("[overlay-bed][overlay0][overlay1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[audio-mixed]"), filter);
        assertEquals("[audio-mixed]", command.get(command.lastIndexOf("-map") + 1));
        var plain = processor.buildFfmpegCommand(List.of(dir.resolve("a.mp4")), List.of(probe), dir.resolve("out.mp4"), VideoEditingOptions.empty(), null);
        assertEquals("[audio-output]", plain.get(plain.lastIndexOf("-map") + 1), "no overlay keeps the original audio graph");
        assertThrows(RuntimeException.class, () -> new VideoEditingOptions(List.of(), List.of(), 36, List.of(new VideoEditingOptions.AudioTrack("", 0, null)), null).validate(1));
        assertThrows(RuntimeException.class, () -> new VideoEditingOptions(List.of(), List.of(), 36, List.of(new VideoEditingOptions.AudioTrack("audio:x", 0, 3.0)), null).validate(1));
    }
    @Test void escapesSubtitleOverrideTagsAndPreservesChinese() throws Exception {
        var options = new VideoEditingOptions(List.of(), List.of(new VideoEditingOptions.Subtitle(1234, 5678, "中文{\\pos(1,1)}\n第二行")), 36);
        var path = processor.writeCaptions(dir, options, new VideoCompositionMediaProcessor.VideoProbe(640,360,"24",6000,false));
        var text = Files.readString(path);
        assertTrue(text.contains("0:00:01.23,0:00:05.67"));
        assertTrue(text.contains("中文｛＼pos(1,1)｝\\N第二行"));
        assertFalse(text.contains("{\\pos"));
    }
    @Test void exportsRealSplitVideoWithBurnedChineseSubtitles() throws Exception {
        Assumptions.assumeTrue("1".equals(System.getenv("RUN_FFMPEG_TEST")));
        Path source = dir.resolve("source.mp4");
        Process create = new ProcessBuilder("ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source.toString()).inheritIO().start();
        assertEquals(0, create.waitFor());
        var options = new VideoEditingOptions(List.of(new VideoEditingOptions.Clip(0,1000L,true), new VideoEditingOptions.Clip(1500,2500L,false)), List.of(new VideoEditingOptions.Subtitle(0,1900,"画布剪辑测试")), 24);
        Path output = dir.resolve("output.mp4");
        var result = processor.compose(List.of(source,source), output, p -> {}, () -> false, options);
        assertTrue(Math.abs(result.durationMilliseconds()-2000) < 200, "actual duration=" + result.durationMilliseconds());
        assertTrue(Files.size(output)>1000);
        assertTrue(processor.probe(output).hasAudio());
    }
}
