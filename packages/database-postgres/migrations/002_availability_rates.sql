SELECT pg_advisory_xact_lock(hashtextextended('booking-engine:extension:btree_gist', 0));

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS property_rate_plans (
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  base_nightly_rate_minor BIGINT NOT NULL,
  cleaning_fee_minor BIGINT NOT NULL,
  minimum_stay_nights INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT property_rate_plans_pkey PRIMARY KEY (organization_id, property_id),
  CONSTRAINT property_rate_plans_property_fkey
    FOREIGN KEY (organization_id, property_id)
    REFERENCES properties (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT property_rate_plans_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT property_rate_plans_base_rate_bounded CHECK (
    base_nightly_rate_minor BETWEEN 0 AND 1000000000
  ),
  CONSTRAINT property_rate_plans_cleaning_fee_bounded CHECK (
    cleaning_fee_minor BETWEEN 0 AND 1000000000
  ),
  CONSTRAINT property_rate_plans_minimum_stay_bounded CHECK (minimum_stay_nights BETWEEN 1 AND 3660)
);

CREATE TABLE IF NOT EXISTS seasonal_rate_overrides (
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  override_id TEXT NOT NULL,
  stay DATERANGE NOT NULL,
  nightly_rate_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT seasonal_rate_overrides_pkey PRIMARY KEY (organization_id, property_id, override_id),
  CONSTRAINT seasonal_rate_overrides_property_fkey
    FOREIGN KEY (organization_id, property_id)
    REFERENCES properties (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT seasonal_rate_overrides_stay_bounded CHECK (
    lower(stay) IS NOT NULL
    AND upper(stay) IS NOT NULL
    AND upper(stay) > lower(stay)
    AND upper(stay) - lower(stay) <= 3660
  ),
  CONSTRAINT seasonal_rate_overrides_rate_bounded CHECK (
    nightly_rate_minor BETWEEN 0 AND 1000000000
  ),
  CONSTRAINT seasonal_rate_overrides_no_overlap
    EXCLUDE USING gist (
      organization_id WITH =,
      property_id WITH =,
      stay WITH &&
    )
);

CREATE TABLE IF NOT EXISTS availability_blocks (
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  block_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  stay DATERANGE NOT NULL,
  expires_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TIMESTAMPTZ,
  CONSTRAINT availability_blocks_pkey PRIMARY KEY (organization_id, property_id, record_id),
  CONSTRAINT availability_blocks_property_fkey
    FOREIGN KEY (organization_id, property_id)
    REFERENCES properties (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT availability_blocks_record_id_format
    CHECK (record_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT availability_blocks_kind CHECK (block_kind IN ('manual', 'hold', 'occupancy')),
  CONSTRAINT availability_blocks_status CHECK (status IN ('active', 'released')),
  CONSTRAINT availability_blocks_stay_bounded CHECK (
    lower(stay) IS NOT NULL
    AND upper(stay) IS NOT NULL
    AND upper(stay) > lower(stay)
    AND upper(stay) - lower(stay) <= 3660
  ),
  CONSTRAINT availability_blocks_hold_expiry_shape CHECK (
    (block_kind = 'hold' AND expires_at IS NOT NULL)
    OR (block_kind IN ('manual', 'occupancy') AND expires_at IS NULL)
  ),
  CONSTRAINT availability_blocks_reason_length CHECK (
    reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500
  ),
  CONSTRAINT availability_blocks_active_stay_exclusion
    EXCLUDE USING gist (
      organization_id WITH =,
      property_id WITH =,
      stay WITH &&
    )
    WHERE (status = 'active')
);
