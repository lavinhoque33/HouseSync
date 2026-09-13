package com.housesync.identity.web;

/** CSRF bootstrap payload. The client keeps the token in memory and sends it on unsafe requests. */
public record CsrfResponse(String token, String headerName) {}
