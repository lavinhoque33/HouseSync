package com.housesync.finance.categorization.application;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** One committed claim, one bounded HTTP call, one independently committed fenced completion. */
@Component
@ConditionalOnProperty(name = "app.categorization-ai.enabled", havingValue = "true")
public class CategorizationAiWorker {
  private final CategorizationAiWorkService work;
  private final CategorizationAiProvider provider;

  public CategorizationAiWorker(
      CategorizationAiWorkService work, CategorizationAiProvider provider) {
    this.work = work;
    this.provider = provider;
  }

  @Scheduled(fixedDelayString = "${app.categorization-ai.poll-ms:1000}")
  public void poll() {
    for (int i = 0; i < 8; i++) {
      var claimed = work.claim();
      if (claimed == null) return;
      var evidence = work.evidence(claimed);
      CategorizationAiProvider.Candidate result = null;
      boolean transientFailure = false;
      if (evidence != null) {
        try {
          result = provider.suggest(evidence);
        } catch (CategorizationAiProvider.Failure failure) {
          transientFailure = failure.transientFailure();
        }
      }
      work.finish(claimed, result, transientFailure);
    }
  }
}
