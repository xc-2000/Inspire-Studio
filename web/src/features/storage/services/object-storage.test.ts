import assert from "node:assert/strict";
import test from "node:test";

import { createObjectStorageConfig } from "@/features/settings/stores/use-config-store";
import { buildObjectStoragePublicUrl, isObjectStorageReady, objectStorageReadyMessage } from "./object-storage.ts";

const r2Config = createObjectStorageConfig({
    provider: "cloudflareR2",
    accessKey: "test-access-key",
    secretKey: "test-secret-key",
    bucket: "test-media",
    endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    publicBaseUrl: "https://pub-example.r2.dev",
});

test("R2 配置在创建和服务端重新载入时固定 Region 并保留掩码密钥", () => {
    assert.equal(r2Config.region, "auto");
    const loaded = createObjectStorageConfig({ ...r2Config, region: "ap-guangzhou", accessKey: "********", secretKey: "********" });
    assert.equal(loaded.region, "auto");
    assert.equal(loaded.provider, "cloudflareR2");
    assert.equal(loaded.accessKey, "********");
    assert.equal(loaded.secretKey, "********");
    assert.equal(isObjectStorageReady(loaded), true);
});

test("R2 支持公开开发域名、自定义域名和地区 S3 Endpoint", () => {
    assert.equal(isObjectStorageReady(r2Config), true);
    assert.equal(isObjectStorageReady({ ...r2Config, publicBaseUrl: "https://media.example.com/", endpoint: r2Config.endpoint.replace(".r2.", ".eu.r2.") }), true);
    assert.equal(isObjectStorageReady({ ...r2Config, publicBaseUrl: "https://media.example.com/uploads/" }), true);
    assert.equal(buildObjectStoragePublicUrl({ ...r2Config, publicBaseUrl: "https://media.example.com/uploads/" }, "image.png"), "https://media.example.com/uploads/image.png");
    assert.equal(buildObjectStoragePublicUrl({ ...r2Config, publicBaseUrl: "https://media.example.com/" }, "inspire-studio/images/测试 图片.png"), "https://media.example.com/inspire-studio/images/%E6%B5%8B%E8%AF%95%20%E5%9B%BE%E7%89%87.png");
});

test("R2 拒绝使用 API 地址作为公开媒体地址，且不会回退拼接私有 API 地址", () => {
    for (const publicBaseUrl of ["", r2Config.endpoint, r2Config.endpoint.replace(".r2.", ".eu.r2.")]) {
        const config = { ...r2Config, publicBaseUrl };
        assert.equal(isObjectStorageReady(config), false);
        assert.match(objectStorageReadyMessage(config), /公开|媒体/);
        assert.throws(() => buildObjectStoragePublicUrl(config, "image.png"), /公开|媒体/);
    }
});

test("R2 配置阻止常见 Endpoint 和公开域名填写错误", () => {
    for (const endpoint of ["", "https://media.example.com", r2Config.endpoint + "/test-media", r2Config.endpoint.replace("https:", "http:"), r2Config.endpoint + "?token=example"]) {
        const config = { ...r2Config, endpoint };
        assert.equal(isObjectStorageReady(config), false);
        assert.match(objectStorageReadyMessage(config), /Endpoint/);
    }
    for (const publicBaseUrl of ["media.example.com", "http://media.example.com", "https://user:password@media.example.com", "https://media.example.com#image", "https://media.example.com?token=example"]) {
        assert.equal(isObjectStorageReady({ ...r2Config, publicBaseUrl }), false);
    }
});

test("原有存储服务商的必填字段和公开地址逻辑保持可用", () => {
    const cos = createObjectStorageConfig({ provider: "tencentCos", accessKey: "key", secretKey: "secret", bucket: "example-1234", region: "ap-guangzhou" });
    assert.equal(isObjectStorageReady(cos), true);
    assert.equal(buildObjectStoragePublicUrl(cos, "image.png"), "https://example-1234.cos.ap-guangzhou.myqcloud.com/image.png");
    assert.equal(isObjectStorageReady({ ...cos, provider: "aliyunOss" }), false);
    assert.equal(isObjectStorageReady({ ...cos, provider: "aliyunOss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com" }), true);
    assert.equal(isObjectStorageReady({ ...cos, provider: "qiniuKodo" }), false);
    assert.equal(isObjectStorageReady({ ...cos, provider: "qiniuKodo", publicBaseUrl: "https://cdn.example.com" }), true);
});
