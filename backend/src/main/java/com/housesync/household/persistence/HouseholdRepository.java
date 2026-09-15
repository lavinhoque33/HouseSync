package com.housesync.household.persistence;

import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface HouseholdRepository extends JpaRepository<HouseholdEntity, UUID> {

  /** Serializes membership and owner-only invitation writes for one household. */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("SELECT h FROM HouseholdEntity h WHERE h.id = :householdId")
  Optional<HouseholdEntity> findByIdForUpdate(@Param("householdId") UUID householdId);
}
