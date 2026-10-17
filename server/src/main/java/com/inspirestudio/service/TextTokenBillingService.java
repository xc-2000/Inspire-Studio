package com.inspirestudio.service;

import com.alibaba.fastjson2.JSONObject;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.security.CurrentUserProvider;
import io.agentscope.core.message.Msg;
import io.agentscope.core.model.*;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.transaction.reactive.TransactionalOperator;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Per-call actual usage billing. Prices are snapshotted before invoking the provider. */
@Service
@RequiredArgsConstructor
public class TextTokenBillingService {
    private final DatabaseClient db;
    private final CreditService credits;
    private final CurrentUserProvider users;
    private final TransactionalOperator transaction;

    public record Price(String modelConfigId, String officialModel, BigDecimal inputPrice, BigDecimal outputPrice, BigDecimal multiplier, String currency, BigDecimal exchangeRate, int version) {
        public boolean paid() { return multiplier.signum()>0 && (inputPrice.signum() > 0 || outputPrice.signum() > 0); }
    }
    public Mono<Price> price(String id) {
        return db.sql("SELECT official_model,input_price,output_price,multiplier,currency,exchange_rate,version FROM text_model_token_prices WHERE model_config_id=:id")
                .bind("id",id).map((r,m)->new Price(id,r.get("official_model",String.class),r.get("input_price",BigDecimal.class),r.get("output_price",BigDecimal.class),r.get("multiplier",BigDecimal.class),r.get("currency",String.class),r.get("exchange_rate",BigDecimal.class),r.get("version",Integer.class))).one()
                .defaultIfEmpty(new Price(id,"",BigDecimal.ZERO,BigDecimal.ZERO,BigDecimal.ONE,"CNY",BigDecimal.ONE,0));
    }
    public Flux<Price> list() {
        return db.sql("SELECT model_config_id,official_model,input_price,output_price,multiplier,currency,exchange_rate,version FROM text_model_token_prices")
                .map((r,m)->new Price(r.get("model_config_id",String.class),r.get("official_model",String.class),r.get("input_price",BigDecimal.class),r.get("output_price",BigDecimal.class),r.get("multiplier",BigDecimal.class),r.get("currency",String.class),r.get("exchange_rate",BigDecimal.class),r.get("version",Integer.class))).all();
    }
    public Mono<Price> save(Price p) {
        OfficialRate rate = officialRates().stream().filter(r -> r.id().equals(p.officialModel())).findFirst().orElseThrow(() -> invalid("请选择已核验的官方价格"));
        validatePrice(p.multiplier());
        BigDecimal fx = "CNY".equals(rate.currency()) ? BigDecimal.ONE : p.exchangeRate();
        validatePrice(fx);
        if(fx.signum()<=0) throw invalid("请填写大于0的人民币汇率");
        if(p.modelConfigId()==null || p.modelConfigId().isBlank() || p.version()<0) return Mono.error(invalid("模型配置不合法"));
        return db.sql("SELECT count(*) AS n FROM platform_ai_model_configs WHERE model_config_id=:id AND model_type='text'")
                .bind("id",p.modelConfigId()).map((r,m)->r.get("n",Long.class)).one()
                .flatMap(n-> n==0 ? Mono.error(invalid("文本模型不存在")) : db.sql("""
                    INSERT INTO text_model_token_prices(model_config_id,official_model,input_price,output_price,multiplier,currency,exchange_rate)
                    SELECT :id,:official,:input,:output,:multiplier,:currency,:fx WHERE :version=0
                    ON CONFLICT(model_config_id) DO NOTHING
                    """).bind("id",p.modelConfigId()).bind("official",rate.id()).bind("input",rate.inputPrice()).bind("output",rate.outputPrice()).bind("multiplier",p.multiplier()).bind("currency",rate.currency()).bind("fx",fx).bind("version",p.version()).fetch().rowsUpdated())
                .flatMap(inserted -> inserted>0 ? Mono.just(inserted) : db.sql("""
                    UPDATE text_model_token_prices SET official_model=:official,input_price=:input,output_price=:output,multiplier=:multiplier,currency=:currency,exchange_rate=:fx,version=version+1,updated_at=now()
                    WHERE model_config_id=:id AND version=:version
                    """).bind("id",p.modelConfigId()).bind("official",rate.id()).bind("input",rate.inputPrice()).bind("output",rate.outputPrice()).bind("multiplier",p.multiplier()).bind("currency",rate.currency()).bind("fx",fx).bind("version",p.version()).fetch().rowsUpdated())
                .flatMap(n->n==0 ? Mono.error(invalid("价格已被其他管理员修改，请刷新后重试")) : price(p.modelConfigId())).as(transaction::transactional);
    }
    public static void validatePrice(BigDecimal value) {
        if(value==null || value.signum()<0 || value.scale()>6 || value.compareTo(new BigDecimal("1000000"))>0)
            throw invalid("Token 单价须为0至1000000，最多6位小数");
    }
    public static int calculate(Price p,long input,long output) {
        if(input<0 || output<0) throw invalid("Token 用量不合法");
        try { return p.inputPrice().multiply(BigDecimal.valueOf(input)).add(p.outputPrice().multiply(BigDecimal.valueOf(output)))
                .multiply(p.multiplier()).multiply(p.exchangeRate()).divide(BigDecimal.valueOf(9900),0,RoundingMode.CEILING).intValueExact(); }
        catch(ArithmeticException e) { throw invalid("Token 费用超出范围"); }
    }
    private Mono<Void> preflight(Long user, Price p) {
        if(!p.paid()) return Mono.empty();
        return db.sql("SELECT credit_balance FROM user_credit_accounts WHERE user_id=:id").bind("id",user)
                .map((r,m)->r.get("credit_balance",Integer.class)).one().defaultIfEmpty(0)
                .flatMap(balance->balance<=0 ? Mono.error(invalid("积分不足，无法调用文本模型")) : Mono.empty());
    }
    public Mono<Integer> settle(Long user,String callId,Price p,long input,long output) {
        if(input<0 || output<0) return p.paid() ? Mono.error(invalid("供应商未返回完整 Token 用量，无法结算，请检查渠道是否支持 usage")) : Mono.just(0);
        int cost=calculate(p,input,output);
        return db.sql("""
            INSERT INTO text_token_usage(call_id,user_id,model_config_id,input_tokens,output_tokens,input_price,output_price,multiplier,currency,exchange_rate,credits)
            VALUES(:call,:user,:model,:input,:output,:ip,:op,:multiplier,:currency,:fx,:credits) ON CONFLICT(call_id) DO NOTHING
            """).bind("call",callId).bind("user",user).bind("model",p.modelConfigId()).bind("input",input).bind("output",output)
                .bind("ip",p.inputPrice()).bind("op",p.outputPrice()).bind("multiplier",p.multiplier()).bind("currency",p.currency()).bind("fx",p.exchangeRate()).bind("credits",cost).fetch().rowsUpdated()
                .flatMap(n->n==0 ? Mono.just(0) : credits.chargeOperation(user,"token:"+callId,cost,
                        "文本Token：输入"+input+" / 输出"+output).thenReturn(cost))
                .as(transaction::transactional);
    }
    public Mono<JSONObject> executeTask(Long user,String callId,String modelId,Supplier<Mono<JSONObject>> invoke) {
        return price(modelId).flatMap(p->preflight(user,p).then(Mono.defer(invoke)).flatMap(result->{
            JSONObject usage=result.getJSONObject("tokenUsage");
            long input=usage==null ? -1: usage.getLongValue("inputTokens",-1);
            long output=usage==null ? -1: usage.getLongValue("outputTokens",-1);
            return settle(user,callId,p,input,output).map(cost->{result.put("tokenCredits",cost);return result;});
        }));
    }
    public Model wrap(Model delegate,String modelId,Long userId) {
        return new BilledModel() {
            private final java.util.concurrent.atomic.AtomicInteger charged = new java.util.concurrent.atomic.AtomicInteger();
            public int chargedCredits(){return charged.get();}
            public String getModelName(){return delegate.getModelName();}
            public int getContextWindowSize(){return delegate.getContextWindowSize();}
            public boolean supportsNativeStructuredOutput(){return delegate.supportsNativeStructuredOutput();}
            public Flux<ChatResponse> stream(List<Msg> messages,List<ToolSchema> tools,GenerateOptions options){
                return Flux.defer(()->{
                    String call=UUID.randomUUID().toString(); AtomicLong input=new AtomicLong(-1),output=new AtomicLong(-1);
                    return (userId==null ? users.currentUserId():Mono.just(userId)).flatMapMany(user->price(modelId).flatMapMany(p->
                        preflight(user,p).thenMany(delegate.stream(messages,tools,options))
                            .doOnNext(response->{if(response.getUsage()!=null){input.accumulateAndGet(response.getUsage().getInputTokens(),Math::max);output.accumulateAndGet(response.getUsage().getOutputTokens(),Math::max);}})
                            .concatWith(Mono.defer(()->settle(user,call,p,input.get(),output.get()).doOnNext(charged::addAndGet).then(Mono.<ChatResponse>empty())))));
                });
            }
        };
    }
    public interface BilledModel extends Model { int chargedCredits(); }
    public static int chargedCredits(Model model) { return model instanceof BilledModel billed ? billed.chargedCredits() : 0; }
    public record OfficialRate(String id,String label,String vendor,String currency,BigDecimal inputPrice,BigDecimal outputPrice,String sourceUrl,String checkedAt,String note) {}
    private static final List<OfficialRate> OFFICIAL_RATES = loadRates();
    private static List<OfficialRate> loadRates() {
        try (var in = new org.springframework.core.io.ClassPathResource("pricing/official-text-prices.json").getInputStream()) {
            var rates = com.alibaba.fastjson2.JSON.parseArray(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8), OfficialRate.class);
            if(rates.isEmpty() || rates.stream().map(OfficialRate::id).distinct().count()!=rates.size()) throw new IllegalStateException("Invalid official pricing catalog");
            return List.copyOf(rates);
        } catch(java.io.IOException e) { throw new IllegalStateException("Cannot load official pricing catalog",e); }
    }
    public static List<OfficialRate> officialRates() { return OFFICIAL_RATES; }
    private static BusinessException invalid(String message){return new BusinessException(ErrorCode.BUSINESS_ERROR,message);}
}
