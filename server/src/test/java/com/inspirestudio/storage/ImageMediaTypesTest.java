package com.inspirestudio.storage;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class ImageMediaTypesTest {
    @Test
    void actualWebpOverridesPngMetadataWithoutChangingFileBytes() throws Exception {
        try (var input = getClass().getResourceAsStream("/media/open-drama-reference.webp")) {
            byte[] data = input.readAllBytes();
            Assertions.assertEquals("image/webp", ImageMediaTypes.forMedia("image", data, "image/png"));
            Assertions.assertEquals("image/webp", ImageMediaTypes.forMedia("avatar", data, "image/*"));
            Assertions.assertEquals("video/mp4", ImageMediaTypes.forMedia("video", data, "video/mp4"));
        }
    }

    @Test
    void unknownOrTruncatedDataDoesNotInventAnImageType() {
        Assertions.assertEquals("image/png", ImageMediaTypes.forMedia("image", new byte[]{'R','I','F','F'}, "image/png"));
        Assertions.assertEquals("", ImageMediaTypes.detect(null));
    }
}
