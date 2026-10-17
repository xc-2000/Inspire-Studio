package com.inspirestudio.logging;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import static org.junit.jupiter.api.Assertions.*;

class NewApiLogRedactionTest {
    @Test void bothLogSinksRedactNestedChannelCredentials() throws Exception {
        for (Object filter : new Object[]{new HttpLoggingWebFilter(), new ApiAccessLogWebFilter(null, null, null)}) {
            var sanitize = filter.getClass().getDeclaredMethod("sanitizeBody", String.class, MediaType.class);
            sanitize.setAccessible(true);
            String input = "{\"name\":\"demo\",\"apiKey\":\"private-api\",\"nested\":[{\"api_key\":\"private-alt\",\"adminToken\":\"private-admin\",\"relayKey\":\"private-relay\",\"secretKey\":\"private-storage\"}]}";
            String output = (String) sanitize.invoke(filter, input, MediaType.APPLICATION_JSON);
            assertFalse(output.contains("private-"), filter.getClass().getSimpleName());
            assertTrue(output.contains("demo"));
        }
    }
}
