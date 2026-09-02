UPDATE ical_blocks
SET sequence = 2147483647
WHERE sequence > 2147483647;

ALTER TABLE ical_blocks
  DROP CONSTRAINT IF EXISTS ical_blocks_sequence_bounded;

ALTER TABLE ical_blocks
  ADD CONSTRAINT ical_blocks_sequence_bounded
    CHECK (sequence IS NULL OR sequence BETWEEN 0 AND 2147483647);
