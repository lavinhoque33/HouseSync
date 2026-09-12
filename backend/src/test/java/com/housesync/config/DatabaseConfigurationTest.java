package com.housesync.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.env.StandardEnvironment;

class DatabaseConfigurationTest {

  private final ApplicationContextRunner runner =
      new ApplicationContextRunner()
          .withUserConfiguration(DatabaseConfiguration.class)
          .withInitializer(
              context -> {
                var sources = context.getEnvironment().getPropertySources();
                sources.remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
                sources.remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
              });

  @Test
  void missingPasswordPreventsStartup() {
    runner.run(
        context -> {
          assertThat(context).hasFailed();
          assertThat(context.getStartupFailure()).hasStackTraceContaining("DB_PASSWORD");
        });
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "   "})
  void blankPasswordPreventsStartup(String password) {
    runner
        .withPropertyValues("DB_PASSWORD=" + password)
        .run(
            context -> {
              assertThat(context).hasFailed();
              assertThat(context.getStartupFailure()).hasMessage("DB_PASSWORD must not be blank");
            });
  }

  @Test
  void providedPasswordPassesValidation() {
    runner
        .withPropertyValues("DB_PASSWORD=unit-test-only")
        .run(context -> assertThat(context).hasNotFailed());
  }
}
