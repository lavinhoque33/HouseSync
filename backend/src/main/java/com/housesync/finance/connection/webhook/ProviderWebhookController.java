package com.housesync.finance.connection.webhook;

import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.VerifiedEvent;
import com.housesync.finance.connection.webhook.PlaidWebhookVerifier.WebhookUnavailableException;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * The only session/CSRF-exempt provider endpoint (connected-finance contract §5). Verification runs
 * over the exact original bytes before any domain write; the response is returned only after the
 * replay fingerprint and routing effect commit. Failures are generic: 401 for an invalid
 * signature/body/age, 400/413/429 from the admission filter, 503 for verification infrastructure or
 * database outage. No payload, Item identity, or provider error detail is ever echoed or logged.
 */
@RestController
public class ProviderWebhookController {

  private final PlaidWebhookVerifier verifier;
  private final WebhookIngressService ingress;

  public ProviderWebhookController(PlaidWebhookVerifier verifier, WebhookIngressService ingress) {
    this.verifier = verifier;
    this.ingress = ingress;
  }

  @PostMapping(path = ProviderWebhookBodyFilter.WEBHOOK_PATH)
  public ResponseEntity<Void> plaid(
      HttpServletRequest request,
      @RequestHeader(name = "Plaid-Verification", required = false) String signature)
      throws IOException {
    if (!ingress.enabled()) {
      throw new WebhookUnavailableException();
    }
    byte[] body = request.getInputStream().readAllBytes();
    VerifiedEvent event = verifier.verify(body, signature);
    ingress.admit(event, body, signature);
    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).build();
  }
}
