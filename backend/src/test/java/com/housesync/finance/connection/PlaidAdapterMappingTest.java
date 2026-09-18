package com.housesync.finance.connection;

import static org.assertj.core.api.Assertions.assertThat;

import com.housesync.finance.connection.plaid.PlaidHttpAdapter;
import com.housesync.finance.connection.plaid.ProviderErrorClass;
import java.lang.reflect.Method;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import tools.jackson.databind.ObjectMapper;

class PlaidAdapterMappingTest {

  @ParameterizedTest
  @CsvSource({
    "ITEM_LOGIN_REQUIRED, 400, REAUTH_REQUIRED",
    "INVALID_CREDENTIALS, 400, REAUTH_REQUIRED",
    "USER_CONSENT_REVOKED, 400, CONSENT_REVOKED",
    "RATE_LIMIT_EXCEEDED, 429, RATE_LIMITED",
    "TRANSACTIONS_NOT_READY, 400, NOT_READY",
    "INVALID_REQUEST, 400, PERMANENT",
    "ITEM_CONCURRENTLY_DELETED, 400, PERMANENT",
    "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, 400, PAGINATION_RESTART",
    "ITEM_NOT_FOUND, 400, PERMANENT",
    "INSTITUTION_DOWN, 500, TRANSIENT",
    "'', 500, TRANSIENT",
    "'', 400, PERMANENT",
    "SOMETHING_NEW, 400, PERMANENT",
    "SOMETHING_NEW, 503, TRANSIENT",
  })
  void plaidCodesMapToNormalizedClasses(String code, int status, ProviderErrorClass expected)
      throws Exception {
    Method mapError =
        PlaidHttpAdapter.class.getDeclaredMethod(
            "mapError", tools.jackson.databind.JsonNode.class, int.class);
    mapError.setAccessible(true);
    tools.jackson.databind.JsonNode parsed =
        code.isEmpty()
            ? new ObjectMapper().createObjectNode()
            : new ObjectMapper().readTree("{\"error_code\":\"" + code + "\"}");
    assertThat(mapError.invoke(null, parsed, status)).isEqualTo(expected);
  }

  @Test
  void adapterDisclosesPlaidBrowserContract() {
    assertThat(new FakeProbe().providerName()).isEqualTo("PLAID");
  }

  private static final class FakeProbe
      implements com.housesync.finance.connection.plaid.PlaidAdapter {
    @Override
    public LinkToken createLinkToken(java.util.UUID attemptId, String clientUserId) {
      throw new UnsupportedOperationException();
    }

    @Override
    public LinkToken createUpdateLinkToken(String accessToken, String clientUserId) {
      throw new UnsupportedOperationException();
    }

    @Override
    public ExchangeResult exchangePublicToken(String publicToken) {
      throw new UnsupportedOperationException();
    }

    @Override
    public java.util.List<com.housesync.finance.connection.plaid.RemoteAccount> fetchAccounts(
        String accessToken) {
      throw new UnsupportedOperationException();
    }

    @Override
    public void removeItem(String accessToken) {
      throw new UnsupportedOperationException();
    }
  }
}
