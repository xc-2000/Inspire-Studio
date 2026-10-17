package com.inspirestudio.service;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.RegistrationEmailDtos.Policy;
import com.inspirestudio.dto.RegistrationEmailDtos.Settings;
import com.inspirestudio.repository.RegistrationEmailRepository;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

@Service
@RequiredArgsConstructor
public class RegistrationEmailPolicyService {
    private static final Pattern DOMAIN = Pattern.compile(
            "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])");
    private static final Pattern LOCAL = Pattern.compile("[a-z0-9!#$%&'*+/=?^_`{|}~.-]+");
    private final RegistrationEmailRepository repository;

    public Mono<Settings> getSettings() {
        // Do not silently reopen registration if the settings record is missing.
        return repository.get().switchIfEmpty(Mono.error(
                new BusinessException(ErrorCode.BUSINESS_ERROR, "注册设置暂不可用，请稍后重试")));
    }

    public Mono<Policy> getPolicy() {
        return getSettings().map(settings -> new Policy(settings.enabled(),
                settings.enabled() ? settings.allowedDomains() : java.util.List.of()));
    }

    public Mono<Settings> save(Settings settings) {
        return Mono.defer(() -> {
            Settings normalized = normalizeSettings(settings);
            return repository.save(normalized).flatMap(saved -> saved ? getSettings() : Mono.error(
                    new BusinessException(ErrorCode.BUSINESS_ERROR, "注册设置已被其他管理员修改，请刷新后重试")));
        });
    }

    /** Only call for new registrations; existing login/reset/admin bootstrap must remain available. */
    public Mono<Void> validateRegistration(String value) {
        return Mono.defer(() -> {
            String email = normalizeRegistrationEmail(value);
            String domain = email.substring(email.lastIndexOf('@') + 1);
            return getSettings().flatMap(settings -> {
                if (!settings.enabled() || settings.allowedDomains().contains(domain)) {
                    return Mono.empty();
                }
                String message = settings.allowedDomains().isEmpty()
                        ? "暂未开放邮箱注册，请联系管理员"
                        : "该邮箱后缀尚未开放注册，请使用已开放的邮箱";
                return Mono.error(new BusinessException(ErrorCode.PARAM_INVALID, message));
            });
        });
    }

    static String normalizeRegistrationEmail(String value) {
        String email = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        int at = email.indexOf('@');
        if (email.length() > 254 || at < 1 || at > 64 || at != email.lastIndexOf('@')) throw invalidEmail();
        String local = email.substring(0, at);
        if (!LOCAL.matcher(local).matches() || local.startsWith(".") || local.endsWith(".")
                || local.contains("..") || !validDomain(email.substring(at + 1))) throw invalidEmail();
        return email;
    }

    static Settings normalizeSettings(Settings settings) {
        if (settings == null || settings.version() < 0 || settings.allowedDomains() == null
                || settings.allowedDomains().size() > 100) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "最多配置 100 个邮箱后缀");
        }
        var domains = new LinkedHashSet<String>();
        for (String raw : settings.allowedDomains()) {
            String domain = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
            if (domain.startsWith("@")) domain = domain.substring(1);
            if (!validDomain(domain)) {
                throw new BusinessException(ErrorCode.PARAM_INVALID, "邮箱后缀格式不正确，请填写 qq.com 这样的域名");
            }
            domains.add(domain);
        }
        return new Settings(settings.enabled(), new ArrayList<>(domains), settings.version());
    }

    private static boolean validDomain(String domain) {
        return domain.length() <= 253 && DOMAIN.matcher(domain).matches();
    }

    private static BusinessException invalidEmail() {
        return new BusinessException(ErrorCode.PARAM_INVALID, "邮箱格式不正确");
    }
}

