-- A persisted login is valid only while its captured generation matches this account row.
-- Existing serialized principals deserialize the new long field as zero.
ALTER TABLE users ADD COLUMN session_generation BIGINT NOT NULL DEFAULT 0;
