CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organizations_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT organizations_name_not_blank CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT organizations_name_max_length CHECK (char_length(btrim(name)) <= 120)
);

CREATE TABLE IF NOT EXISTS properties (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  country TEXT NOT NULL,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL,
  property_type TEXT NOT NULL,
  bedroom_count INTEGER NOT NULL,
  bed_configuration JSONB NOT NULL,
  bathroom_count INTEGER NOT NULL,
  maximum_guests INTEGER NOT NULL,
  amenities JSONB NOT NULL,
  host_notes TEXT NOT NULL,
  operational_notes TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT properties_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT properties_organization_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT properties_id_format
    CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT properties_name_length
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT properties_summary_length
    CHECK (char_length(btrim(summary)) BETWEEN 1 AND 500),
  CONSTRAINT properties_country_shape CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT properties_timezone_length CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 64),
  CONSTRAINT properties_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT properties_property_type CHECK (
    property_type IN ('apartment', 'bungalow', 'cabin', 'cottage', 'house', 'studio', 'villa')
  ),
  CONSTRAINT properties_bedroom_count_bounded CHECK (bedroom_count BETWEEN 0 AND 100),
  CONSTRAINT properties_bathroom_count_bounded CHECK (bathroom_count BETWEEN 0 AND 100),
  CONSTRAINT properties_maximum_guests_bounded CHECK (maximum_guests BETWEEN 0 AND 200),
  CONSTRAINT properties_bed_configuration_bounded CHECK (
    CASE
      WHEN jsonb_typeof(bed_configuration) = 'array'
        THEN jsonb_array_length(bed_configuration) BETWEEN 1 AND 16
      ELSE FALSE
    END
  ),
  CONSTRAINT properties_amenities_bounded CHECK (
    CASE
      WHEN jsonb_typeof(amenities) = 'array'
        THEN jsonb_array_length(amenities) BETWEEN 0 AND 32
      ELSE FALSE
    END
  ),
  CONSTRAINT properties_host_notes_length CHECK (char_length(host_notes) BETWEEN 1 AND 2000),
  CONSTRAINT properties_operational_notes_length
    CHECK (char_length(operational_notes) BETWEEN 1 AND 4000)
);

CREATE OR REPLACE VIEW public_properties AS
SELECT
  organization_id,
  id,
  name,
  summary,
  country,
  timezone,
  currency,
  property_type,
  bedroom_count,
  bed_configuration,
  bathroom_count,
  maximum_guests,
  amenities,
  host_notes,
  created_at,
  updated_at
FROM properties;
