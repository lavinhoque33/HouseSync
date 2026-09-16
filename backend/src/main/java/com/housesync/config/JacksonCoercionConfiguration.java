package com.housesync.config;

import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.cfg.CoercionAction;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.type.LogicalType;

/**
 * Rejects scalar type coercion so a wrong JSON scalar type is malformed input, not a silently
 * converted value: numbers/booleans/arrays/objects never become strings and strings/booleans/
 * floats never become integers. The API contracts require strict syntax for names, enums, UUIDs,
 * and versions; callers receive the shared 400 validation error instead of coerced values.
 */
@Configuration
class JacksonCoercionConfiguration {

  @Bean
  JsonMapperBuilderCustomizer strictScalarCoercion() {
    return builder -> {
      builder.withCoercionConfig(
          LogicalType.Textual,
          coercion -> {
            coercion.setCoercion(CoercionInputShape.Integer, CoercionAction.Fail);
            coercion.setCoercion(CoercionInputShape.Float, CoercionAction.Fail);
            coercion.setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail);
            coercion.setCoercion(CoercionInputShape.Array, CoercionAction.Fail);
            coercion.setCoercion(CoercionInputShape.Object, CoercionAction.Fail);
          });
      builder.withCoercionConfig(
          LogicalType.Integer,
          coercion -> {
            coercion.setCoercion(CoercionInputShape.String, CoercionAction.Fail);
            coercion.setCoercion(CoercionInputShape.Float, CoercionAction.Fail);
            coercion.setCoercion(CoercionInputShape.Boolean, CoercionAction.Fail);
          });
    };
  }
}
