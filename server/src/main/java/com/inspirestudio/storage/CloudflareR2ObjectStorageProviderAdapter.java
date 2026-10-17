package com.inspirestudio.storage;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.PersistenceDtos;
import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.util.Locale;
import java.util.regex.Pattern;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3ClientBuilder;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;

/** Cloudflare R2 S3兼容对象存储适配器。 */
@Slf4j
@Component
public class CloudflareR2ObjectStorageProviderAdapter implements ObjectStorageProviderAdapter {

    public static final String PROVIDER = "cloudflareR2";
    public static final String REGION = "auto";
    private static final Pattern ENDPOINT_HOST = Pattern.compile(
            "[a-z0-9]+(?:\\.(?:eu|fedramp))?\\.r2\\.cloudflarestorage\\.com", Pattern.CASE_INSENSITIVE);

    @Override
    public String provider() {
        return PROVIDER;
    }

    @Override
    public void validate(PersistenceDtos.ObjectStorageConfig config) {
        ObjectStorageUrlBuilder.requireText(config.accessKey(), "Cloudflare R2 Access Key ID");
        ObjectStorageUrlBuilder.requireText(config.secretKey(), "Cloudflare R2 Secret Access Key");
        ObjectStorageUrlBuilder.requireText(config.bucket(), "Cloudflare R2 Bucket");
        if (StringUtils.hasText(config.region()) && !REGION.equals(config.region().trim())) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Cloudflare R2 Region必须为auto");
        }
        URI endpoint = requireHttpsUrl(config.endpoint(), "Cloudflare R2 S3 API Endpoint");
        if (!ENDPOINT_HOST.matcher(endpoint.getHost()).matches()
                || (endpoint.getPort() != -1 && endpoint.getPort() != 443)
                || (StringUtils.hasText(endpoint.getPath()) && !"/".equals(endpoint.getPath()))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "Cloudflare R2 Endpoint必须是账户级S3 API地址，不能包含Bucket或路径");
        }
        URI publicUrl = requireHttpsUrl(config.publicBaseUrl(), "Cloudflare R2公开访问地址");
        String publicHost = publicUrl.getHost().toLowerCase(Locale.ROOT);
        if (publicHost.equals("r2.cloudflarestorage.com") || publicHost.endsWith(".r2.cloudflarestorage.com")) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "Cloudflare R2公开访问地址请使用已启用的自定义域名或r2.dev地址，不能使用S3 API Endpoint");
        }
    }

    @Override
    public String putObject(PersistenceDtos.ObjectStorageConfig config, String key, InputStream inputStream,
                            long contentLength, String mimeType) {
        validate(config);
        try (S3Client client = createClient(config)) {
            PutObjectRequest.Builder request = PutObjectRequest.builder()
                    .bucket(config.bucket().trim()).key(key).contentLength(contentLength);
            if (StringUtils.hasText(mimeType)) {
                request.contentType(mimeType);
            }
            client.putObject(request.build(), RequestBody.fromInputStream(inputStream, contentLength));
            return ObjectStorageUrlBuilder.buildPublicUrl(config.publicBaseUrl().trim(), key);
        } catch (S3Exception exception) {
            log.warn("上传Cloudflare R2失败: bucket={}, status={}, requestId={}",
                    config.bucket(), exception.statusCode(), exception.requestId());
            String reason = switch (exception.statusCode()) {
                case 401, 403 -> "请检查访问密钥及Bucket对象写入权限";
                case 404 -> "请检查Bucket名称和账户Endpoint";
                default -> "存储服务返回错误，请稍后重试";
            };
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "上传Cloudflare R2失败: " + reason);
        } catch (SdkException exception) {
            log.warn("连接Cloudflare R2失败: bucket={}, exception={}", config.bucket(), exception.getClass().getSimpleName());
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "连接Cloudflare R2失败，请检查Endpoint和网络连接");
        }
    }

    S3Client createClient(PersistenceDtos.ObjectStorageConfig config) {
        return clientBuilder(config).build();
    }

    S3ClientBuilder clientBuilder(PersistenceDtos.ObjectStorageConfig config) {
        // R2要求region=auto及路径式寻址；禁用SDK 2.30+默认可选checksum和aws-chunked编码。
        return S3Client.builder()
                .endpointOverride(URI.create(config.endpoint().trim()))
                .region(Region.of(REGION))
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(config.accessKey().trim(), config.secretKey().trim())))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(true).chunkedEncodingEnabled(false).build())
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .httpClientBuilder(UrlConnectionHttpClient.builder()
                        .connectionTimeout(Duration.ofSeconds(10)).socketTimeout(Duration.ofSeconds(120)))
                .overrideConfiguration(builder -> builder
                        .apiCallAttemptTimeout(Duration.ofSeconds(150)).apiCallTimeout(Duration.ofMinutes(5)));
    }

    private URI requireHttpsUrl(String value, String fieldName) {
        ObjectStorageUrlBuilder.requireHttpUrl(value, fieldName);
        URI uri = URI.create(value.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, fieldName + "必须是HTTPS地址，且不能包含凭据、查询参数或片段");
        }
        return uri;
    }
}
