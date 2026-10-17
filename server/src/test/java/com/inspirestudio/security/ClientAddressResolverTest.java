package com.inspirestudio.security;

import com.inspirestudio.config.InspireProperties;
import java.net.InetSocketAddress;
import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.web.server.adapter.ForwardedHeaderTransformer;
import static org.junit.jupiter.api.Assertions.*;

class ClientAddressResolverTest {
    private final InspireProperties properties = new InspireProperties();

    private ClientAddressResolver resolver() {
        properties.getApp().setTrustedProxyAddresses("172.29.164.0/24");
        return new ClientAddressResolver(properties);
    }

    @Test void frameworkForwardingKeepsClientsSeparate() {
        var resolver = resolver();
        for (String ip : new String[]{"203.0.113.10", "203.0.113.11"}) {
            var raw = MockServerHttpRequest.get("http://server/api")
                    .remoteAddress(new InetSocketAddress("172.29.164.6", 1234))
                    .header("X-Forwarded-For", ip + ", 172.29.164.1")
                    .header("X-Forwarded-Proto", "https").build();
            var transformed = new ForwardedHeaderTransformer().apply(raw);
            assertNull(transformed.getRemoteAddress().getAddress());
            assertNull(transformed.getHeaders().getFirst("X-Forwarded-For"));
            var verified = new TrustedForwardedHeaderTransformer(properties, resolver).apply(raw);
            assertEquals(ip, resolver.resolve(verified));
        }
    }

    @Test void untrustedCallerCannotSpoofIpEvenWithFrameworkForwarding() {
        var raw = MockServerHttpRequest.get("http://server/api")
                .remoteAddress(new InetSocketAddress("203.0.113.99", 1234))
                .header("X-Forwarded-For", "198.51.100.8").build();
        var resolver = resolver();
        assertEquals("203.0.113.99", resolver.resolve(new TrustedForwardedHeaderTransformer(properties, resolver).apply(raw)));
    }

    @Test void ignoreSpoofedLeftmostIpAndInvalidAddresses() {
        var raw = MockServerHttpRequest.get("http://server/api")
                .remoteAddress(new InetSocketAddress("172.29.164.6", 1234))
                .header("X-Forwarded-For", "198.51.100.1, 203.0.113.12, 172.29.164.1").build();
        assertEquals("203.0.113.12", resolver().resolve(raw));
        assertFalse(TrustedProxyMatcher.isLiteralIpAddress("dead.beef"));
        assertFalse(TrustedProxyMatcher.isLiteralIpAddress("999.999.999.999"));
    }

    @Test void literalUnresolvedAddressDoesNotBecomeUnknown() {
        var raw = MockServerHttpRequest.get("http://server/api")
                .remoteAddress(InetSocketAddress.createUnresolved("203.0.113.15", 80)).build();
        assertEquals("203.0.113.15", resolver().resolve(raw));
    }
}
