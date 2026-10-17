package com.inspirestudio.payment;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.time.Instant;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpHeaders;
import reactor.test.StepVerifier;

class WechatGatewayTest {
    @TempDir Path dir;
    @Test void verifiesSignatureAndDecryptsButRejectsTamperingAndStaleReplay() throws Exception {
        var key=KeyPairGenerator.getInstance("RSA");key.initialize(2048);var pair=key.generateKeyPair();
        Path priv=dir.resolve("private.pem"),pub=dir.resolve("public.pem");
        Files.writeString(priv,pem("PRIVATE KEY",pair.getPrivate().getEncoded()));Files.writeString(pub,pem("PUBLIC KEY",pair.getPublic().getEncoded()));
        var props=new WechatPayProperties();props.setEnabled(true);props.setAppId("app");props.setMerchantId("merchant");
        props.setMerchantSerialNumber("serial");props.setPrivateKeyPath(priv.toString());props.setPublicKeyPath(pub.toString());
        props.setPublicKeyId("PUB_KEY_ID_test");props.setNotifyUrl("https://example.test/api/v1/payment/wechat/notify");
        props.setApiV3Key("0123456789abcdef0123456789abcdef");
        var gateway=new WechatGateway(props);
        String content="{\"appid\":\"app\",\"mchid\":\"merchant\",\"out_trade_no\":\"WXtest\",\"trade_state\":\"SUCCESS\"}";
        var cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(props.getApiV3Key().getBytes(StandardCharsets.UTF_8),"AES"),new GCMParameterSpec(128,"123456789012".getBytes(StandardCharsets.UTF_8)));
        cipher.updateAAD("transaction".getBytes(StandardCharsets.UTF_8));
        String encrypted=Base64.getEncoder().encodeToString(cipher.doFinal(content.getBytes(StandardCharsets.UTF_8)));
        String body="{\"event_type\":\"TRANSACTION.SUCCESS\",\"resource_type\":\"encrypt-resource\",\"resource\":{\"algorithm\":\"AEAD_AES_256_GCM\",\"original_type\":\"transaction\",\"nonce\":\"123456789012\",\"associated_data\":\"transaction\",\"ciphertext\":\""+encrypted+"\"}}";
        String timestamp=Long.toString(Instant.now().getEpochSecond());
        var headers=headers(pair.getPrivate(),timestamp,body);
        StepVerifier.create(gateway.notification(headers,body)).expectNextMatches(t->"WXtest".equals(t.getOutTradeNo())).verifyComplete();
        StepVerifier.create(gateway.notification(headers,body+" ")).expectError().verify();
        headers.set("Wechatpay-Timestamp","1");StepVerifier.create(gateway.notification(headers,body)).expectError().verify();
    }
    static HttpHeaders headers(PrivateKey key,String timestamp,String body) throws Exception {
        var signature=Signature.getInstance("SHA256withRSA");signature.initSign(key);
        signature.update((timestamp+"\nnonce\n"+body+"\n").getBytes(StandardCharsets.UTF_8));
        var h=new HttpHeaders();h.set("Wechatpay-Timestamp",timestamp);h.set("Wechatpay-Nonce","nonce");h.set("Wechatpay-Serial","PUB_KEY_ID_test");
        h.set("Wechatpay-Signature",Base64.getEncoder().encodeToString(signature.sign()));return h;
    }
    static String pem(String type,byte[] bytes) {return "-----BEGIN "+type+"-----\n"+Base64.getMimeEncoder(64,new byte[]{'\n'}).encodeToString(bytes)+"\n-----END "+type+"-----\n";}
}
