# syntax=docker/dockerfile:1
FROM maven:3.9.16-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml ./pom.xml
COPY src/ ./src/
# Run formatting and Docker-free tests. CI runs verify with a Docker daemon separately.
RUN mvn --batch-mode --no-transfer-progress package

FROM eclipse-temurin:21-jre-alpine AS runtime
RUN addgroup -S -g 10001 housesync \
    && adduser -S -D -H -u 10001 -G housesync housesync
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/target/housesync-backend.jar app.jar
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
