package com.inspirestudio.payment;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

@Service
@RequiredArgsConstructor
public class PaymentPackageService {
    private final PaymentRepository repository;
    private final WechatPayProperties properties;
    private final CurrentUserProvider users;
    private static final ObjectMapper JSON=new ObjectMapper();
    public record Package(String id,String name,int amountFen,int credits,boolean enabled,int sortOrder,
                          String subtitle,boolean recommended,List<String> features) {
        public Package {
            subtitle = subtitle == null ? "" : subtitle.trim();
            features = features == null ? List.of() : List.copyOf(features);
        }
        public Package(String id,String name,int amountFen,int credits,boolean enabled,int sortOrder) {
            this(id,name,amountFen,credits,enabled,sortOrder,"",false,List.of());
        }
    }
    public record Settings(int version,List<Package> items) {}
    public Mono<Settings> get() {
        return repository.packageData().map(data -> {
            try {
                List<Package> items="null".equals(data.json()) ? properties.packages().stream()
                        .map(p->new Package(p.id(),p.name(),p.amountFen(),p.credits(),true,0,p.subtitle(),p.recommended(),p.features())).toList()
                        : JSON.readValue(data.json(),new TypeReference<List<Package>>() {});
                validate(items);
                return new Settings(data.version(),items.stream().sorted(Comparator.comparingInt(Package::sortOrder).thenComparing(Package::id)).toList());
            } catch(Exception e) { throw new BusinessException(ErrorCode.BUSINESS_ERROR,"套餐配置无效，请检查后台配置"); }
        });
    }
    public Mono<List<WechatPayProperties.CreditPackage>> active() {
        return get().map(settings->settings.items().stream().filter(Package::enabled)
                .map(p->new WechatPayProperties.CreditPackage(p.id(),p.name(),p.amountFen(),p.credits(),p.subtitle(),p.recommended(),p.features())).toList());
    }
    public Mono<Settings> save(Settings settings) {
        return Mono.defer(()-> {
            if(settings==null || settings.version()<0)throw invalid();
            validate(settings.items());
            final String json;
            try { json=JSON.writeValueAsString(settings.items()); } catch(Exception e) { throw invalid(); }
            return users.currentUserId().flatMap(uid->repository.savePackages(json,settings.version(),uid))
                    .flatMap(saved->saved ? get() : Mono.error(new BusinessException(ErrorCode.BUSINESS_ERROR,"套餐已被其他管理员更新，请刷新后重试")));
        });
    }
    static void validate(List<Package> items) {
        if(items==null || items.size()>20)throw invalid();
        var ids=new HashSet<String>();
        if (items.stream().filter(p -> p != null && p.enabled() && p.recommended()).count() > 1)
            throw new BusinessException(ErrorCode.PARAM_INVALID,"只能设置一个已上架套餐为推荐套餐");
        for(var p:items) if(p==null || p.id()==null || !p.id().matches("[a-zA-Z0-9_-]{1,64}") || !ids.add(p.id())
                || p.name()==null || p.name().isBlank() || p.name().length()>40
                || p.amountFen()<1 || p.amountFen()>1000000 || p.credits()<1 || p.credits()>10000000
                || p.sortOrder()<0 || p.sortOrder()>9999 || p.subtitle().length()>80
                || p.features().size()>6 || p.features().stream().anyMatch(feature -> feature == null || feature.isBlank() || feature.length()>60))throw invalid();
    }
    private static BusinessException invalid() {
        return new BusinessException(ErrorCode.PARAM_INVALID,"套餐参数无效：最多20档，价格0.01至10000元，积分1至10000000，排序0至9999，名称最多40字，简介最多80字，说明最多6条且每条最多60字");
    }
}
