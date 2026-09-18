package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.DecimalNode;
import tools.jackson.databind.node.DoubleNode;

/**
 * Proves the exact provider mapper requirement: the shared/default tree mapper produces a
 * floating-point {@code DoubleNode}, while the dedicated provider mapper parses decimal tokens
 * directly to {@code BigDecimal} with the provider's exact digits preserved.
 */
class ProviderJsonMapperTest {

  @Test
  void defaultTreeMapperUsesDoubleNodes() {
    ObjectMapper defaultMapper = new ObjectMapper();
    JsonNode value = defaultMapper.readTree("{\"amount\":1.2300}").path("amount");
    assertThat(value).isInstanceOf(DoubleNode.class);
  }

  @Test
  void providerMapperPreservesExactDecimalTokens() {
    ObjectMapper providerMapper =
        JsonMapper.builder().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).build();
    JsonNode value = providerMapper.readTree("{\"amount\":1.2300}").path("amount");
    assertThat(value).isInstanceOf(DecimalNode.class);
    assertThat(value.decimalValue().toPlainString()).isEqualTo("1.2300");

    JsonNode tiny = providerMapper.readTree("{\"amount\":0.1}").path("amount");
    assertThat(tiny.decimalValue().toPlainString()).isEqualTo("0.1");

    JsonNode huge = providerMapper.readTree("{\"amount\":12345678901.23}").path("amount");
    assertThat(huge.decimalValue().toPlainString()).isEqualTo("12345678901.23");

    JsonNode integer = providerMapper.readTree("{\"amount\":100}").path("amount");
    assertThat(integer.decimalValue().toPlainString()).isEqualTo("100");
  }
}
