package com.inspirestudio.security;

import com.inspirestudio.config.InspireProperties;
import java.net.InetSocketAddress;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Component;
import org.springframework.web.server.adapter.ForwardedHeaderTransformer;

/** Preserve a verified client address before Spring removes the forwarding headers. */
@Component("forwardedHeaderTransformer")
public class TrustedForwardedHeaderTransformer extends ForwardedHeaderTransformer {
    private final InspireProperties properties;
    private final ClientAddressResolver resolver;
    private final ForwardedHeaderTransformer removeOnly = new ForwardedHeaderTransformer();

    public TrustedForwardedHeaderTransformer(InspireProperties properties, ClientAddressResolver resolver) {
        this.properties = properties;
        this.resolver = resolver;
        removeOnly.setRemoveOnly(true);
    }

    @Override
    public ServerHttpRequest apply(ServerHttpRequest request) {
        InetSocketAddress remote = request.getRemoteAddress();
        String direct = remote == null ? null : remote.getHostString();
        if (!TrustedProxyMatcher.isTrustedProxyAddress(properties.getApp().getTrustedProxyAddresses(), direct)) {
            return removeOnly.apply(request);
        }
        String client = resolver.resolve(request);
        ServerHttpRequest forwarded = super.apply(request);
        // Spring creates an unresolved InetSocketAddress even for a literal IP.
        // Resolve only validated literals; never run DNS for a request header.
        return forwarded.mutate().remoteAddress(new InetSocketAddress(client, remote.getPort())).build();
    }
}
