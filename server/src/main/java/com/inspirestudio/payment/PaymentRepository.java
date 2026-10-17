package com.inspirestudio.payment;

import java.time.OffsetDateTime;
import java.util.UUID;
import io.r2dbc.spi.Row;
import lombok.RequiredArgsConstructor;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@Repository
@RequiredArgsConstructor
public class PaymentRepository {
    private final DatabaseClient db;
    // Check a just-expired order immediately even if it was queried shortly before expiry.
    private static final String CHECK_DUE = """
            (last_checked_at IS NULL
             OR (expires_at<=now() AND last_checked_at<expires_at)
             OR last_checked_at<now()-CASE WHEN expires_at<=now()
                 THEN interval '5 seconds' ELSE interval '10 seconds' END)
            """;
    public record PackageData(String json,int version) {}
    public Mono<PackageData> packageData() {
        return db.sql("SELECT COALESCE(packages_json::text,'null') AS data,packages_version FROM payment_collection_settings WHERE id=1")
                .map((r,m)->new PackageData(r.get("data",String.class),r.get("packages_version",Integer.class))).one();
    }
    public Mono<Boolean> savePackages(String json,int version,Long userId) {
        return db.sql("UPDATE payment_collection_settings SET packages_json=CAST(:data AS jsonb),packages_version=packages_version+1,updated_by=:uid,updated_at=now() WHERE id=1 AND packages_version=:version")
                .bind("data",json).bind("uid",userId).bind("version",version).fetch().rowsUpdated().map(n->n==1);
    }
    public Mono<Boolean> collectionEnabled(boolean defaultValue) {
        return db.sql("SELECT COALESCE(enabled,:fallback) AS enabled FROM payment_collection_settings WHERE id=1")
                .bind("fallback",defaultValue).map((r,m)->r.get("enabled",Boolean.class)).one().defaultIfEmpty(false);
    }
    public Mono<Void> setCollectionEnabled(boolean enabled,Long userId) {
        return db.sql("UPDATE payment_collection_settings SET enabled=:enabled,updated_by=:uid,updated_at=now() WHERE id=1")
                .bind("enabled",enabled).bind("uid",userId).fetch().rowsUpdated().then();
    }
    public record Order(String orderNo, Long userId, String packageId, String description, int amountFen, int credits,
                        String status, String codeUrl, String transactionId, OffsetDateTime expiresAt,
                        OffsetDateTime paidAt, OffsetDateTime createdAt) {}
    private Order map(Row r) {
        return new Order(r.get("order_no",String.class),r.get("user_id",Long.class),r.get("package_id",String.class),
                r.get("description",String.class),r.get("amount_fen",Integer.class),r.get("credits",Integer.class),
                r.get("status",String.class),r.get("code_url",String.class),r.get("transaction_id",String.class),
                r.get("expires_at",OffsetDateTime.class),r.get("paid_at",OffsetDateTime.class),r.get("created_at",OffsetDateTime.class));
    }
    public Mono<Void> lockUser(Long userId) {
        return db.sql("SELECT pg_advisory_xact_lock(:id)").bind("id",userId).fetch().rowsUpdated().then();
    }
    public Mono<Order> byRequest(Long userId, UUID requestId) {
        return db.sql("SELECT * FROM credit_payment_orders WHERE user_id=:uid AND request_id=:rid")
                .bind("uid",userId).bind("rid",requestId).map((r,m)->map(r)).one();
    }
    public Mono<Long> recentCount(Long userId) {
        return db.sql("SELECT count(*) AS n FROM credit_payment_orders WHERE user_id=:uid AND created_at>now()-interval '1 hour'")
                .bind("uid",userId).map((r,m)->r.get("n",Long.class)).one();
    }
    public Mono<Order> insert(Long userId, UUID requestId, WechatPayProperties.CreditPackage pack) {
        String no="WX"+UUID.randomUUID().toString().replace("-", "").substring(0,30);
        return db.sql("""
            INSERT INTO credit_payment_orders(order_no,user_id,request_id,package_id,description,amount_fen,credits,expires_at)
            VALUES(:no,:uid,:rid,:pid,:description,:amount,:credits,now()+interval '1 minute') RETURNING *
            """).bind("no",no).bind("uid",userId).bind("rid",requestId).bind("pid",pack.id())
                .bind("description","Inspire Studio - "+pack.name()).bind("amount",pack.amountFen()).bind("credits",pack.credits())
                .map((r,m)->map(r)).one();
    }
    public Mono<Order> find(String no, boolean lock) {
        return db.sql("SELECT * FROM credit_payment_orders WHERE order_no=:no"+(lock?" FOR UPDATE":""))
                .bind("no",no).map((r,m)->map(r)).one();
    }
    public Mono<Order> owned(String no, Long userId) {
        return find(no,false).filter(o->o.userId().equals(userId));
    }
    public Mono<Void> setCode(String no,String code) {
        return db.sql("UPDATE credit_payment_orders SET code_url=:code WHERE order_no=:no AND status='PENDING'")
                .bind("no",no).bind("code",code).fetch().rowsUpdated().then();
    }
    public Mono<Void> paid(String no,String transactionId,OffsetDateTime time) {
        return db.sql("UPDATE credit_payment_orders SET status='PAID',transaction_id=:tx,paid_at=:time WHERE order_no=:no")
                .bind("no",no).bind("tx",transactionId).bind("time",time).fetch().rowsUpdated().then();
    }
    public Mono<Void> closed(String no) {
        return db.sql("UPDATE credit_payment_orders SET status='CLOSED' WHERE order_no=:no AND status='PENDING'")
                .bind("no",no).fetch().rowsUpdated().then();
    }
    public Mono<Boolean> claimCheck(String no) {
        return db.sql("UPDATE credit_payment_orders SET last_checked_at=now() WHERE order_no=:no AND status='PENDING' AND "+CHECK_DUE)
                .bind("no",no).fetch().rowsUpdated().map(n->n>0);
    }
    public Flux<Order> pending() {
        return db.sql("SELECT * FROM credit_payment_orders WHERE status='PENDING' AND "+CHECK_DUE
                +" ORDER BY last_checked_at NULLS FIRST,expires_at LIMIT 50")
                .map((r,m)->map(r)).all();
    }
    public Flux<Order> list(Long userId,int page,int size) {
        var spec=db.sql("SELECT * FROM credit_payment_orders"+(userId==null?"":" WHERE user_id=:uid")+" ORDER BY created_at DESC,order_no LIMIT :limit OFFSET :offset")
                .bind("limit",size).bind("offset",(page-1)*size);
        if(userId!=null)spec=spec.bind("uid",userId);
        return spec.map((r,m)->map(r)).all();
    }
    public Mono<Long> count(Long userId) {
        var spec=db.sql("SELECT count(*) AS n FROM credit_payment_orders"+(userId==null?"":" WHERE user_id=:uid"));
        if(userId!=null)spec=spec.bind("uid",userId);
        return spec.map((r,m)->r.get("n",Long.class)).one();
    }
}
