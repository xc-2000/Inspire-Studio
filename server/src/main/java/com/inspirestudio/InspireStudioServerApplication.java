package com.inspirestudio;

import com.inspirestudio.config.DatabaseBootstrapInitializer;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * @title        InspireStudioServerApplication.java
 * @description  Inspire Studio Java服务端入口
 * @createTime   2026-06-24 10:36:00
 */
@SpringBootApplication
@EnableScheduling
public class InspireStudioServerApplication {

    /**
     * 服务端启动入口
     *
     * @param args String[] 启动参数
     */
    public static void main(String[] args) {
        SpringApplication application = new SpringApplication(InspireStudioServerApplication.class);
        application.addInitializers(new DatabaseBootstrapInitializer());
        application.run(args);
    }
}
