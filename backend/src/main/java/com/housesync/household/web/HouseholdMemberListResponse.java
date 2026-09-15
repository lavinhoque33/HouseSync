package com.housesync.household.web;

import java.util.List;

/** Membership-scoped roster. The authenticated actor is always present. */
public record HouseholdMemberListResponse(List<HouseholdMemberResponse> members) {}
