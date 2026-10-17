package com.inspirestudio.task;

import static org.junit.jupiter.api.Assertions.*;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.config.InspireProperties;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/** Exercises real decoding; run in the FFmpeg-enabled Java test image, not a mock-only build. */
@Timeout(value = 60)
class VideoTailFrameTest {
    @TempDir Path directory;
    private VideoCoverMediaProcessor processor;
    private String ffmpeg;

    @BeforeEach
    void setUp() {
        Assumptions.assumeTrue("1".equals(System.getenv("RUN_FFMPEG_TEST")), "Set RUN_FFMPEG_TEST=1 in the FFmpeg-enabled test runtime");
        ffmpeg = System.getProperty("test.ffmpeg", "ffmpeg");
        InspireProperties properties = new InspireProperties();
        properties.getAi().getVideoComposition().setFfmpegExecutable(ffmpeg);
        properties.getAi().getVideoComposition().setFfprobeExecutable(System.getProperty("test.ffprobe", "ffprobe"));
        properties.getAi().getVideoComposition().setExecutionTimeoutSeconds(20);
        processor = new VideoCoverMediaProcessor(properties);
    }

    @Test
    void usesTheEndingSceneInsteadOfTheOrdinaryCover() throws Exception {
        Path source = directory.resolve("red-then-blue.mp4");
        makeVideo(List.of("-f", "lavfi", "-i", "color=c=red:s=160x90:r=25:d=2",
                "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=1",
                "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]"), source);
        Path cover = directory.resolve("cover.jpg"), tail = directory.resolve("tail.jpg");
        processor.extract(source, cover);
        var result = processor.extractTail(source, tail);
        assertEquals(160, result.width());
        assertEquals(90, result.height());
        assertDominant(cover, Color.RED);
        assertDominant(tail, Color.BLUE);
    }

    @Test
    void acceptsVeryShortSingleFrameVideo() throws Exception {
        Path source = directory.resolve("one-frame.mp4");
        makeVideo(List.of("-f", "lavfi", "-i", "color=c=green:s=160x90:r=25", "-frames:v", "1"), source);
        Path tail = directory.resolve("single-tail.jpg");
        var result = processor.extractTail(source, tail);
        assertEquals(160, result.width());
        assertEquals(90, result.height());
        assertDominant(tail, Color.GREEN);
    }

    @Test
    void rejectsAudioOnlyMediaInsteadOfInventingAVideoFrame() throws Exception {
        Path source = directory.resolve("audio-only.m4a");
        execute(List.of(ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:a", "aac", source.toString()));
        Path tail = directory.resolve("audio-tail.jpg");
        BusinessException error = assertThrows(BusinessException.class, () -> processor.extractTail(source, tail));
        assertEquals(ErrorCode.PARAM_INVALID, error.getCode());
        assertFalse(Files.exists(tail));
    }

    @Test
    void rejectsCorruptVideoWithoutReturningAPlaceholder() throws Exception {
        Path source = directory.resolve("broken.mp4"), tail = directory.resolve("broken-tail.jpg");
        Files.writeString(source, "this is not a video", StandardCharsets.UTF_8);
        assertThrows(BusinessException.class, () -> processor.extractTail(source, tail));
        assertFalse(Files.exists(tail));
    }

    private void makeVideo(List<String> inputs, Path output) throws Exception {
        List<String> command = new ArrayList<>(List.of(ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1"));
        command.addAll(inputs);
        command.addAll(List.of("-an", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", output.toString()));
        execute(command);
    }

    private void execute(List<String> command) throws Exception {
        Path log = Files.createTempFile(directory, "ffmpeg-", ".log");
        Process process;
        try { process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start(); }
        catch (IOException error) { throw new AssertionError("These integration tests require FFmpeg and FFprobe in the test runtime", error); }
        try {
            assertTrue(process.waitFor(20, TimeUnit.SECONDS), "FFmpeg fixture creation timed out");
            assertEquals(0, process.exitValue(), () -> {
                try { return Files.readString(log); } catch (IOException ignored) { return "Could not read FFmpeg output"; }
            });
        } finally { if (process.isAlive()) process.destroyForcibly(); }
    }

    private void assertDominant(Path imagePath, Color expected) throws Exception {
        BufferedImage image = ImageIO.read(imagePath.toFile());
        assertNotNull(image, "A decoded JPEG frame must exist");
        Color actual = new Color(image.getRGB(image.getWidth() / 2, image.getHeight() / 2));
        if (expected.equals(Color.RED)) assertTrue(actual.getRed() > actual.getBlue() + 70 && actual.getRed() > actual.getGreen() + 70, "Expected the red opening scene, got " + actual);
        if (expected.equals(Color.BLUE)) assertTrue(actual.getBlue() > actual.getRed() + 70 && actual.getBlue() > actual.getGreen() + 70, "Expected the blue ending scene, got " + actual);
        if (expected.equals(Color.GREEN)) assertTrue(actual.getGreen() > actual.getRed() + 60 && actual.getGreen() > actual.getBlue() + 60, "Expected the green single frame, got " + actual);
    }
}
