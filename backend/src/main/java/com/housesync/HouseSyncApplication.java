package com.housesync;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration;

@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
public class HouseSyncApplication {

  public static void main(String[] args) {
    var context = SpringApplication.run(HouseSyncApplication.class, args);
    if (context.getEnvironment().containsProperty("app.operator.action")) {
      System.exit(SpringApplication.exit(context));
    }
  }
}
