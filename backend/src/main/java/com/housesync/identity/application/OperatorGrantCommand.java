package com.housesync.identity.application;

import java.util.UUID;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** Invoked only by an OS-authorized operator via a separate non-web Java process inside Docker. */
@Component
@ConditionalOnProperty(name = "app.operator.action")
public class OperatorGrantCommand implements ApplicationRunner {
  private final IdentityGrants grants;
  private final IdentityService identities;

  public OperatorGrantCommand(IdentityGrants grants, IdentityService identities) {
    this.grants = grants;
    this.identities = identities;
  }

  @Override
  public void run(ApplicationArguments arguments) {
    String action = one(arguments, "app.operator.action");
    switch (action) {
      case "issue-enrollment", "issue-recovery" -> {
        String kind = action.equals("issue-enrollment") ? "ENROLLMENT" : "RECOVERY";
        IdentityGrants.Issued issued = grants.issue(kind, one(arguments, "app.operator.email"));
        // This stdout belongs exclusively to the one-shot docker exec command, never the app log.
        System.out.println("grantId=" + issued.id());
        System.out.println("expiresAt=" + issued.expiresAt());
        System.out.println("code=" + issued.code());
      }
      case "revoke" -> {
        if (!grants.revoke(UUID.fromString(one(arguments, "app.operator.grant-id")))) {
          throw new IllegalArgumentException("Grant not available for revocation.");
        }
        System.out.println("revoked");
      }
      case "disable-account" -> {
        identities.disableAccess(one(arguments, "app.operator.email"));
        System.out.println("disabled");
      }
      default -> throw new IllegalArgumentException("Unknown operator action.");
    }
  }

  private static String one(ApplicationArguments args, String key) {
    var values = args.getOptionValues(key);
    if (values == null
        || values.size() != 1
        || values.getFirst() == null
        || values.getFirst().isBlank()) {
      throw new IllegalArgumentException("Expected exactly one --" + key + " option.");
    }
    return values.getFirst();
  }
}
