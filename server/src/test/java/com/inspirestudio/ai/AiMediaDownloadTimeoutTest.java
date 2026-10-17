package com.inspirestudio.ai;

import static org.junit.jupiter.api.Assertions.*;

import com.inspirestudio.common.BusinessException;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AiMediaDownloadTimeoutTest {
    @TempDir Path directory;

    @Test
    void stalledResponseBodyIsClosedAndPartialFileRemoved() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/video", exchange -> {
            exchange.sendResponseHeaders(200, 0);
            try (var output = exchange.getResponseBody()) {
                output.write(new byte[] {1, 2, 3});
                output.flush();
                try { release.await(5, TimeUnit.SECONDS); }
                catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
            }
        });
        server.start();
        Path target = directory.resolve("source.mp4");
        try {
            BusinessException error = assertThrows(BusinessException.class, () -> new AiHttpClient()
                    .downloadRemoteMediaToFile("http://127.0.0.1:" + server.getAddress().getPort() + "/video",
                            "video/mp4", target, 1024, Duration.ofMillis(500))
                    .block(Duration.ofSeconds(3)));
            assertEquals("下载媒体文件超时", error.getMessage());
            assertFalse(Files.exists(target));
        } finally {
            release.countDown();
            server.stop(0);
        }
    }
}
