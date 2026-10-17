package com.inspirestudio.ai.provider;
import com.alibaba.fastjson2.JSON;
import com.inspirestudio.ai.*;
import com.inspirestudio.config.InspireProperties;
import com.inspirestudio.dto.AiTaskDtos;
import com.inspirestudio.entity.AiGenerationTask;
import com.sun.net.httpserver.HttpServer;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import static org.junit.jupiter.api.Assertions.*;
class OpenAiMaskTest {
    @Test void sendsOwnedImageAndMaskAsDistinctMultipartParts() {
        var http=mock(AiHttpClient.class); var media=mock(AiMediaSupport.class);
        var adapter=new OpenAiProviderAdapter(http,media,new InspireProperties());
        var source=new AiTaskDtos.AiTaskMediaReference("source","source.png","image/png","image:source",null);
        var mask=new AiTaskDtos.AiTaskMediaReference("mask","mask.png","image/png","image:mask",null);
        when(media.resolveReferenceBinary(eq(42L),any(),eq("image/png"))).thenReturn(Mono.just(new GeneratedBinary(new byte[]{1,2,3},"image/png")));
        when(http.formPart(anyString(),anyString())).thenAnswer(i->new MultipartPart(i.getArgument(0),null,"text/plain",((String)i.getArgument(1)).getBytes()));
        when(http.filePart(anyString(),anyString(),anyString(),any())).thenAnswer(i->new MultipartPart(i.getArgument(0),i.getArgument(1),i.getArgument(2),i.getArgument(3)));
        when(http.sendMultipartRequest(any(),eq("/images/edits"),anyString(),anyList())).thenAnswer(i->{
            List<MultipartPart> parts=i.getArgument(3);
            assertEquals(1,parts.stream().filter(p->"mask".equals(p.name())).count());
            assertEquals(1,parts.stream().filter(p->"image".equals(p.name())).count());
            return Mono.just(JSON.parseObject("{\"data\":[]}"));
        });
        var task=new AiGenerationTask();task.setUserId(42L);task.setTaskType("image");
        var channel=new AiTaskDtos.AiChannelConfig("test","test","https://example.invalid","test-key","openai",List.of("model"));
        var request=new AiTaskDtos.CreateAiTaskRequest("image","局部重绘","model",Map.of("editMask",mask),List.of(source),List.of(),"canvas");
        adapter.execute(new AiTaskExecutionContext(task,channel,"model",false,"",request,()->Mono.just(false),p->Mono.empty(),d->Mono.empty())).block();
        verify(media).resolveReferenceBinary(42L,mask,"image/png");
        verify(http).sendMultipartRequest(eq(channel),eq("/images/edits"),anyString(),anyList());
    }

    @Test
    void sendsRealPngFilesWithMatchingMaskAlphaThroughLocalHttpMultipart() throws Exception {
        BufferedImage sourceImage = new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB);
        BufferedImage maskImage = new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 2; y++) {
            for (int x = 0; x < 2; x++) {
                sourceImage.setRGB(x, y, 0xff226688);
                maskImage.setRGB(x, y, 0xff000000);
            }
        }
        maskImage.setRGB(0, 0, 0x00000000);
        byte[] sourceBytes = pngBytes(sourceImage);
        byte[] maskBytes = pngBytes(maskImage);
        AtomicReference<String> contentType = new AtomicReference<>();
        AtomicReference<byte[]> receivedBody = new AtomicReference<>();
        AtomicReference<String> receivedMethod = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/images/edits", exchange -> {
            receivedMethod.set(exchange.getRequestMethod());
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            receivedBody.set(exchange.getRequestBody().readAllBytes());
            byte[] response = "{\"data\":[]}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            try (var output = exchange.getResponseBody()) { output.write(response); }
        });
        server.start();
        try {
            AiMediaSupport media = mock(AiMediaSupport.class);
            var source = new AiTaskDtos.AiTaskMediaReference("source", "source.png", "image/png", "image:source", null);
            var mask = new AiTaskDtos.AiTaskMediaReference("mask", "mask.png", "image/png", "image:mask", null);
            when(media.resolveReferenceBinary(42L, source, "image/png"))
                    .thenReturn(Mono.just(new GeneratedBinary(sourceBytes, "image/png")));
            when(media.resolveReferenceBinary(42L, mask, "image/png"))
                    .thenReturn(Mono.just(new GeneratedBinary(maskBytes, "image/png")));
            var adapter = new OpenAiProviderAdapter(new AiHttpClient(), media, new InspireProperties());
            var task = new AiGenerationTask();
            task.setUserId(42L);
            task.setTaskType("image");
            var channel = new AiTaskDtos.AiChannelConfig("local", "Local mock", "http://127.0.0.1:" + server.getAddress().getPort() + "/v1",
                    "test-key", "openai", List.of("test-image-model"));
            var request = new AiTaskDtos.CreateAiTaskRequest("image", "只修改透明选区", "test-image-model",
                    Map.of("editMask", mask, "count", 1, "size", "1024x1024"), List.of(source), List.of(), "canvas");

            adapter.execute(new AiTaskExecutionContext(task, channel, "test-image-model", false, "", request,
                    () -> Mono.just(false), progress -> Mono.empty(), delta -> Mono.empty())).block(Duration.ofSeconds(10));

            assertEquals("POST", receivedMethod.get());
            assertNotNull(contentType.get());
            assertTrue(contentType.get().startsWith("multipart/form-data; boundary="));
            String boundary = contentType.get().substring(contentType.get().indexOf("boundary=") + 9);
            String wire = new String(receivedBody.get(), StandardCharsets.ISO_8859_1);
            assertEquals(1L, Pattern.compile("Content-Disposition: form-data; name=\"image\"; filename=\"").matcher(wire).results().count());
            assertEquals(1L, Pattern.compile("Content-Disposition: form-data; name=\"mask\"; filename=\"").matcher(wire).results().count());
            byte[] sentSource = multipartFile(wire, boundary, "image", "source.png");
            byte[] sentMask = multipartFile(wire, boundary, "mask", "mask.png");
            assertArrayEquals(sourceBytes, sentSource);
            assertArrayEquals(maskBytes, sentMask);
            BufferedImage decodedSource = ImageIO.read(new ByteArrayInputStream(sentSource));
            BufferedImage decodedMask = ImageIO.read(new ByteArrayInputStream(sentMask));
            assertNotNull(decodedSource);
            assertNotNull(decodedMask);
            assertEquals(decodedSource.getWidth(), decodedMask.getWidth());
            assertEquals(decodedSource.getHeight(), decodedMask.getHeight());
            for (int y = 0; y < 2; y++) {
                for (int x = 0; x < 2; x++) {
                    assertEquals(255, decodedSource.getRGB(x, y) >>> 24);
                    assertEquals(x == 0 && y == 0 ? 0 : 255, decodedMask.getRGB(x, y) >>> 24);
                }
            }
            verify(media).resolveReferenceBinary(42L, source, "image/png");
            verify(media).resolveReferenceBinary(42L, mask, "image/png");
        } finally {
            server.stop(0);
        }
    }

    private static byte[] pngBytes(BufferedImage image) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(image, "png", output));
        return output.toByteArray();
    }

    private static byte[] multipartFile(String wire, String boundary, String name, String fileName) {
        String disposition = "Content-Disposition: form-data; name=\"" + name + "\"; filename=\"" + fileName + "\"";
        int headerStart = wire.indexOf(disposition);
        assertTrue(headerStart >= 0, "missing file disposition for " + name);
        int bodyStart = wire.indexOf("\r\n\r\n", headerStart);
        assertTrue(bodyStart > headerStart);
        assertTrue(wire.substring(headerStart, bodyStart).contains("Content-Type: image/png"), "PNG MIME missing for " + name);
        bodyStart += 4;
        int bodyEnd = wire.indexOf("\r\n--" + boundary, bodyStart);
        assertTrue(bodyEnd > bodyStart);
        return wire.substring(bodyStart, bodyEnd).getBytes(StandardCharsets.ISO_8859_1);
    }
}
