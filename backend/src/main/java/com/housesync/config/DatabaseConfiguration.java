package com.housesync.config;

import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.util.Assert;

@Configuration(proxyBeanMethods = false)
public class DatabaseConfiguration {

  @Bean
  static BeanFactoryPostProcessor requireDatabasePassword(Environment environment) {
    // Validate before datasource creation; binding alone can preserve an unresolved placeholder.
    return beanFactory ->
        Assert.hasText(
            environment.getRequiredProperty("DB_PASSWORD"), "DB_PASSWORD must not be blank");
  }
}
