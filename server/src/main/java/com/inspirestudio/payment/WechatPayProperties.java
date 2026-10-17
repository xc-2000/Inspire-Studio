package com.inspirestudio.payment;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.util.List;
import java.util.HashSet;
import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "payment.wechat")
public class WechatPayProperties {
    private boolean enabled;
    private String appId = "";
    private String merchantId = "";
    private String merchantSerialNumber = "";
    private String privateKeyPath = "";
    private String publicKeyId = "";
    private String publicKeyPath = "";
    private String apiV3Key = "";
    private String notifyUrl = "";
    private String packagesJson = "[]";

    public record CreditPackage(String id, String name, int amountFen, int credits,
                                String subtitle, boolean recommended, List<String> features) {
        public CreditPackage {
            subtitle = subtitle == null ? "" : subtitle;
            features = features == null ? List.of() : List.copyOf(features);
        }
        public CreditPackage(String id, String name, int amountFen, int credits) {
            this(id,name,amountFen,credits,"",false,List.of());
        }
    }

    public List<CreditPackage> packages() {
        try {
            List<CreditPackage> result = new ObjectMapper().readValue(packagesJson, new TypeReference<>() {});
            var ids = new HashSet<String>();
            if (result.size() > 20) throw new IllegalArgumentException();
            for (var p : result) {
                if (p.id() == null || !p.id().matches("[a-zA-Z0-9_-]{1,64}") || !ids.add(p.id())
                        || p.name() == null || p.name().isBlank() || p.name().length() > 40
                        || p.amountFen() < 1 || p.amountFen() > 1000000 || p.credits() < 1 || p.credits() > 10000000)
                    throw new IllegalArgumentException();
            }
            return List.copyOf(result);
        } catch (Exception e) { throw new IllegalStateException("微信支付套餐配置无效"); }
    }

    public void validate() {
        if (appId.isBlank() || merchantId.isBlank() || merchantSerialNumber.isBlank()
                || !publicKeyId.matches("(?:PUB_KEY_ID_[A-Za-z0-9]+|[A-Fa-f0-9]{40})") || apiV3Key.getBytes(java.nio.charset.StandardCharsets.UTF_8).length != 32
                || !Files.isRegularFile(Path.of(privateKeyPath)) || !Files.isRegularFile(Path.of(publicKeyPath)))
            throw new IllegalStateException("微信支付商户配置不完整");
        URI uri = URI.create(notifyUrl);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null)
            throw new IllegalStateException("微信支付回调必须使用公网 HTTPS 地址");
    }
}
