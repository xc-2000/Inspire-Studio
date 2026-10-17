package com.inspirestudio.payment;

import com.inspirestudio.repository.CreditRepository;
import com.inspirestudio.security.CurrentUserProvider;
import com.inspirestudio.task.AiTaskEventPublisher;
import io.r2dbc.spi.ConnectionFactories;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.r2dbc.connection.R2dbcTransactionManager;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Run only against a disposable database, never the application database. */
@EnabledIfEnvironmentVariable(named="WECHAT_TEST_R2DBC_URL",matches=".*wechat_payment_test.*")
class PaymentSettlementIntegrationTest {
    DatabaseClient db;PaymentService service;PaymentRepository orders;
    @BeforeEach void setup() {
        var factory=ConnectionFactories.get(System.getenv("WECHAT_TEST_R2DBC_URL"));db=DatabaseClient.create(factory);
        for(String sql:new String[]{
                "DROP TABLE IF EXISTS credit_payment_orders,user_credit_transactions,user_credit_accounts,users CASCADE",
                "CREATE TABLE users(id bigint PRIMARY KEY)",
                "CREATE TABLE user_credit_accounts(user_id bigint PRIMARY KEY,credit_balance integer NOT NULL,updated_at timestamptz)",
                "CREATE TABLE user_credit_transactions(user_id bigint,transaction_type text,operator_user_id bigint,change_amount integer,balance_after integer,reason text,CONSTRAINT ck_user_credit_transactions_type CHECK (true))"}) run(sql);
        try {
            String migration=new String(getClass().getResourceAsStream("/db/migration/V36__Wechat_Credit_Payments.sql").readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
            for(String sql:migration.split(";"))if(!sql.isBlank())run(sql);
        } catch(Exception e){throw new RuntimeException(e);}
        run("INSERT INTO users VALUES(1)");run("INSERT INTO user_credit_accounts VALUES(1,100,now())");
        orders=new PaymentRepository(db);var props=new WechatPayProperties();props.setAppId("app");props.setMerchantId("merchant");
        var events=mock(AiTaskEventPublisher.class);when(events.publish(any(),any())).thenReturn(Mono.empty());
        service=new PaymentService(props,mock(WechatGateway.class),orders,new CreditRepository(db),mock(CurrentUserProvider.class),TransactionalOperator.create(new R2dbcTransactionManager(factory)),events,mock(PaymentPackageService.class));
        run("INSERT INTO credit_payment_orders(order_no,user_id,request_id,package_id,description,amount_fen,credits,expires_at) VALUES('WXtest',1,'"+UUID.randomUUID()+"','basic','test',100,20,now()+interval '30 minutes')");
    }
    void run(String sql){db.sql(sql).fetch().rowsUpdated().block(Duration.ofSeconds(10));}
    int balance(){return db.sql("SELECT credit_balance FROM user_credit_accounts WHERE user_id=1").map((r,m)->r.get(0,Integer.class)).one().block();}
    @Test void concurrentNotificationsCreditExactlyOnce() {
        var transaction=new PaymentServiceTest().transaction();
        Flux.range(0,12).flatMap(i->service.settle(transaction),12).then().block(Duration.ofSeconds(30));
        assertEquals(120,balance());assertEquals("PAID",orders.find("WXtest",false).block().status());
        assertEquals(1L,db.sql("SELECT count(*) FROM user_credit_transactions").map((r,m)->r.get(0,Long.class)).one().block());
    }
    @Test void ledgerFailureRollsBackBothBalanceAndOrder() {
        run("ALTER TABLE user_credit_transactions ADD CONSTRAINT fail_ledger CHECK(change_amount < 0)");
        assertThrows(Exception.class,()->service.settle(new PaymentServiceTest().transaction()).block(Duration.ofSeconds(10)));
        assertEquals(100,balance());assertEquals("PENDING",orders.find("WXtest",false).block().status());
    }
    @Test void newlyCreatedOrderExpiresExactlyOneMinuteAfterCreation() {
        var order=orders.insert(1L,UUID.randomUUID(),new WechatPayProperties.CreditPackage("basic","Basic",100,20)).block();
        assertEquals(Duration.ofSeconds(60),Duration.between(order.createdAt(),order.expiresAt()));
    }
    @Test void deadlineBypassesRecentQueryThrottleButClaimsOnlyOnce() {
        run("UPDATE credit_payment_orders SET expires_at=now()-interval '1 second',last_checked_at=now()-interval '2 seconds'");
        assertEquals(1L,orders.pending().count().block());
        assertTrue(orders.claimCheck("WXtest").block());
        assertFalse(orders.claimCheck("WXtest").block());
        assertEquals(0L,orders.pending().count().block());
    }
    @Test void migrationShortensOnlyUnpaidOrdersAndDoesNotClaimTheyAreClosed() throws Exception {
        run("UPDATE credit_payment_orders SET created_at=now()-interval '2 minutes',last_checked_at=now()");
        var paid=orders.insert(1L,UUID.randomUUID(),new WechatPayProperties.CreditPackage("basic","Basic",100,20)).block();
        orders.paid(paid.orderNo(),"paid-preserved",java.time.OffsetDateTime.now()).block();
        String sql=new String(getClass().getResourceAsStream("/db/migration/V62__Payment_One_Minute_Expiry.sql").readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
        run(sql);
        var unpaid=orders.find("WXtest",false).block();
        assertEquals(Duration.ofSeconds(60),Duration.between(unpaid.createdAt(),unpaid.expiresAt()));
        assertEquals("PENDING",unpaid.status());
        assertTrue(orders.claimCheck("WXtest").block());
        var unchanged=orders.find(paid.orderNo(),false).block();
        assertEquals("PAID",unchanged.status());assertEquals(paid.expiresAt(),unchanged.expiresAt());
    }
    @Test void concurrentCloseAndLateSuccessCannotLoseOrDuplicatePayment() {
        orders.closed("WXtest").block();
        var t=new PaymentServiceTest().transaction();
        Flux.merge(service.settle(t),service.settle(t),orders.closed("WXtest")).then().block(Duration.ofSeconds(30));
        assertEquals("PAID",orders.find("WXtest",false).block().status());
        assertEquals(120,balance());
        assertEquals(1L,db.sql("SELECT count(*) FROM user_credit_transactions").map((r,m)->r.get(0,Long.class)).one().block());
    }
}
