package com.housesync.finance.connection.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * Dedicated exact-decimal mapper for provider payloads. The shared request mapper deliberately
 * coerces nothing and is tuned for browser validation, while {@code readTree} on the default tree
 * mapper produces floating-point {@code DoubleNode} values that silently destroy provider decimal
 * tokens. This mapper enables {@code USE_BIG_DECIMAL_FOR_FLOATS} so the adapter can parse JSON
 * decimal tokens directly to {@link java.math.BigDecimal} without any binary float step.
 */
@Configuration(proxyBeanMethods = false)
public class ProviderJsonConfiguration {

  @Bean("providerJsonMapper")
  ObjectMapper providerJsonMapper() {
    return JsonMapper.builder().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).build();
  }
}
