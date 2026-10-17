package com.inspirestudio.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

import com.inspirestudio.security.CurrentUserProvider;
import io.r2dbc.spi.ConnectionFactories;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.core.io.ClassPathResource;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.r2dbc.connection.R2dbcTransactionManager;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Mono;

/** Runs only against a disposable PostgreSQL container, never the application database. */
@EnabledIfEnvironmentVariable(named="TOKEN_BILLING_TEST_DB", matches="disposable")
class TextTokenBillingDatabaseTest {
    @Test void migrationCasIndependentRatesIdempotenceAndRollback() throws Exception {
        var factory = ConnectionFactories.get("r2dbc:postgresql://postgres@localhost:5432/postgres");
        var db = DatabaseClient.create(factory);
        var tx = TransactionalOperator.create(new R2dbcTransactionManager(factory));
        db.sql("CREATE TABLE platform_ai_model_configs(model_config_id VARCHAR(64) PRIMARY KEY,model_name TEXT,model_type TEXT)").fetch().rowsUpdated().block();
        db.sql("INSERT INTO platform_ai_model_configs VALUES('m1','kimi-k3-1','text'),('m2','kimi-k3-1','text'),('image','image','image')").fetch().rowsUpdated().block();
        String migration = new String(new ClassPathResource("db/migration/V41__Text_Token_Billing.sql").getInputStream().readAllBytes(),StandardCharsets.UTF_8);
        for(String sql:migration.replaceAll("(?m)--[^\\r\\n]*", "").split(";")) if(!sql.isBlank()) db.sql(sql).fetch().rowsUpdated().block();
        db.sql("CREATE TABLE user_credit_accounts(user_id BIGINT PRIMARY KEY,credit_balance INT)").fetch().rowsUpdated().block();
        db.sql("INSERT INTO user_credit_accounts VALUES(1,1000)").fetch().rowsUpdated().block();
        CreditService credit = mock(CreditService.class); AtomicInteger calls = new AtomicInteger();
        when(credit.chargeOperation(anyLong(),anyString(),anyInt(),anyString())).thenAnswer(inv -> {
            int cost=inv.getArgument(2);
            return Mono.defer(() -> { calls.incrementAndGet(); return db.sql("UPDATE user_credit_accounts SET credit_balance=credit_balance-:cost WHERE user_id=1 AND credit_balance>=:cost")
                    .bind("cost",cost).fetch().rowsUpdated().flatMap(n -> n==1 ? Mono.empty() : Mono.error(new IllegalStateException("insufficient"))); });
        });
        var service = new TextTokenBillingService(db,credit,mock(CurrentUserProvider.class),tx);
        var original=service.price("m1").block();
        assertEquals(new BigDecimal("20.000000"),original.inputPrice());
        var update = new TextTokenBillingService.Price("m1","kimi-k3",BigDecimal.ZERO,BigDecimal.ZERO,new BigDecimal("2"),"USD",new BigDecimal("9"),1);
        var saved=service.save(update).block();
        assertEquals("CNY",saved.currency()); assertEquals(0,BigDecimal.ONE.compareTo(saved.exchangeRate()));
        assertEquals(0,new BigDecimal("20").compareTo(saved.inputPrice())); // Client cannot forge official rates.
        assertEquals(2,saved.version());
        assertEquals(0,BigDecimal.ONE.compareTo(service.price("m2").block().multiplier()));
        assertThrows(RuntimeException.class,()->service.save(update).block()); // stale editor
        assertThrows(RuntimeException.class,()->service.save(new TextTokenBillingService.Price("image","kimi-k3",null,null,BigDecimal.ONE,"CNY",BigDecimal.ONE,0)).block());
        int cost=service.settle(1L,"unique",saved,1000,100).block(); assertEquals(7,cost);
        service.settle(1L,"unique",saved,1000,100).block();
        assertEquals(1,calls.get()); assertEquals(993,db.sql("SELECT credit_balance FROM user_credit_accounts WHERE user_id=1").map((row,m)->row.get(0,Integer.class)).one().block());
        assertThrows(RuntimeException.class,()->service.settle(1L,"too-expensive",saved,1_000_000,1_000_000).block(Duration.ofSeconds(10)));
        assertEquals(0L,db.sql("SELECT count(*) FROM text_token_usage WHERE call_id='too-expensive'").map((row,m)->row.get(0,Long.class)).one().block());
        // Existing successful audit remains and includes the currency snapshot.
        assertEquals(1L,db.sql("SELECT count(*) FROM text_token_usage WHERE call_id='unique' AND currency='CNY' AND exchange_rate=1").map((row,m)->row.get(0,Long.class)).one().block());
    }
}
