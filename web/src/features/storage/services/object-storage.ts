"use client";

import { registerRemoteMedia, testObjectStorage, uploadRemoteMediaToObjectStorage, uploadServerMedia } from "@/services/api/server";
import type { ObjectStorageConfig, ObjectStorageFile } from "@/shared/types/object-storage";

type ObjectStorageUploadKind = "image" | "video" | "audio";
type UploadObjectInput = {
    body: Blob;
    kind: ObjectStorageUploadKind;
    fileName?: string;
    mimeType?: string;
};

export function isObjectStorageReady(config: ObjectStorageConfig) {
    if (!config.accessKey.trim() || !config.secretKey.trim() || !config.bucket.trim() || !config.region.trim()) return false;
    if (config.provider === "cloudflareR2") return !r2ConfigError(config);
    if (config.provider === "aliyunOss") return Boolean(config.endpoint.trim());
    return config.provider !== "qiniuKodo" || Boolean(config.publicBaseUrl.trim());
}

export async function uploadObjectToStorage(input: UploadObjectInput): Promise<ObjectStorageFile> {
    const media = await uploadServerMedia(
        input.body,
        {
            kind: input.kind,
            mimeType: input.mimeType || input.body.type || (input.kind === "image" ? "image/png" : input.kind === "audio" ? "audio/mpeg" : "video/mp4"),
        },
        input.fileName || (input.kind === "image" ? "image.png" : input.kind === "audio" ? "audio.mp3" : "video.mp4"),
    );
    if (!media.objectStorage) throw new Error("后端没有返回对象存储文件信息");
    return media.objectStorage;
}

export async function uploadRemoteObjectToStorage(input: { storageKey?: string; sourceUrl: string; kind: ObjectStorageUploadKind; mimeType?: string }): Promise<ObjectStorageFile> {
    const storageKey = input.storageKey?.trim() ? input.storageKey.trim() : (await registerRemoteMedia({ kind: input.kind, sourceUrl: input.sourceUrl, mimeType: input.mimeType })).storageKey;
    const media = await uploadRemoteMediaToObjectStorage(storageKey);
    if (!media.objectStorage) throw new Error("后端没有返回对象存储文件信息");
    return media.objectStorage;
}

export async function testObjectStorageUpload(config: ObjectStorageConfig) {
    if (!isObjectStorageReady(config)) throw new Error(objectStorageReadyMessage(config));
    return testObjectStorage(config);
}

export function buildObjectStoragePublicUrl(config: ObjectStorageConfig, key: string) {
    if (config.provider === "cloudflareR2") {
        const error = r2PublicUrlError(config.publicBaseUrl);
        if (error) throw new Error(error);
    }
    const baseUrl = config.publicBaseUrl.trim().replace(/\/+$/, "");
    const path = key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    if (baseUrl) return `${baseUrl}/${path}`;
    if (config.provider === "tencentCos") return `https://${config.bucket.trim()}.cos.${config.region.trim()}.myqcloud.com/${path}`;
    if (config.provider === "aliyunOss") {
        const endpoint = new URL(config.endpoint.trim());
        return `${endpoint.protocol}//${config.bucket.trim()}.${endpoint.host}/${path}`;
    }
    throw new Error("七牛云Kodo必须填写公开访问地址");
}

export function objectStorageReadyMessage(config?: ObjectStorageConfig) {
    if (!config) return "对象存储不存在";
    if (!config.accessKey.trim() || !config.secretKey.trim() || !config.bucket.trim() || !config.region.trim()) {
        return "请完整填写访问密钥、密钥、Bucket 和 Region";
    }
    if (config.provider === "cloudflareR2") return r2ConfigError(config) || "对象存储配置不完整";
    if (config.provider === "aliyunOss" && !config.endpoint.trim()) return "请填写阿里云OSS Endpoint";
    if (config.provider === "qiniuKodo" && !config.publicBaseUrl.trim()) return "请填写七牛云Kodo公开访问地址";
    return "对象存储配置不完整";
}

function parseHttpsUrl(value: string) {
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
        return url;
    } catch {
        return null;
    }
}

function r2ConfigError(config: ObjectStorageConfig) {
    if (config.region.trim() !== "auto") return "Cloudflare R2 的 Region 必须为 auto";
    const endpoint = parseHttpsUrl(config.endpoint);
    if (!endpoint || !/^[a-z0-9]+(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname) || endpoint.port || endpoint.pathname !== "/") {
        return "请填写 R2 S3 API Endpoint：https://<ACCOUNT_ID>.r2.cloudflarestorage.com（不含 Bucket 或文件路径）";
    }
    return r2PublicUrlError(config.publicBaseUrl);
}

function r2PublicUrlError(value: string) {
    if (!value.trim()) return "请填写 R2 公开访问域名（已启用的 r2.dev 地址或自定义域名）";
    const url = parseHttpsUrl(value);
    if (!url) return "R2 公开访问地址必须是完整 HTTPS 地址，不含登录信息、查询参数或片段";
    if (url.hostname === "r2.cloudflarestorage.com" || url.hostname.endsWith(".r2.cloudflarestorage.com")) {
        return "R2 S3 API Endpoint 不能作为公开媒体地址，请填写 r2.dev 地址或自定义域名";
    }
    return "";
}
