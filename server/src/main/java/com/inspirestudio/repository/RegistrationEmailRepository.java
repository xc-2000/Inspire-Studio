package com.inspirestudio.repository;

import com.inspirestudio.dto.RegistrationEmailDtos.Settings;
import java.util.Arrays;
import lombok.RequiredArgsConstructor;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Mono;

@Repository
@RequiredArgsConstructor
public class RegistrationEmailRepository {
    private final DatabaseClient databaseClient;

    public Mono<Settings> get() {
        return databaseClient.sql("SELECT enabled, allowed_domains, version FROM registration_email_settings WHERE id = 1")
                .map((row, metadata) -> new Settings(Boolean.TRUE.equals(row.get("enabled", Boolean.class)),
                        Arrays.asList(row.get("allowed_domains", String[].class)), row.get("version", Integer.class)))
                .one();
    }

    public Mono<Boolean> save(Settings settings) {
        return databaseClient.sql("""
                        UPDATE registration_email_settings
                        SET enabled = :enabled, allowed_domains = :domains,
                            version = version + 1, updated_at = CURRENT_TIMESTAMP
                        WHERE id = 1 AND version = :version
                        """)
                .bind("enabled", settings.enabled())
                .bind("domains", settings.allowedDomains().toArray(String[]::new))
                .bind("version", settings.version())
                .fetch().rowsUpdated().map(count -> count == 1);
    }
}

