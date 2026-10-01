# Dependency license metadata

An inventory of the locked web dependency graph and the resolved backend compile/runtime/test graph. This is upstream metadata, not legal clearance. Maven licenses include inherited parent declarations. Optional npm packages for other platforms are included. Build-plugin transitive dependencies, operating-system images and downloaded caches are not certified by this inventory. Dependencies are downloaded by the build, not vendored in this repository.

## Backend

| Coordinate | Scope | Declared license(s) |
| --- | --- | --- |
| `ch.qos.logback:logback-classic:1.5.38` | compile | [EPL-2.0](https://www.eclipse.org/legal/epl-v20.html); [LGPL-2.1-only](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) |
| `ch.qos.logback:logback-core:1.5.38` | compile | [EPL-2.0](https://www.eclipse.org/legal/epl-v20.html); [LGPL-2.1-only](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) |
| `com.fasterxml:classmate:1.7.3` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `com.fasterxml.jackson.core:jackson-annotations:2.21` | compile | [The Apache Software License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `com.github.docker-java:docker-java-api:3.7.1` | test | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `com.github.docker-java:docker-java-transport:3.7.1` | test | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `com.github.docker-java:docker-java-transport-zerodep:3.7.1` | test | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `com.jayway.jsonpath:json-path:2.10.0` | test | [The Apache Software License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `com.sun.istack:istack-commons-runtime:4.1.2` | runtime | [Eclipse Distribution License - v 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `com.vaadin.external.google:android-json:0.0.20131108.vaadin1` | test | [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0) |
| `com.zaxxer:HikariCP:7.0.2` | compile | [The Apache Software License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `commons-codec:commons-codec:1.21.0` | test | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `commons-io:commons-io:2.20.0` | test | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `commons-logging:commons-logging:1.3.6` | compile | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `io.micrometer:micrometer-commons:1.17.1` | compile | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `io.micrometer:micrometer-core:1.17.1` | compile | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `io.micrometer:micrometer-jakarta9:1.17.1` | compile | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `io.micrometer:micrometer-observation:1.17.1` | compile | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `jakarta.activation:jakarta.activation-api:2.1.4` | runtime | [EDL 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `jakarta.annotation:jakarta.annotation-api:3.0.0` | compile | [EPL 2.0](https://www.eclipse.org/legal/epl-2.0); [GPL2 w/ CPE](https://www.gnu.org/software/classpath/license.html) |
| `jakarta.inject:jakarta.inject-api:2.0.1` | runtime | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `jakarta.persistence:jakarta.persistence-api:3.2.0` | compile | [Eclipse Public License v. 2.0](http://www.eclipse.org/legal/epl-2.0); [Eclipse Distribution License v. 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `jakarta.transaction:jakarta.transaction-api:2.0.1` | compile | [EPL 2.0](http://www.eclipse.org/legal/epl-2.0); [GPL2 w/ CPE](https://www.gnu.org/software/classpath/license.html) |
| `jakarta.validation:jakarta.validation-api:3.1.1` | compile | [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `jakarta.xml.bind:jakarta.xml.bind-api:4.0.5` | runtime | [Eclipse Distribution License - v 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `net.bytebuddy:byte-buddy:1.18.11` | runtime | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `net.bytebuddy:byte-buddy-agent:1.18.11` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `net.java.dev.jna:jna:5.18.1` | test | [LGPL-2.1-or-later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1); [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `net.minidev:accessors-smart:2.6.0` | test | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `net.minidev:json-smart:2.6.0` | test | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.antlr:antlr4-runtime:4.13.2` | compile | [BSD-3-Clause](https://www.antlr.org/license.html) |
| `org.apache.commons:commons-compress:1.28.0` | test | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.apache.commons:commons-lang3:3.20.0` | test | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.apache.logging.log4j:log4j-api:2.25.5` | compile | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.apache.logging.log4j:log4j-to-slf4j:2.25.5` | compile | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.apache.tomcat.embed:tomcat-embed-core:11.0.24` | compile | [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.apache.tomcat.embed:tomcat-embed-el:11.0.24` | compile | [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.apache.tomcat.embed:tomcat-embed-websocket:11.0.24` | compile | [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.apiguardian:apiguardian-api:1.1.2` | test | [The Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.aspectj:aspectjweaver:1.9.25.1` | compile | [Eclipse Public License - v 2.0](https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.txt) |
| `org.assertj:assertj-core:3.27.7` | test | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.awaitility:awaitility:4.3.0` | test | [Apache 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.checkerframework:checker-qual:3.55.1` | runtime | [The MIT License](https://opensource.org/licenses/MIT) |
| `org.eclipse.angus:angus-activation:2.0.3` | runtime | [EDL 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `org.flywaydb:flyway-core:12.4.0` | compile | [Apache License, Version 2.0](https://github.com/flyway/flyway/blob/main/README.txt) |
| `org.flywaydb:flyway-database-postgresql:12.4.0` | compile | [Apache License, Version 2.0](https://github.com/flyway/flyway/blob/main/README.txt) |
| `org.glassfish.jaxb:jaxb-core:4.0.9` | runtime | [Eclipse Distribution License - v 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `org.glassfish.jaxb:jaxb-runtime:4.0.9` | runtime | [Eclipse Distribution License - v 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `org.glassfish.jaxb:txw2:4.0.9` | runtime | [Eclipse Distribution License - v 1.0](http://www.eclipse.org/org/documents/edl-v10.php) |
| `org.hamcrest:hamcrest:3.0` | test | [BSD-3-Clause](https://raw.githubusercontent.com/hamcrest/JavaHamcrest/master/LICENSE) |
| `org.hdrhistogram:HdrHistogram:2.2.2` | runtime | [Public Domain, per Creative Commons CC0](http://creativecommons.org/publicdomain/zero/1.0/); [BSD-2-Clause](https://opensource.org/licenses/BSD-2-Clause) |
| `org.hibernate.models:hibernate-models:1.1.1` | runtime | [Apache License Version 2.0](http://www.apache.org/licenses/) |
| `org.hibernate.orm:hibernate-core:7.4.5.Final` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.hibernate.validator:hibernate-validator:9.1.3.Final` | compile | [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.jboss.logging:jboss-logging:3.6.3.Final` | compile | [Apache License 2.0](https://repository.jboss.org/licenses/apache-2.0.txt) |
| `org.jetbrains:annotations:17.0.0` | test | [The Apache Software License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.jspecify:jspecify:1.0.1` | compile | [The Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.junit.jupiter:junit-jupiter:6.0.3` | test | [Eclipse Public License v2.0](https://www.eclipse.org/legal/epl-v20.html) |
| `org.junit.jupiter:junit-jupiter-api:6.0.3` | test | [Eclipse Public License v2.0](https://www.eclipse.org/legal/epl-v20.html) |
| `org.junit.jupiter:junit-jupiter-engine:6.0.3` | test | [Eclipse Public License v2.0](https://www.eclipse.org/legal/epl-v20.html) |
| `org.junit.jupiter:junit-jupiter-params:6.0.3` | test | [Eclipse Public License v2.0](https://www.eclipse.org/legal/epl-v20.html) |
| `org.junit.platform:junit-platform-commons:6.0.3` | test | [Eclipse Public License v2.0](https://www.eclipse.org/legal/epl-v20.html) |
| `org.junit.platform:junit-platform-engine:6.0.3` | test | [Eclipse Public License v2.0](https://www.eclipse.org/legal/epl-v20.html) |
| `org.mockito:mockito-core:5.23.0` | test | [MIT](https://opensource.org/licenses/MIT) |
| `org.mockito:mockito-junit-jupiter:5.23.0` | test | [MIT](https://opensource.org/licenses/MIT) |
| `org.objenesis:objenesis:3.3` | test | [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.opentest4j:opentest4j:1.3.0` | test | [The Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.ow2.asm:asm:9.7.1` | test | [BSD-3-Clause](https://asm.ow2.io/license.html) |
| `org.postgresql:postgresql:42.7.13` | runtime | [BSD-2-Clause](https://jdbc.postgresql.org/about/license.html) |
| `org.rnorth.duct-tape:duct-tape:1.0.8` | test | [MIT](http://opensource.org/licenses/MIT) |
| `org.skyscreamer:jsonassert:1.5.3` | test | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.slf4j:jul-to-slf4j:2.0.18` | compile | [MIT](https://opensource.org/license/mit) |
| `org.slf4j:slf4j-api:2.0.18` | compile | [MIT](https://opensource.org/license/mit) |
| `org.springframework:spring-aop:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-aspects:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-beans:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-context:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-core:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-expression:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-jdbc:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-orm:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-test:7.0.9` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-tx:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-web:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework:spring-webmvc:7.0.9` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-actuator:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-actuator-autoconfigure:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-autoconfigure:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-data-commons:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-data-jpa:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-flyway:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-health:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-hibernate:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-http-converter:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-jackson:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-jdbc:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-jpa:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-micrometer-metrics:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-micrometer-observation:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-persistence:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-resttestclient:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-security:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-security-test:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-servlet:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-session:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-session-jdbc:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-sql:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-actuator:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-data-jpa:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-flyway:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-jackson:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-jackson-test:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-jdbc:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-logging:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-micrometer-metrics:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-security:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-security-test:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-session-jdbc:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-test:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-tomcat:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-tomcat-runtime:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-validation:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-webmvc:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-starter-webmvc-test:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-test:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-test-autoconfigure:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-tomcat:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-transaction:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-validation:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-web-server:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-webmvc:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.boot:spring-boot-webmvc-test:4.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.data:spring-data-commons:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.data:spring-data-jpa:4.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.security:spring-security-config:7.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.security:spring-security-core:7.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.security:spring-security-crypto:7.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.security:spring-security-test:7.1.1` | test | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.security:spring-security-web:7.1.1` | compile | [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `org.springframework.session:spring-session-core:4.1.1` | compile | Broadcom Foundation License |
| `org.springframework.session:spring-session-jdbc:4.1.1` | compile | Broadcom Foundation License |
| `org.testcontainers:testcontainers:2.0.5` | test | [MIT](http://opensource.org/licenses/MIT) |
| `org.testcontainers:testcontainers-database-commons:2.0.5` | test | [MIT](http://opensource.org/licenses/MIT) |
| `org.testcontainers:testcontainers-jdbc:2.0.5` | test | [MIT](http://opensource.org/licenses/MIT) |
| `org.testcontainers:testcontainers-junit-jupiter:2.0.5` | test | [MIT](http://opensource.org/licenses/MIT) |
| `org.testcontainers:testcontainers-postgresql:2.0.5` | test | [MIT](http://opensource.org/licenses/MIT) |
| `org.xmlunit:xmlunit-core:2.11.0` | test | [The Apache Software License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `org.yaml:snakeyaml:2.6` | compile | [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.txt) |
| `tools.jackson.core:jackson-core:3.1.5` | compile | [The Apache Software License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `tools.jackson.core:jackson-databind:3.1.5` | compile | [The Apache Software License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |

## Web

| Package | Version | Declared license | Scope |
| --- | --- | --- | --- |
| `@adobe/css-tools` | 4.5.0 | MIT | development |
| `@asamuzakjp/css-color` | 3.2.0 | MIT | development |
| `@babel/code-frame` | 7.29.7 | MIT | development |
| `@babel/compat-data` | 7.29.7 | MIT | development |
| `@babel/core` | 7.29.7 | MIT | development |
| `@babel/generator` | 7.29.8 | MIT | development |
| `@babel/helper-compilation-targets` | 7.29.7 | MIT | development |
| `@babel/helper-globals` | 7.29.7 | MIT | development |
| `@babel/helper-module-imports` | 7.29.7 | MIT | development |
| `@babel/helper-module-transforms` | 7.29.7 | MIT | development |
| `@babel/helper-string-parser` | 7.29.7 | MIT | development |
| `@babel/helper-validator-identifier` | 7.29.7 | MIT | development |
| `@babel/helper-validator-option` | 7.29.7 | MIT | development |
| `@babel/helpers` | 7.29.7 | MIT | development |
| `@babel/parser` | 7.29.8 | MIT | development |
| `@babel/runtime` | 7.29.7 | MIT | development |
| `@babel/template` | 7.29.7 | MIT | development |
| `@babel/traverse` | 7.29.8 | MIT | development |
| `@babel/types` | 7.29.8 | MIT | development |
| `@cacheable/memory` | 2.2.0 | MIT | development |
| `@cacheable/utils` | 2.5.0 | MIT | development |
| `@csstools/color-helpers` | 5.1.0 | MIT-0 | development |
| `@csstools/css-calc` | 2.1.4 | MIT | development |
| `@csstools/css-color-parser` | 3.1.0 | MIT | development |
| `@csstools/css-parser-algorithms` | 3.0.5 | MIT | development |
| `@csstools/css-tokenizer` | 3.0.4 | MIT | development |
| `@eslint-community/eslint-utils` | 4.10.1 | MIT | development |
| `@eslint-community/regexpp` | 4.12.2 | MIT | development |
| `@eslint/config-array` | 0.23.5 | Apache-2.0 | development |
| `@eslint/config-helpers` | 0.7.0 | Apache-2.0 | development |
| `@eslint/core` | 1.2.1 | Apache-2.0 | development |
| `@eslint/js` | 10.0.1 | MIT | development |
| `@eslint/object-schema` | 3.0.5 | Apache-2.0 | development |
| `@eslint/plugin-kit` | 0.7.3 | Apache-2.0 | development |
| `@humanfs/core` | 0.19.2 | Apache-2.0 | development |
| `@humanfs/node` | 0.16.8 | Apache-2.0 | development |
| `@humanfs/types` | 0.15.0 | Apache-2.0 | development |
| `@humanwhocodes/module-importer` | 1.0.1 | Apache-2.0 | development |
| `@humanwhocodes/retry` | 0.4.3 | Apache-2.0 | development |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | development |
| `@jridgewell/remapping` | 2.3.5 | MIT | development |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | development |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT | development |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | development |
| `@keyv/bigmap` | 1.3.1 | MIT | development |
| `@keyv/serialize` | 1.1.1 | MIT | development |
| `@oxc-project/types` | 0.149.0 | MIT | development |
| `@rolldown/binding-android-arm-eabi` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-android-arm64` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-darwin-arm64` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-darwin-x64` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-freebsd-x64` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-linux-arm-gnueabihf` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-linux-arm64-gnu` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-linux-arm64-musl` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-linux-ppc64-gnu` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-linux-s390x-gnu` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-linux-x64-gnu` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-linux-x64-musl` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-openharmony-arm64` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-win32-arm64-msvc` | 1.2.8 | MIT | development / optional |
| `@rolldown/binding-win32-x64-msvc` | 1.2.8 | MIT | development / optional |
| `@rolldown/pluginutils` | 1.0.1 | MIT | development |
| `@testing-library/dom` | 10.4.1 | MIT | development |
| `@testing-library/jest-dom` | 7.0.1 | MIT | development |
| `@testing-library/react` | 16.3.3 | MIT | development |
| `@types/aria-query` | 5.0.4 | MIT | development |
| `@types/chai` | 5.2.3 | MIT | development |
| `@types/deep-eql` | 4.0.2 | MIT | development |
| `@types/esrecurse` | 4.3.1 | MIT | development |
| `@types/estree` | 1.0.9 | MIT | development |
| `@types/json-schema` | 7.0.15 | MIT | development |
| `@types/node` | 22.20.2 | MIT | development |
| `@types/react` | 19.2.14 | MIT | development |
| `@types/react-dom` | 19.2.3 | MIT | development |
| `@typescript-eslint/eslint-plugin` | 8.70.0 | MIT | development |
| `@typescript-eslint/parser` | 8.70.0 | MIT | development |
| `@typescript-eslint/project-service` | 8.70.0 | MIT | development |
| `@typescript-eslint/scope-manager` | 8.70.0 | MIT | development |
| `@typescript-eslint/tsconfig-utils` | 8.70.0 | MIT | development |
| `@typescript-eslint/type-utils` | 8.70.0 | MIT | development |
| `@typescript-eslint/types` | 8.70.0 | MIT | development |
| `@typescript-eslint/typescript-estree` | 8.70.0 | MIT | development |
| `@typescript-eslint/utils` | 8.70.0 | MIT | development |
| `@typescript-eslint/visitor-keys` | 8.70.0 | MIT | development |
| `@vitejs/plugin-react` | 6.1.1 | MIT | development |
| `@vitest/mocker` | 5.0.0 | MIT | development |
| `@vitest/spy` | 5.0.0 | MIT | development |
| `acorn` | 8.18.0 | MIT | development |
| `acorn-jsx` | 5.3.2 | MIT | development |
| `agent-base` | 7.1.4 | MIT | development |
| `ajv` | 6.15.0 | MIT | development |
| `ansi-regex` | 5.0.1 | MIT | development |
| `ansi-styles` | 5.2.0 | MIT | development |
| `aria-query` | 5.3.0 | Apache-2.0 | development |
| `assertion-error` | 2.0.1 | MIT | development |
| `balanced-match` | 4.0.4 | MIT | development |
| `baseline-browser-mapping` | 2.11.23 | Apache-2.0 | development |
| `brace-expansion` | 5.0.9 | MIT | development |
| `browserslist` | 4.28.9 | MIT | development |
| `cacheable` | 2.5.0 | MIT | development |
| `caniuse-lite` | 1.0.30001810 | CC-BY-4.0 | development |
| `chai` | 6.2.2 | MIT | development |
| `convert-source-map` | 2.0.0 | MIT | development |
| `cross-spawn` | 7.0.6 | MIT | development |
| `css.escape` | 1.5.1 | MIT | development |
| `cssstyle` | 4.6.0 | MIT | development |
| `csstype` | 3.2.3 | MIT | development |
| `data-urls` | 5.0.0 | MIT | development |
| `debug` | 4.4.3 | MIT | development |
| `decimal.js` | 10.6.0 | MIT | development |
| `deep-is` | 0.1.4 | MIT | development |
| `dequal` | 2.0.3 | MIT | development |
| `detect-libc` | 2.1.2 | Apache-2.0 | development |
| `dom-accessibility-api` | 0.5.16 | MIT | development |
| `dom-accessibility-api` | 0.6.3 | MIT | development |
| `electron-to-chromium` | 1.5.427 | ISC | development |
| `entities` | 6.0.1 | BSD-2-Clause | development |
| `es-module-lexer` | 2.3.2 | MIT | development |
| `escalade` | 3.2.0 | MIT | development |
| `escape-string-regexp` | 4.0.0 | MIT | development |
| `eslint` | 10.10.0 | MIT | development |
| `eslint-config-prettier` | 10.1.8 | MIT | development |
| `eslint-plugin-react-hooks` | 7.1.1 | MIT | development |
| `eslint-plugin-react-refresh` | 0.5.6 | MIT | development |
| `eslint-scope` | 9.1.2 | BSD-2-Clause | development |
| `eslint-visitor-keys` | 3.4.3 | Apache-2.0 | development |
| `eslint-visitor-keys` | 5.0.1 | Apache-2.0 | development |
| `espree` | 11.2.0 | BSD-2-Clause | development |
| `esquery` | 1.7.0 | BSD-3-Clause | development |
| `esrecurse` | 4.3.0 | BSD-2-Clause | development |
| `estraverse` | 5.3.0 | BSD-2-Clause | development |
| `estree-walker` | 3.0.3 | MIT | development |
| `esutils` | 2.0.3 | BSD-2-Clause | development |
| `expect-type` | 1.4.0 | Apache-2.0 | development |
| `fast-deep-equal` | 3.1.3 | MIT | development |
| `fast-json-stable-stringify` | 2.1.0 | MIT | development |
| `fast-levenshtein` | 2.0.6 | MIT | development |
| `fdir` | 6.5.0 | MIT | development |
| `file-entry-cache` | 11.1.5 | MIT | development |
| `find-up` | 5.0.0 | MIT | development |
| `flat-cache` | 6.1.23 | MIT | development |
| `flatted` | 3.4.4 | ISC | development |
| `fsevents` | 2.3.3 | MIT | development / optional |
| `gensync` | 1.0.0-beta.2 | MIT | development |
| `glob-parent` | 6.0.2 | ISC | development |
| `hashery` | 1.5.1 | MIT | development |
| `hermes-estree` | 0.25.1 | MIT | development |
| `hermes-parser` | 0.25.1 | MIT | development |
| `hookified` | 1.15.1 | MIT | development |
| `hookified` | 2.2.0 | MIT | development |
| `html-encoding-sniffer` | 4.0.0 | MIT | development |
| `http-proxy-agent` | 7.0.2 | MIT | development |
| `https-proxy-agent` | 7.0.6 | MIT | development |
| `iconv-lite` | 0.6.3 | MIT | development |
| `ignore` | 5.3.2 | MIT | development |
| `ignore` | 7.0.9 | MIT | development |
| `imurmurhash` | 0.1.4 | MIT | development |
| `indent-string` | 4.0.0 | MIT | development |
| `is-extglob` | 2.1.1 | MIT | development |
| `is-glob` | 4.0.3 | MIT | development |
| `is-potential-custom-element-name` | 1.0.1 | MIT | development |
| `isexe` | 2.0.0 | ISC | development |
| `js-tokens` | 4.0.0 | MIT | development |
| `jsdom` | 26.1.0 | MIT | development |
| `jsesc` | 3.1.0 | MIT | development |
| `json-schema-traverse` | 0.4.1 | MIT | development |
| `json-stable-stringify-without-jsonify` | 1.0.1 | MIT | development |
| `json5` | 2.2.3 | MIT | development |
| `keyv` | 5.6.0 | MIT | development |
| `levn` | 0.4.1 | MIT | development |
| `lightningcss` | 1.33.0 | MPL-2.0 | development |
| `lightningcss-android-arm64` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-darwin-arm64` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-darwin-x64` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-freebsd-x64` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-linux-arm-gnueabihf` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-linux-arm64-gnu` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-linux-arm64-musl` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-win32-arm64-msvc` | 1.33.0 | MPL-2.0 | development / optional |
| `lightningcss-win32-x64-msvc` | 1.33.0 | MPL-2.0 | development / optional |
| `locate-path` | 6.0.0 | MIT | development |
| `lru-cache` | 10.4.3 | ISC | development |
| `lru-cache` | 5.1.1 | ISC | development |
| `lz-string` | 1.5.0 | MIT | development |
| `magic-string` | 1.3.1 | MIT | development |
| `min-indent` | 1.0.1 | MIT | development |
| `minimatch` | 10.2.6 | BlueOak-1.0.0 | development |
| `ms` | 2.1.3 | MIT | development |
| `nanoid` | 3.3.19 | MIT | development |
| `natural-compare` | 1.4.0 | MIT | development |
| `node-releases` | 2.0.55 | MIT | development |
| `nwsapi` | 2.2.27 | MIT | development |
| `obug` | 2.2.1 | MIT | development |
| `optionator` | 0.9.4 | MIT | development |
| `p-limit` | 3.1.0 | MIT | development |
| `p-locate` | 5.0.0 | MIT | development |
| `parse5` | 7.3.0 | MIT | development |
| `path-exists` | 4.0.0 | MIT | development |
| `path-key` | 3.1.1 | MIT | development |
| `picocolors` | 1.1.1 | ISC | development |
| `picomatch` | 4.0.7 | MIT | development |
| `postcss` | 8.5.28 | MIT | development |
| `prelude-ls` | 1.2.1 | MIT | development |
| `prettier` | 3.9.6 | MIT | development |
| `pretty-format` | 27.5.1 | MIT | development |
| `punycode` | 2.3.1 | MIT | development |
| `qified` | 0.10.1 | MIT | development |
| `react` | 19.2.4 | MIT | runtime |
| `react-dom` | 19.2.4 | MIT | runtime |
| `react-is` | 17.0.2 | MIT | development |
| `redent` | 3.0.0 | MIT | development |
| `rolldown` | 1.2.8 | MIT | development |
| `rrweb-cssom` | 0.8.0 | MIT | development |
| `safer-buffer` | 2.1.2 | MIT | development |
| `saxes` | 6.0.0 | ISC | development |
| `scheduler` | 0.27.0 | MIT | runtime |
| `semver` | 6.3.1 | ISC | development |
| `semver` | 7.8.5 | ISC | development |
| `shebang-command` | 2.0.0 | MIT | development |
| `shebang-regex` | 3.0.0 | MIT | development |
| `siginfo` | 2.0.0 | ISC | development |
| `source-map-js` | 1.2.1 | BSD-3-Clause | development |
| `stackback` | 0.0.2 | MIT | development |
| `std-env` | 4.2.0 | MIT | development |
| `strip-indent` | 3.0.0 | MIT | development |
| `symbol-tree` | 3.2.4 | MIT | development |
| `tinybench` | 6.1.4 | MIT | development |
| `tinyexec` | 1.3.0 | MIT | development |
| `tinyglobby` | 0.2.17 | MIT | development |
| `tldts` | 6.1.86 | MIT | development |
| `tldts-core` | 6.1.86 | MIT | development |
| `tough-cookie` | 5.1.2 | BSD-3-Clause | development |
| `tr46` | 5.1.1 | MIT | development |
| `ts-api-utils` | 2.5.0 | MIT | development |
| `type-check` | 0.4.0 | MIT | development |
| `typescript` | 5.9.3 | Apache-2.0 | development |
| `typescript-eslint` | 8.70.0 | MIT | development |
| `undici-types` | 6.21.0 | MIT | development |
| `update-browserslist-db` | 1.3.3 | MIT | development |
| `uri-js` | 4.4.1 | BSD-2-Clause | development |
| `vite` | 8.3.0 | MIT | development |
| `vitest` | 5.0.0 | MIT | development |
| `w3c-xmlserializer` | 5.0.0 | MIT | development |
| `webidl-conversions` | 7.0.0 | BSD-2-Clause | development |
| `whatwg-encoding` | 3.1.1 | MIT | development |
| `whatwg-mimetype` | 4.0.0 | MIT | development |
| `whatwg-url` | 14.2.0 | MIT | development |
| `which` | 2.0.2 | ISC | development |
| `why-is-node-running` | 2.3.0 | MIT | development |
| `word-wrap` | 1.2.5 | MIT | development |
| `ws` | 8.21.3 | MIT | development |
| `xml-name-validator` | 5.0.0 | Apache-2.0 | development |
| `xmlchars` | 2.2.0 | MIT | development |
| `yallist` | 3.1.1 | ISC | development |
| `yocto-queue` | 0.1.0 | MIT | development |
| `zod` | 4.6.2 | MIT | development |
| `zod-validation-error` | 4.0.2 | MIT | development |
