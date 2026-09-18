package com.housesync.finance.connection.config;

import com.housesync.finance.connection.plaid.FakePlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidAdapter;
import com.housesync.finance.connection.plaid.PlaidHttpAdapter;
import java.time.Clock;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import tools.jackson.databind.ObjectMapper;

/**
 * Wires the provider boundary. Fail-closed validation runs eagerly at startup whenever the
 * feature is enabled; the default-disabled application constructs the same beans without requiring
 * any provider secret or encryption key. The deterministic fake exists as a bean for tests and
 * explicit local configuration only and is never selected silently.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(ConnectedFinanceProperties.class)
@EnableScheduling
public class ConnectedFinanceConfiguration {

  private final ConnectedFinanceProperties properties;

  public ConnectedFinanceConfiguration(ConnectedFinanceProperties properties) {
    this.properties = properties;
    properties.validateFailClosed();
  }

  @Bean
  @org.springframework.context.annotation.Primary
  PlaidAdapter plaidAdapter(
      ConnectedFinanceProperties properties, PlaidHttpAdapter http, FakePlaidAdapter fake) {
    if ("fake".equalsIgnoreCase(properties.getProvider())) {
      if (!properties.isFakeAllowed()) {
        throw new IllegalStateException(
            "fake provider requires explicit app.connected-finance.fake-allowed=true");
      }
      return fake;
    }
    return http;
  }

  @Bean
  PlaidHttpAdapter plaidHttpAdapter(
      ConnectedFinanceProperties properties,
      @org.springframework.beans.factory.annotation.Qualifier("providerJsonMapper")
          ObjectMapper providerJsonMapper,
      Clock clock) {
    return new PlaidHttpAdapter(properties, providerJsonMapper, clock);
  }

  @Bean
  FakePlaidAdapter fakePlaidAdapter(Clock clock) {
    return new FakePlaidAdapter(clock);
  }

  /** Jitter source for the revocation retry schedule; tests inject a seeded equivalent. */
  @Bean
  java.util.Random revocationJitter() {
    return new java.util.Random();
  }
}
