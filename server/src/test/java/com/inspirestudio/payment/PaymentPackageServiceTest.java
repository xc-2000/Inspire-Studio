package com.inspirestudio.payment;

import com.inspirestudio.security.CurrentUserProvider;
import java.util.List;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;

class PaymentPackageServiceTest {
    final PaymentRepository repository=mock(PaymentRepository.class);
    final WechatPayProperties properties=new WechatPayProperties();
    final CurrentUserProvider users=mock(CurrentUserProvider.class);
    final PaymentPackageService service=new PaymentPackageService(repository,properties,users);
    @Test void emptySavedListDoesNotRestoreLegacyPackages() {
        properties.setPackagesJson("[{\"id\":\"old\",\"name\":\"旧套餐\",\"amountFen\":100,\"credits\":20}]");
        when(repository.packageData()).thenReturn(Mono.just(new PaymentRepository.PackageData("[]",1)));
        StepVerifier.create(service.active()).expectNext(List.of()).verifyComplete();
    }
    @Test void legacyPackagesRemainBeforeFirstSave() {
        properties.setPackagesJson("[{\"id\":\"old\",\"name\":\"旧套餐\",\"amountFen\":100,\"credits\":20}]");
        when(repository.packageData()).thenReturn(Mono.just(new PaymentRepository.PackageData("null",0)));
        StepVerifier.create(service.active()).expectNextMatches(items->items.size()==1 && items.getFirst().amountFen()==100).verifyComplete();
    }
    @Test void inactivePackagesExcludedAndActivePackagesSorted() {
        String json="""
            [{"id":"a","name":"A","amountFen":100,"credits":20,"enabled":false,"sortOrder":0},
             {"id":"b","name":"B","amountFen":200,"credits":40,"enabled":true,"sortOrder":2},
             {"id":"c","name":"C","amountFen":300,"credits":60,"enabled":true,"sortOrder":1}]
            """;
        when(repository.packageData()).thenReturn(Mono.just(new PaymentRepository.PackageData(json,2)));
        StepVerifier.create(service.active()).expectNextMatches(items->items.size()==2 && items.get(0).id().equals("c") && items.get(1).id().equals("b")).verifyComplete();
    }
    @Test void concurrentEditConflictIsReported() {
        when(users.currentUserId()).thenReturn(Mono.just(1L));
        when(repository.savePackages("[]",1,1L)).thenReturn(Mono.just(false));
        StepVerifier.create(service.save(new PaymentPackageService.Settings(1,List.of()))).expectErrorMatches(e->e.getMessage().contains("其他管理员")).verify();
    }
    @Test void presentationMetadataSurvivesSaveAndPublicCatalogWithoutChangingAmount() {
        var pack = new PaymentPackageService.Package("pro","专业",5990,7500,true,3,"适合持续创作",true,List.of("支持图片与视频生成"));
        when(users.currentUserId()).thenReturn(Mono.just(1L));
        when(repository.savePackages(anyString(),eq(3),eq(1L))).thenAnswer(invocation -> {
            String saved = invocation.getArgument(0);
            when(repository.packageData()).thenReturn(Mono.just(new PaymentRepository.PackageData(saved,4)));
            return Mono.just(true);
        });
        StepVerifier.create(service.save(new PaymentPackageService.Settings(3,List.of(pack))))
                .expectNextMatches(saved -> saved.version()==4 && saved.items().getFirst().equals(pack)).verifyComplete();
        StepVerifier.create(service.active()).expectNextMatches(items -> {
            var p = items.getFirst();
            return p.amountFen()==5990 && p.credits()==7500 && p.recommended()
                    && p.subtitle().equals("适合持续创作") && p.features().equals(List.of("支持图片与视频生成"));
        }).verifyComplete();
    }
    @Test void rejectsCompetingRecommendationsAndOversizedDescriptions() {
        var first = new PaymentPackageService.Package("a","A",990,1000,true,1,"",true,List.of());
        var second = new PaymentPackageService.Package("b","B",2990,3300,true,2,"",true,List.of());
        assertThrows(Exception.class,()->PaymentPackageService.validate(List.of(first,second)));
        assertThrows(Exception.class,()->PaymentPackageService.validate(List.of(new PaymentPackageService.Package("a","A",990,1000,true,1,"x".repeat(81),false,List.of()))));
        assertThrows(Exception.class,()->PaymentPackageService.validate(List.of(new PaymentPackageService.Package("a","A",990,1000,true,1,"",false,List.of(" ")))));
    }
    @Test void rejectsDuplicateIdsInvalidPriceAndCredits() {
        var valid=new PaymentPackageService.Package("a","A",1,1,true,0);
        assertThrows(Exception.class,()->PaymentPackageService.validate(List.of(valid,valid)));
        assertThrows(Exception.class,()->PaymentPackageService.validate(List.of(new PaymentPackageService.Package("a","A",0,1,true,0))));
        assertThrows(Exception.class,()->PaymentPackageService.validate(List.of(new PaymentPackageService.Package("a","A",100,0,true,0))));
        assertDoesNotThrow(()->PaymentPackageService.validate(List.of(valid)));
    }
}
