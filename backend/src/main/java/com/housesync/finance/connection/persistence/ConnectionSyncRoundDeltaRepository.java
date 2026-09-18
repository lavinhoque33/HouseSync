package com.housesync.finance.connection.persistence;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ConnectionSyncRoundDeltaRepository
    extends JpaRepository<ConnectionSyncRoundDeltaEntity, ConnectionSyncRoundDeltaEntity.Key> {

  List<ConnectionSyncRoundDeltaEntity> findByRoundIdOrderBySequenceAsc(UUID roundId);

  @Modifying
  @Query("DELETE FROM ConnectionSyncRoundDeltaEntity d WHERE d.roundId = :roundId")
  int deleteByRoundId(@Param("roundId") UUID roundId);
}
