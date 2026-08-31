CREATE TABLE IF NOT EXISTS payment_checkouts (
  checkout_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  hold_record_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_session_id TEXT,
  provider_payment_id TEXT,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  quote_revision TEXT NOT NULL,
  quote_json JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'created',
  failure_code TEXT,
  checkout_expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payment_checkouts_request_fkey
    FOREIGN KEY (organization_id, request_id)
    REFERENCES booking_requests (organization_id, request_id) ON DELETE CASCADE,
  CONSTRAINT payment_checkouts_hold_fkey
    FOREIGN KEY (organization_id, property_id, hold_record_id)
    REFERENCES availability_blocks (organization_id, property_id, record_id) ON DELETE CASCADE,
  CONSTRAINT payment_checkouts_id_format
    CHECK (checkout_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CONSTRAINT payment_checkouts_provider_shape
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT payment_checkouts_account_length
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 128),
  CONSTRAINT payment_checkouts_session_length
    CHECK (provider_session_id IS NULL OR char_length(provider_session_id) BETWEEN 1 AND 255),
  CONSTRAINT payment_checkouts_payment_length
    CHECK (provider_payment_id IS NULL OR char_length(provider_payment_id) BETWEEN 1 AND 255),
  CONSTRAINT payment_checkouts_amount_bounded
    CHECK (amount_minor BETWEEN 0 AND 1000000000),
  CONSTRAINT payment_checkouts_currency_shape
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_checkouts_revision_shape
    CHECK (quote_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT payment_checkouts_quote_object
    CHECK (jsonb_typeof(quote_json) = 'object'),
  CONSTRAINT payment_checkouts_state
    CHECK (state IN ('created', 'open', 'paid', 'failed', 'expired', 'rejected')),
  CONSTRAINT payment_checkouts_failure_length
    CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 64),
  CONSTRAINT payment_checkouts_paid_time
    CHECK ((state = 'paid' AND paid_at IS NOT NULL) OR state <> 'paid')
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_checkouts_provider_session_uq
  ON payment_checkouts (provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_checkouts_request_idx
  ON payment_checkouts (organization_id, property_id, request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_provider_events (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_session_id TEXT,
  payload_hash TEXT NOT NULL,
  processing_status TEXT NOT NULL,
  rejection_code TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  CONSTRAINT payment_provider_events_pkey PRIMARY KEY (provider, provider_event_id),
  CONSTRAINT payment_provider_events_provider_shape
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT payment_provider_events_event_id_length
    CHECK (char_length(provider_event_id) BETWEEN 1 AND 255),
  CONSTRAINT payment_provider_events_account_length
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 128),
  CONSTRAINT payment_provider_events_type
    CHECK (event_type IN ('succeeded', 'failed', 'expired')),
  CONSTRAINT payment_provider_events_session_length
    CHECK (provider_session_id IS NULL OR char_length(provider_session_id) BETWEEN 1 AND 255),
  CONSTRAINT payment_provider_events_hash_shape
    CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT payment_provider_events_status
    CHECK (processing_status IN ('processed', 'duplicate', 'ignored', 'rejected')),
  CONSTRAINT payment_provider_events_rejection_length
    CHECK (rejection_code IS NULL OR char_length(rejection_code) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS payment_provider_events_session_idx
  ON payment_provider_events (provider, provider_account_id, provider_session_id, received_at);
