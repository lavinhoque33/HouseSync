package com.housesync.identity.web;

import java.util.UUID;

/**
 * Safe user DTO. Carries only the opaque UUID and canonical email; password hashes, session
 * internals, and any future household data are never part of this shape.
 */
public record SafeUserResponse(UUID id, String email) {}
