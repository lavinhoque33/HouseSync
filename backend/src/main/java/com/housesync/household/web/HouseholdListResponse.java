package com.housesync.household.web;

import java.util.List;

/** Membership-scoped household collection. An empty list is valid; the list is unpaginated. */
public record HouseholdListResponse(List<HouseholdResponse> households) {}
