CREATE TABLE IF NOT EXISTS ical_blocks (
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_uid TEXT NOT NULL,
  arrival DATE NOT NULL,
  departure DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  event_status TEXT NOT NULL,
  sequence BIGINT,
  last_modified TIMESTAMPTZ,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ical_blocks_pkey PRIMARY KEY (organization_id, property_id, source_id, external_uid),
  CONSTRAINT ical_blocks_property_fkey
    FOREIGN KEY (organization_id, property_id)
    REFERENCES properties (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ical_blocks_source_id_format
    CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT ical_blocks_uid_length
    CHECK (char_length(btrim(external_uid)) BETWEEN 1 AND 512),
  CONSTRAINT ical_blocks_stay_bounded
    CHECK (departure > arrival AND departure - arrival <= 3660),
  CONSTRAINT ical_blocks_status
    CHECK (status IN ('active', 'released')),
  CONSTRAINT ical_blocks_event_status
    CHECK (event_status IN ('confirmed', 'tentative', 'cancelled', 'unknown')),
  CONSTRAINT ical_blocks_sequence_bounded
    CHECK (sequence IS NULL OR sequence BETWEEN 0 AND 9223372036854775807),
  CONSTRAINT ical_blocks_summary_length
    CHECK (summary IS NULL OR char_length(summary) <= 2000)
);

CREATE INDEX IF NOT EXISTS ical_blocks_active_stay_idx
  ON ical_blocks (organization_id, property_id, arrival, departure)
  WHERE status = 'active';
